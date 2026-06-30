#!/usr/bin/env bash
# Build the Rubik's Cube solver HTTP server (no OpenCV needed).
# Run from the project root:  bash Server/build.sh
set -e
cd "$(dirname "$0")/.."

CXX="${CXX:-clang++}"
echo "Building solver server with $CXX ..."
$CXX -std=c++17 -O2 -I. -pthread \
  Server/SolverServer.cpp \
  Model/RubiksCube.cpp \
  PatternDatabases/CornerPatternDatabase.cpp \
  PatternDatabases/PatternDatabase.cpp \
  PatternDatabases/NibbleArray.cpp \
  PatternDatabases/math.cpp \
  -o rubiks_server

echo "Built ./rubiks_server"
echo "Run it with:  ./rubiks_server 8080"
