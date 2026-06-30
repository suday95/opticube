// ─────────────────────────────────────────────────────────
//  CUBE//SOLVER — frontend engine
//  3D cube + animated face rotations + move queue + UI.
//  Backend (C++ solver) is NOT wired yet: SOLVE currently
//  replays the inverse of the shuffle so the full animation
//  pipeline is testable standalone. See solveCube().
// ─────────────────────────────────────────────────────────
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SolverAPI } from "./api.js";

// ── Color convention (matches the C++ project) ────────────
//   UP=White DOWN=Yellow FRONT=Red BACK=Orange RIGHT=Blue LEFT=Green
const COL = {
  white:  0xf4f5f7,
  yellow: 0xffd500,
  red:    0xd11f2f,
  orange: 0xff6a00,
  green:  0x00a04a,
  blue:   0x1763d6,
  hidden: 0x0c0d11,
};

// BoxGeometry material face order: +X, -X, +Y, -Y, +Z, -Z
const FACE_COLORS = [
  COL.blue,   // +X  RIGHT
  COL.green,  // -X  LEFT
  COL.white,  // +Y  UP
  COL.yellow, // -Y  DOWN
  COL.red,    // +Z  FRONT
  COL.orange, // -Z  BACK
];

// ── Move table ────────────────────────────────────────────
// axis: which coordinate selects the layer; layer: +1/-1;
// dir: rotation sign (radians = dir * 90°). double: 180°.
const MOVES = {
  U:  { axis: "y", layer:  1, dir: -1 },
  D:  { axis: "y", layer: -1, dir:  1 },
  R:  { axis: "x", layer:  1, dir: -1 },
  L:  { axis: "x", layer: -1, dir:  1 },
  F:  { axis: "z", layer:  1, dir: -1 },
  B:  { axis: "z", layer: -1, dir:  1 },
};
// build primes + doubles
for (const k of Object.keys({ U:0, D:0, R:0, L:0, F:0, B:0 })) {
  MOVES[k + "'"] = { ...MOVES[k], dir: -MOVES[k].dir };
  MOVES[k + "2"] = { ...MOVES[k], double: true };
}
const MOVE_NAMES = ["U","U'","U2","D","D'","D2","L","L'","L2","R","R'","R2","F","F'","F2","B","B'","B2"];

function invertMove(m) {
  if (m.endsWith("2")) return m;
  if (m.endsWith("'")) return m[0];
  return m + "'";
}

// ─────────────────────────────────────────────────────────
//  Scene setup
// ─────────────────────────────────────────────────────────
const canvas = document.getElementById("cube-canvas");
const stage = canvas.parentElement;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(5.2, 4.6, 6.4);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.enablePan = false;
controls.minDistance = 6;
controls.maxDistance = 16;

// lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(6, 9, 7);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
rim.position.set(-6, -3, -5);
scene.add(rim);

// ── Build the 27 cubies ───────────────────────────────────
const cubeGroup = new THREE.Group();
scene.add(cubeGroup);

const SIZE = 0.96;          // cubie size (gap between them)
const cubies = [];
const geo = new THREE.BoxGeometry(SIZE, SIZE, SIZE);

function makeMaterials(x, y, z) {
  // paint only the exterior-facing sides; interior is "hidden"
  return [
    new THREE.MeshStandardMaterial({ color: x ===  1 ? FACE_COLORS[0] : COL.hidden, roughness: .45, metalness: .12 }),
    new THREE.MeshStandardMaterial({ color: x === -1 ? FACE_COLORS[1] : COL.hidden, roughness: .45, metalness: .12 }),
    new THREE.MeshStandardMaterial({ color: y ===  1 ? FACE_COLORS[2] : COL.hidden, roughness: .45, metalness: .12 }),
    new THREE.MeshStandardMaterial({ color: y === -1 ? FACE_COLORS[3] : COL.hidden, roughness: .45, metalness: .12 }),
    new THREE.MeshStandardMaterial({ color: z ===  1 ? FACE_COLORS[4] : COL.hidden, roughness: .45, metalness: .12 }),
    new THREE.MeshStandardMaterial({ color: z === -1 ? FACE_COLORS[5] : COL.hidden, roughness: .45, metalness: .12 }),
  ];
}

