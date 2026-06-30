// ─────────────────────────────────────────────────────────
//  api.js — solver bridge: WebAssembly Worker (primary) → HTTP (fallback)
//
//  The C++ solver runs in a dedicated Web Worker so:
//   • The main thread stays responsive during heavy BFS/DFS searches.
//   • A WASM crash (e.g. BFS OOM) is isolated; the worker auto-restarts.
//
//  IDA* pattern database (48 MB):
//   • Fetched lazily the first time IDA* is used.
//   • Cached in IndexedDB so subsequent page loads skip the download.
//   • Streamed with progress callbacks while downloading.
//
//  HTTP fallback (localhost:8080):
//   • Used only when solver.mjs is absent (no WASM build present).
// ─────────────────────────────────────────────────────────

const DB_URL     = "Databases/cornerDepth5V1.bin";
const DB_IDB_KEY = "rubiks-corner-db-v1";
const WORKER_URL = new URL("./solver-worker.js", import.meta.url);

export class SolverAPI {
  constructor(base = "http://localhost:8080") {
    this.base      = base;
    this.live      = false;
    this.wasmReady = false;
    this.httpReady = false;
    this.dbLoaded  = false;
    this.dbLoading = false;

    this._worker   = null;
    this._pending  = new Map();   // id → {resolve, reject}
    this._nextId   = 1;
    this._statusCb      = () => {};
    this._dbProgressCb  = () => {};

    this._startWorker();
  }

  onStatus(cb)     { this._statusCb = cb;     return this; }
  onDbProgress(cb) { this._dbProgressCb = cb; return this; }

  // ── Worker lifecycle ─────────────────────────────────────
  _startWorker() {
    let w;
    try {
      w = new Worker(WORKER_URL, { type: "module" });
    } catch (_) {
      this._pollHttp();
      return;
    }
    this._worker = w;

    w.onmessage = (e) => this._onMsg(e.data);
    w.onerror   = (e) => {
      console.warn("solver-worker crashed:", e.message);
      this._rejectAll("WASM solver crashed — will restart. Try again in a moment.");
      w.terminate();
      if (this._worker === w) {
        this._worker   = null;
        this.wasmReady = false;
        this.dbLoaded  = false;
        this.live      = this.httpReady;
        this._statusCb(this.httpReady ? "http" : "restarting");
        setTimeout(() => this._startWorker(), 1200);
      }
    };
  }

  _onMsg(msg) {
    const { id, type, payload } = msg;

    if (type === "ready") {
      this.wasmReady = true;
      this.live      = true;
      this.dbLoaded  = false;      // new worker needs DB re-sent if it was loaded
      this._statusCb("wasm");
      return;
    }

    // Worker-level init failure (no id) — fall back to HTTP
    if (type === "error" && id == null) {
      console.warn("WASM init failed:", payload);
      this._pollHttp();
      return;
    }

    const cb = this._pending.get(id);
    if (!cb) return;
    this._pending.delete(id);

    if (type === "result" || type === "dbReady") cb.resolve(payload);
    else cb.reject(new Error(payload ?? "worker error"));
  }

  _rejectAll(reason) {
    for (const { reject } of this._pending.values()) reject(new Error(reason));
    this._pending.clear();
  }

  _send(type, payload) {
    return new Promise((resolve, reject) => {
      if (!this._worker) {
        reject(new Error("solver is restarting — please try again in a moment"));
        return;
      }
      const id  = this._nextId++;
      this._pending.set(id, { resolve, reject });
      const msg = { id, type, payload };
      payload instanceof ArrayBuffer
        ? this._worker.postMessage(msg, [payload])
        : this._worker.postMessage(msg);
    });
  }

  // ── IDA* database (lazy, cached in IndexedDB) ──────────
  async _ensureDb() {
    if (this.dbLoaded)  return;
    if (this.dbLoading) {
      await new Promise((resolve, reject) => {
        const t = setInterval(() => {
          if (this.dbLoaded)   { clearInterval(t); resolve(); }
          else if (!this.dbLoading) { clearInterval(t); reject(new Error("database load failed — please try again")); }
        }, 200);
      });
      return;
    }
    this.dbLoading = true;
    this._dbProgressCb({ phase: "start" });
    try {
      // Load from IDB cache or network
      let buffer = await this._loadDbFromIdb();
      if (!buffer) {
        buffer = await this._fetchDb();
        // Clone before transferring — IDB keeps the clone, worker gets the original
        await this._saveDbToIdb(buffer.slice(0));
      }

      // Zero-copy transfer to worker (neuters `buffer` on main thread)
      await this._send("loadDb", buffer);

      this.dbLoaded = true;
      this._dbProgressCb({ phase: "ready" });
    } finally {
      this.dbLoading = false;
    }
  }

  async _fetchDb() {
    const res = await fetch(DB_URL);
    if (!res.ok) throw new Error(`Failed to fetch DB (${res.status})`);
    const total  = +res.headers.get("Content-Length") || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) this._dbProgressCb({ phase: "fetch", received, total });
    }
    const arr = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { arr.set(c, off); off += c.length; }
    return arr.buffer;
  }

  async _loadDbFromIdb() {
    try {
      return await new Promise((res, rej) => {
        const req = indexedDB.open("rubiks-solver", 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore("db");
        req.onsuccess = e => {
          const get = e.target.result.transaction("db", "readonly")
                                     .objectStore("db").get(DB_IDB_KEY);
          get.onsuccess = () => res(get.result || null);
          get.onerror   = () => rej(get.error);
        };
        req.onerror = () => rej(req.error);
      });
    } catch { return null; }
  }

  async _saveDbToIdb(buffer) {
    try {
      await new Promise((res, rej) => {
        const req = indexedDB.open("rubiks-solver", 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore("db");
        req.onsuccess = e => {
          const put = e.target.result.transaction("db", "readwrite")
                                     .objectStore("db").put(buffer, DB_IDB_KEY);
          put.onsuccess = () => res();
          put.onerror   = () => rej(put.error);
        };
        req.onerror = () => rej(req.error);
      });
    } catch { /* non-fatal */ }
  }

  // ── HTTP fallback ─────────────────────────────────────
  _pollHttp() {
    this.checkHealth();
    setInterval(() => { if (!this.wasmReady) this.checkHealth(); }, 5000);
  }

  async checkHealth() {
    if (this.wasmReady) return true;
    this._statusCb("connecting");
    try {
      const res = await fetch(this.base + "/health", { method: "GET" });
      this.httpReady = res.ok;
    } catch {
      this.httpReady = false;
    }
    this.live = this.httpReady;
    this._statusCb(this.httpReady ? "http" : "down");
    return this.httpReady;
  }

  // ── Public solve ────────────────────────────────────────
  async solve(solver, scramble) {
    if (this.wasmReady)  return this._solveWorker(solver, scramble);
    if (this.httpReady)  return this._solveHttp(solver, scramble);
    if (this._worker)    throw new Error("solver is initializing — please wait a moment");
    throw new Error("no solver backend available");
  }

  async _solveWorker(solver, scramble) {
    if (solver === "IDA") await this._ensureDb();
    const raw  = await this._send("solve", JSON.stringify({ solver, scramble }));
    const data = JSON.parse(raw);
    if (data.error) throw new Error(data.error);
    return data;
  }

  async _solveHttp(solver, scramble) {
    let res;
    try {
      res = await fetch(this.base + "/solve", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ solver, scramble }),
      });
    } catch {
      this.httpReady = false;
      this.live      = false;
      this._statusCb("down");
      throw new Error("backend unreachable");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `solver error (${res.status})`);
    return data;
  }
}
