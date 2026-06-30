# OptiCube

> Four algorithms. Zero server. Runs entirely in your browser via WebAssembly.

**[Live Demo →](https://rubiks-cube-solver-chi.vercel.app)**

A 3-D Rubik's Cube solver that compiles a C++17 solver engine to WebAssembly via Emscripten, ships it inside a Web Worker, and renders an interactive cube in Three.js — all as a static site with no backend.

---

## Algorithms

| Algorithm | Strategy | Max depth | Memory | Notes |
|-----------|----------|-----------|--------|-------|
| **DFS** | Depth-limited depth-first search | 8 moves | O(d) | Move pruning cuts branching factor 18 → ~13 |
| **BFS** | Breadth-first search | 4 moves | O(18^d) | Optimal; limited by memory growth |
| **IDDFS** | Iterative-deepening DFS | 8 moves | O(d) | Optimal + memory-lean; practical default |
| **IDA\*** | A* with corner pattern DB heuristic | 20 moves | O(d) | Solves most scrambles in < 1 s |

---

## How it works

### Overall architecture

```
Browser — main thread
├── Three.js          3D cube render + animated face rotations
├── app.js            Shuffle / solve / undo / playback UI
└── api.js            Sends scramble to Worker, receives solution moves

Browser — Web Worker (isolated)
├── solver-worker.js  Message router
└── solver.mjs        Emscripten JS glue
    └── solver.wasm   C++ algorithms compiled to WebAssembly
```

The Worker isolates the solver from the main thread. If a memory-heavy BFS search exhausts the WASM heap and crashes, the Worker restarts automatically — the UI stays responsive and other algorithms keep working.

---

### IDA* database pipeline

IDA* needs a 48 MB corner pattern database as its heuristic. It's too large to bundle into the WASM binary, so it streams in on first use and gets cached:

```
First IDA* click
  main thread → check IndexedDB cache
    miss → fetch /Databases/cornerDepth5V1.bin  (48 MB, streamed with progress)
          → save clone to IndexedDB             (persists across reloads)
          → zero-copy ArrayBuffer transfer to Worker
  Worker → Module.FS.writeFile("/db/cornerDepth5V1.bin", data)
         → notifyDbLoaded()  →  g_dbLoaded = true in C++
         → C++ reads it via  ifstream  as a normal file

Subsequent visits
  main thread → IndexedDB hit → transfer directly (no network)
```

---

### Algorithm deep-dives

**DFS** — Explores one path to the depth limit, then backtracks. O(depth) memory. `MovePruning.h` prunes same-face repeats and commuting-face sequences, reducing the effective branching factor from 18 to ~13.

**BFS** — Explores all states at distance *d* before *d+1*, guaranteeing the shortest solution. The visited map (`unordered_map<RubiksCubeBitboard, MOVE, HashBitboard>`) grows as O(18^d), limiting practical use to shallow scrambles.

**IDDFS** — Runs DFS at depth 1, 2, 3, … until a solution is found. Optimal like BFS, lean like DFS. The default choice for scrambles up to 8 moves.

**IDA\*** — Iterative-deepening A* using an admissible lower-bound heuristic from the corner pattern database. The DB stores the minimum number of moves to solve all 8 corners for every possible corner configuration — 100,179,840 entries packed 4 bits per entry into 50 MB via `NibbleArray`. The heuristic prunes the search tree so aggressively that most 13-move scrambles solve in under a second, and 20-move solves in a few seconds.

---

## Project structure

```
rubiks-cube-solver/
│
├── Model/                       Cube representations
│   ├── RubiksCube.h/cpp         Abstract base — move enum, getMove(), isSolved()
│   ├── RubiksCube3dArray        6×3×3 color array (readable, slow)
│   ├── RubiksCube1dArray        54-element array (compact)
│   └── RubiksCubeBitboard       6 × uint64 packed encoding (fast hashing)
│
├── Solver/                      Algorithm templates (header-only)
│   ├── DFSSolver.h
│   ├── BFSSolver.h
│   ├── IDDFSSolver.h
│   ├── IDAstarSolver.h
│   └── MovePruning.h            Prunes redundant move sequences
│
├── PatternDatabases/            IDA* heuristic infrastructure
│   ├── CornerPatternDatabase    8-corner permutation + orientation → min-moves
│   ├── NibbleArray              4-bit packed array (50 MB for 100M entries)
│   ├── PermutationIndexer       Lehmer code → flat array index
│   ├── CornerDBMaker            BFS to generate the database file
│   └── math.cpp/h               Factorial / combinatoric helpers
│
├── wasm/
│   ├── SolverWasm.cpp           Emscripten bridge — JSON in, JSON out, FS helpers
│   └── build.sh                 One-command WASM build (emcc flags, DB copy)
│
├── Server/                      Optional native HTTP server
│   ├── SolverServer.cpp         REST endpoint /solve using cpp-httplib
│   └── lib/                     httplib.h, nlohmann/json.hpp
│
├── frontend/                    Static site (Vercel output directory)
│   ├── index.html
│   ├── app.js                   Three.js cube, animation engine, UI wiring
│   ├── api.js                   Worker lifecycle, IndexedDB cache, solve bridge
│   ├── solver-worker.js         Web Worker — hosts WASM, routes messages
│   ├── styles.css
│   ├── solver.mjs               ← generated by build.sh, do not edit
│   ├── solver.wasm              ← generated by build.sh, do not edit
│   └── Databases/
│       └── cornerDepth5V1.bin   48 MB pattern DB (gitignored, built locally)
│
├── CMakeLists.txt               Native CLI build
├── main.cpp                     CLI test runner
└── vercel.json                  Deploy config + MIME type headers
```

---

## Setup

### Prerequisites

| Tool | Install | Purpose |
|------|---------|---------|
| C++17 compiler + CMake ≥ 3.14 | system package manager | Native CLI build |
| Emscripten 6.x | `brew install emscripten` | C++ → WASM |
| Node.js | [nodejs.org](https://nodejs.org) | Local dev server |

---

### Option A — Run the CLI solver

No browser, no WASM. Tests algorithms directly.

```bash
cmake -B build
cmake --build build
./build/rubiks_solver
# Shuffles 7 moves, solves with IDDFS, prints solution + time
```

To switch algorithm, edit `main.cpp` and uncomment the desired solver block.

---

### Option B — Build WASM and run in browser

```bash
# 1. Compile C++ → WebAssembly  (takes ~30 s)
bash wasm/build.sh
#   Writes:  frontend/solver.mjs
#            frontend/solver.wasm
#   Copies:  Databases/cornerDepth5V1.txt
#         →  frontend/Databases/cornerDepth5V1.bin

# 2. Serve with correct MIME types
npx serve frontend -l 8080

# 3. Open
open http://localhost:8080
```

> `.wasm` files must be served with `Content-Type: application/wasm` — `npx serve` handles this automatically. Opening `index.html` directly as a `file://` URL will not work.

---

### Option C — Deploy to Vercel

```bash
npm i -g vercel

# Build WASM first (see Option B step 1)
bash wasm/build.sh

vercel --prod
```

`vercel.json` configures:
- `application/wasm` MIME type for `.wasm`
- `application/octet-stream` + 1-year immutable cache for the pattern DB
- `frontend/` as the output directory

---

### Regenerating the corner pattern database

The pre-built database (`Databases/cornerDepth5V1.txt`) covers all corner configurations up to depth 9. To rebuild it from scratch:

```cpp
// Uncomment in main.cpp:
CornerDBMaker dbMaker("Databases/cornerDepth5V1.txt", 0x99);
dbMaker.bfsAndStore();
// Takes several minutes; outputs ~50 MB
```

---

## WASM build flags

Key flags in `wasm/build.sh`:

| Flag | Reason |
|------|--------|
| `-O2` | Optimise without extreme compile times |
| `--bind` | Emscripten Embind — exposes C++ functions to JS |
| `MODULARIZE=1` + `EXPORT_ES6=1` | ES6 module, importable in a Worker |
| `ALLOW_MEMORY_GROWTH=1` | Heap can expand (BFS needs ~500 MB at depth 6) |
| `INITIAL_MEMORY=64MB` | Avoids expensive early growth |
| `ENVIRONMENT=web,worker` | Enables loading in both main thread and Worker |
| `EXPORTED_RUNTIME_METHODS=["FS"]` | Exposes `Module.FS` so JS can write the DB to MEMFS |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Solver engine | C++17 |
| WASM compilation | Emscripten 6.0 |
| 3D rendering | Three.js r170 + OrbitControls |
| Worker messaging | Structured clone + Transferable `ArrayBuffer` |
| DB persistence | IndexedDB |
| HTTP server (optional) | cpp-httplib + nlohmann/json |
| Hosting | Vercel (static) |

---

## Usage

1. **Shuffle** — pick a depth (1–13 for IDA*, 1–8 for DFS/IDDFS, 1–4 for BFS) and click SHUFFLE
2. **Select algorithm** — choose from the dropdown
3. **Solve** — click SOLVE; the solution animates move by move
4. **Playback controls** — PAUSE / RESUME and STEP through the solution one move at a time
5. **Speed** — drag the speed slider to control animation duration (50–800 ms/move)
6. **Undo** — undo individual moves with the UNDO button or `Backspace`
7. **Manual moves** — press `U D L R F B` (hold Shift for prime moves, e.g. Shift+U = U')
8. **Reset** — RESET rebuilds the cube to the solved state