function buildCube() {
  for (const c of cubies) cubeGroup.remove(c);
  cubies.length = 0;
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue; // skip invisible core
        const mesh = new THREE.Mesh(geo, makeMaterials(x, y, z));
        mesh.position.set(x, y, z);
        cubies.push(mesh);
        cubeGroup.add(mesh);
      }
}
buildCube();

// ─────────────────────────────────────────────────────────
//  Animated move engine
// ─────────────────────────────────────────────────────────
let animDuration = 400;     // ms, driven by speed slider
let paused = false;
const pivot = new THREE.Group();
scene.add(pivot);

function applyMoveAnimated(name) {
  return new Promise((resolve) => {
    const def = MOVES[name];
    if (!def) { resolve(); return; }
    const axis = def.axis;
    const layer = def.layer;
    const total = (def.double ? Math.PI : Math.PI / 2) * (def.dir || 1);

    // gather the 9 cubies in this layer
    pivot.rotation.set(0, 0, 0);
    pivot.updateMatrixWorld(true);
    const selected = cubies.filter(c => Math.round(c.position[axis]) === layer);
    for (const c of selected) pivot.attach(c);

    const t0 = performance.now();
    let lastUnpaused = t0;
    let elapsed = 0;

    function tick(now) {
      if (paused) { lastUnpaused = now; requestAnimationFrame(tick); return; }
      elapsed += now - lastUnpaused;
      lastUnpaused = now;
      const t = Math.min(elapsed / animDuration, 1);
      const eased = t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; // easeInOutQuad
      pivot.rotation[axis] = total * eased;

      if (t < 1) { requestAnimationFrame(tick); }
      else {
        pivot.rotation[axis] = total;
        pivot.updateMatrixWorld(true);
        // bake transform back onto each cubie & snap to grid
        for (const c of selected) {
          cubeGroup.attach(c);
          c.position.x = Math.round(c.position.x);
          c.position.y = Math.round(c.position.y);
          c.position.z = Math.round(c.position.z);
        }
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

// ── Move queue ────────────────────────────────────────────
let queue = [];
let queueRunning = false;
let stepMode = false;
let stepResolver = null;

async function runQueue(moves, { onStep } = {}) {
  queue = moves.slice();
  queueRunning = true;
  let i = 0;
  for (; i < queue.length; i++) {
    if (stepMode) await new Promise(r => (stepResolver = r));
    if (onStep) onStep(i);
    await applyMoveAnimated(queue[i]);
  }
  queueRunning = false;
  stepResolver = null;
  return i;
}

// ─────────────────────────────────────────────────────────
//  State + UI
// ─────────────────────────────────────────────────────────
let shuffleSeq = [];      // last shuffle (for fallback solve)
let moveHistory = [];     // ALL moves applied since solved (sent to backend)
let solved = true;
let _solving = false;     // guard against concurrent solveCube calls

// ── Backend / WASM API ───────────────────────────────────
const connDot  = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");

const STATUS_LABEL = {
  connecting:  "connecting to solver…",
  wasm:        "WASM solver ready · in-browser",
  http:        "backend connected · live",
  restarting:  "WASM restarting after crash — try again in a moment",
  down:        "frontend preview · backend offline",
};

const api = new SolverAPI("http://localhost:8080")
  .onStatus((status) => {
    connDot.classList.toggle("live", status === "wasm" || status === "http");
    connDot.classList.toggle("warn", status === "restarting");
    connText.textContent = STATUS_LABEL[status] ?? status;
  })
  .onDbProgress(({ phase, received, total }) => {
    if (phase === "start") {
      connText.textContent = "downloading IDA* database (48 MB)…";
    } else if (phase === "fetch" && total) {
      const pct = Math.round((received / total) * 100);
      connText.textContent = `downloading IDA* database … ${pct}%`;
    } else if (phase === "ready") {
      connText.textContent = STATUS_LABEL[api.wasmReady ? "wasm" : "http"];
    }
  });
// SolverAPI self-manages health polling — no manual setInterval needed here.

const $ = (id) => document.getElementById(id);
const stateVal = $("state-val");
const timeVal = $("time-val");
const moveCountEl = $("move-count");
const movesList = $("moves-list");
const stepCounter = $("step-counter");

function setState(isSolved) {
  solved = isSolved;
  stateVal.textContent = isSolved ? "SOLVED" : "SCRAMBLED";
  stateVal.className = "stat-val " + (isSolved ? "solved" : "scrambled");
}

function updateMoveCount() {
  moveCountEl.textContent = moveHistory.length;
}

// Disable controls + show a pulsing "SOLVING…" while the backend works.
function setSolving(on) {
  for (const id of ["btn-shuffle", "btn-solve", "btn-reset", "btn-undo"])
    $(id).disabled = on;
  if (on) {
    stateVal.textContent = "SOLVING…";
    stateVal.className = "stat-val solving";
  }
}

function renderMoves(moves, activeIdx = -1, doneBefore = true) {
  if (!moves.length) {
    movesList.innerHTML = '<span class="moves-empty">no moves yet — shuffle to begin</span>';
    stepCounter.textContent = "";
    return;
  }
  movesList.innerHTML = "";
  moves.forEach((m, i) => {
    const tag = document.createElement("span");
    tag.className = "move-tag";
    if (i === activeIdx) tag.classList.add("active");
    else if (doneBefore && i < activeIdx) tag.classList.add("done");
    tag.textContent = m;
    movesList.appendChild(tag);
  });
  if (activeIdx >= 0) stepCounter.textContent = `${activeIdx + 1} / ${moves.length}`;
  else stepCounter.textContent = `${moves.length}`;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ── Controls wiring ───────────────────────────────────────
const solverSelect = $("solver-select");
const depthRange = $("depth-range");
const depthNum = $("depth-num");
const speedRange = $("speed-range");
const speedNum = $("speed-num");

function rangeFill(el) {
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty("--fill", pct + "%");
}

solverSelect.addEventListener("change", () => {
  const opt = solverSelect.selectedOptions[0];
  const max = +opt.dataset.max;
  depthRange.max = max;
  if (+depthRange.value > max) { depthRange.value = max; depthNum.textContent = max; }
  $("solver-hint").textContent = `max shuffle depth: ${max} moves`;
  rangeFill(depthRange);
});

depthRange.addEventListener("input", () => { depthNum.textContent = depthRange.value; rangeFill(depthRange); });
speedRange.addEventListener("input", () => {
  animDuration = +speedRange.value;
  speedNum.textContent = animDuration + "ms";
  rangeFill(speedRange);
});

// SHUFFLE: random moves, no immediate repeats on same face
function makeShuffle(n) {
  const seq = [];
  let lastAxis = null;
  while (seq.length < n) {
    const m = MOVE_NAMES[Math.floor(Math.random() * MOVE_NAMES.length)];
    if (m[0] === lastAxis) continue;
    lastAxis = m[0];
    seq.push(m);
  }
  return seq;
}

$("btn-shuffle").addEventListener("click", doShuffle);
async function doShuffle() {
  if (queueRunning) return;
  const n = +depthRange.value;
  resetCube();
  shuffleSeq = makeShuffle(n);
  moveHistory = shuffleSeq.slice();
  updateMoveCount();
  timeVal.textContent = "— ms";
  renderMoves(shuffleSeq, -1);
  toast(`shuffling ${n} moves`);
  await runQueue(shuffleSeq, { onStep: (i) => renderMoves(shuffleSeq, i) });
  renderMoves(shuffleSeq, -1, false);
  setState(false);
}

$("btn-solve").addEventListener("click", solveCube);
async function solveCube() {
  if (queueRunning || _solving) return;
  if (solved) { toast("already solved — shuffle first"); return; }

  _solving = true;
  try {
    const solver = solverSelect.value;
    toast(`solving · ${solver}`);

    let solution, timeText;
    if (api.live) {
      // ── Real backend: send scramble, get the solver's own solution + exact time ──
      setSolving(true);
      try {
        const res = await api.solve(solver, moveHistory);
        solution = res.moves;
        timeText = res.time_ms.toFixed(3) + " ms";
      } catch (err) {
        setSolving(false);
        setState(false);
        toast("solve failed: " + err.message);
        return;
      }
      setSolving(false);
    } else {
      // ── Fallback (no backend): invert the move history locally ──
      solution = moveHistory.slice().reverse().map(invertMove);
      timeText = "— (preview)";
    }

    timeVal.textContent = timeText;
    renderMoves(solution, -1);
    await runQueue(solution, { onStep: (i) => renderMoves(solution, i) });
    renderMoves(solution, -1, false);
    setState(true);
    shuffleSeq = [];
    moveHistory = [];
    updateMoveCount();
    toast(`solved in ${solution.length} moves ✓`);
  } finally {
    _solving = false;
  }
}

$("btn-reset").addEventListener("click", () => {
  if (queueRunning) return;
  resetCube();
  toast("reset to solved");
});
function resetCube() {
  buildCube();
  shuffleSeq = [];
  moveHistory = [];
  updateMoveCount();
  setState(true);
  renderMoves([]);
  timeVal.textContent = "— ms";
}

// Undo: animate the inverse of the last move and drop it from history.
$("btn-undo").addEventListener("click", undoMove);
async function undoMove() {
  if (queueRunning || _solving || !moveHistory.length) return;
  queueRunning = true;
  try {
    const last = moveHistory.pop();
    shuffleSeq = moveHistory.slice();
    updateMoveCount();
    const inv = invertMove(last);
    renderMoves([inv], 0);
    await applyMoveAnimated(inv);
    setState(moveHistory.length === 0);
    renderMoves(moveHistory, -1, false);
    timeVal.textContent = "— ms";
  } finally {
    queueRunning = false;
  }
}

// playback: pause + step
$("btn-pause").addEventListener("click", (e) => {
  paused = !paused;
  e.currentTarget.classList.toggle("active", paused);
  e.currentTarget.textContent = paused ? "▶ RESUME" : "⏸ PAUSE";
});
$("btn-step").addEventListener("click", (e) => {
  stepMode = !stepMode;
  e.currentTarget.classList.toggle("active", stepMode);
  if (!stepMode && stepResolver) stepResolver();          // release if turning off
  else if (stepMode && stepResolver) stepResolver();      // advance one
});

// keyboard manual moves — ONLY the six face keys; no accidental shuffle/solve
const FACE_KEYS = new Set(["U", "D", "L", "R", "F", "B"]);
window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Backspace") { e.preventDefault(); undoMove(); return; }
  const key = e.key.toUpperCase();
  if (!FACE_KEYS.has(key)) return;
  if (queueRunning || _solving) return;
  const move = e.shiftKey ? key + "'" : key;
  moveHistory.push(move);
  shuffleSeq = moveHistory.slice();
  updateMoveCount();
  renderMoves(moveHistory, -1, false);
  applyMoveAnimated(move).then(() => {
    setState(false);
  });
});

// ─────────────────────────────────────────────────────────
//  Render loop + resize
// ─────────────────────────────────────────────────────────
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function loop() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
loop();

// init UI
rangeFill(depthRange); rangeFill(speedRange);
setState(true);
