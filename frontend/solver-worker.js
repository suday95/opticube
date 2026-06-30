// ─────────────────────────────────────────────────────────
//  solver-worker.js — runs the C++ WASM solver off the main thread.
//
//  Messages IN  (from main):
//    { id, type:"solve",   payload: jsonString }
//    { id, type:"loadDb",  payload: ArrayBuffer }
//
//  Messages OUT (to main):
//    { id, type:"ready" }
//    { id, type:"result",  payload: jsonString }
//    { id, type:"error",   payload: errorString }
//    { id, type:"dbReady" }
// ─────────────────────────────────────────────────────────

let Module = null;

async function init() {
  try {
    const mod = await import("./solver.mjs");
    Module = await mod.default();
    self.postMessage({ type: "ready" });
  } catch (e) {
    self.postMessage({ type: "error", payload: String(e) });
  }
}

self.addEventListener("message", async (e) => {
  const { id, type, payload } = e.data;

  if (type === "solve") {
    if (!Module) {
      self.postMessage({ id, type: "error", payload: "WASM not ready" });
      return;
    }
    try {
      const result = Module.solve(payload);
      self.postMessage({ id, type: "result", payload: result });
    } catch (err) {
      self.postMessage({ id, type: "error", payload: String(err) });
    }
    return;
  }

  if (type === "loadDb") {
    if (!Module) {
      self.postMessage({ id, type: "error", payload: "WASM not ready" });
      return;
    }
    try {
      try { Module.FS.mkdir("/db"); } catch (_) {}
      Module.FS.writeFile("/db/cornerDepth5V1.bin", new Uint8Array(payload));
      Module.notifyDbLoaded();
      self.postMessage({ id, type: "dbReady" });
    } catch (err) {
      self.postMessage({ id, type: "error", payload: String(err) });
    }
    return;
  }
});

init();
