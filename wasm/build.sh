#!/usr/bin/env bash
# Build the Rubik's Cube solver as WebAssembly.
# Run from the project root:  bash wasm/build.sh
# Output: frontend/solver.js + frontend/solver.wasm
set -e

EMCC="${EMCC:-/opt/homebrew/opt/emscripten/bin/emcc}"
if ! command -v "$EMCC" &>/dev/null; then
    echo "emcc not found. Install with: brew install emscripten"
    exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p frontend

echo "Compiling C++ → WebAssembly …"

"$EMCC" \
    -std=c++17 \
    -O2 \
    -I. \
    wasm/SolverWasm.cpp \
    Model/RubiksCube.cpp \
    PatternDatabases/CornerPatternDatabase.cpp \
    PatternDatabases/PatternDatabase.cpp \
    PatternDatabases/NibbleArray.cpp \
    PatternDatabases/math.cpp \
    --bind \
    -s WASM=1 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME="RubiksSolver" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=67108864 \
    -s ENVIRONMENT=web,worker \
    -s EXPORTED_RUNTIME_METHODS='["FS"]' \
    -o frontend/solver.mjs

echo "Done → frontend/solver.mjs + frontend/solver.wasm"

# Copy pattern database for IDA* (served as binary from the same origin)
mkdir -p frontend/Databases
cp Databases/cornerDepth5V1.txt frontend/Databases/cornerDepth5V1.bin
echo "Copied DB → frontend/Databases/cornerDepth5V1.bin"
