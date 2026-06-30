// ─────────────────────────────────────────────────────────
//  SolverWasm.cpp — Emscripten bridge to the C++ Rubik's solvers
//
//  JS interface:
//    Module.solve(jsonString) -> jsonString
//      in:  { "solver":"IDDFS"|"DFS"|"BFS"|"IDA", "scramble":["R","U2",...] }
//      out: { "moves":[...], "time_ms":1.23, "depth":5 }
//           { "error":"...", "code":"db_not_loaded"|... }
//
//    Module.notifyDbLoaded()   -- call after writing DB to MEMFS at /db/cornerDepth5V1.bin
// ─────────────────────────────────────────────────────────
#include <emscripten/bind.h>
#include <chrono>
#include <string>
#include <vector>
#include <unordered_map>
#include <fstream>

// Compiled from project root (rubiks-cube-solver/) with -I.
#include "Model/RubiksCubeBitboard.cpp"
#include "Solver/DFSSolver.h"
#include "Solver/BFSSolver.h"
#include "Solver/IDDFSSolver.h"
#include "Solver/IDAstarSolver.h"
#include "Server/lib/json.hpp"

using json = nlohmann::json;
using namespace std;
using namespace emscripten;

static const vector<string> MOVE_STR = {
    "L","L'","L2","R","R'","R2","U","U'","U2",
    "D","D'","D2","F","F'","F2","B","B'","B2",
};
static unordered_map<string,int> buildMoveMap() {
    unordered_map<string,int> m;
    for (int i = 0; i < (int)MOVE_STR.size(); i++) m[MOVE_STR[i]] = i;
    return m;
}
static const unordered_map<string,int> MOVE_MAP = buildMoveMap();

static bool   g_dbLoaded = false;
static string g_dbPath   = "/db/cornerDepth5V1.bin";

static const int DFS_MAX   = 8;
static const int BFS_MAX   = 7;
static const int IDDFS_MAX = 8;
static const int IDA_MAX   = 20;

// ── Main entry point ─────────────────────────────────────
string solve(const string& reqJson) {
    json body;
    try { body = json::parse(reqJson); }
    catch (...) { return json({{"error","invalid JSON"}}).dump(); }

    string solver = body.value("solver", "IDDFS");
    vector<string> scramble;
    if (body.contains("scramble") && body["scramble"].is_array())
        for (auto& m : body["scramble"]) scramble.push_back(m.get<string>());

    for (auto& m : scramble)
        if (!MOVE_MAP.count(m))
            return json({{"error","unknown move: " + m}}).dump();

    RubiksCubeBitboard cube;
    for (auto& m : scramble) cube.move(RubiksCube::MOVE(MOVE_MAP.at(m)));

    if (cube.isSolved())
        return json({{"moves", json::array()}, {"time_ms", 0.0}, {"depth", 0}}).dump();

    int depth = (int)scramble.size();
    vector<RubiksCube::MOVE> sol;
    bool ok = false;

    auto t0 = chrono::high_resolution_clock::now();
    try {
        if (solver == "DFS") {
            if (depth > DFS_MAX)
                return json({{"error","depth " + to_string(depth) + " exceeds DFS limit " + to_string(DFS_MAX)}}).dump();
            DFSSolver<RubiksCubeBitboard, HashBitboard> s(cube, depth);
            sol = s.solve(); ok = s.rubiksCube.isSolved();
        } else if (solver == "BFS") {
            if (depth > BFS_MAX)
                return json({{"error","depth " + to_string(depth) + " exceeds BFS limit " + to_string(BFS_MAX)}}).dump();
            BFSSolver<RubiksCubeBitboard, HashBitboard> s(cube);
            sol = s.solve(); ok = s.rubiksCube.isSolved();
        } else if (solver == "IDDFS") {
            if (depth > IDDFS_MAX)
                return json({{"error","depth " + to_string(depth) + " exceeds IDDFS limit " + to_string(IDDFS_MAX)}}).dump();
            IDDFSSolver<RubiksCubeBitboard, HashBitboard> s(cube, depth);
            sol = s.solve(); ok = s.rubiksCube.isSolved();
        } else if (solver == "IDA") {
            if (!g_dbLoaded)
                return json({{"error","IDA* database not loaded yet"}, {"code","db_not_loaded"}}).dump();
            if (depth > IDA_MAX)
                return json({{"error","depth " + to_string(depth) + " exceeds IDA* limit " + to_string(IDA_MAX)}}).dump();
            IDAstarSolver<RubiksCubeBitboard, HashBitboard> s(cube, g_dbPath);
            sol = s.solve(); ok = s.rubiksCube.isSolved();
        } else {
            return json({{"error","unknown solver: " + solver}}).dump();
        }
    } catch (const exception& e) {
        return json({{"error", string("solver crash: ") + e.what()}}).dump();
    }
    auto t1 = chrono::high_resolution_clock::now();

    if (!ok)
        return json({{"error","solver could not find solution within limits"}}).dump();

    json moves = json::array();
    for (auto mv : sol) moves.push_back(RubiksCube::getMove(mv));

    return json({
        {"moves",   moves},
        {"time_ms", chrono::duration<double, milli>(t1 - t0).count()},
        {"depth",   (int)sol.size()}
    }).dump();
}

// Call from JS after writing the DB binary to MEMFS at g_dbPath
void notifyDbLoaded() { g_dbLoaded = true; }
bool isDbLoaded()     { return g_dbLoaded; }

EMSCRIPTEN_BINDINGS(rubiks_solver) {
    emscripten::function("solve",          &solve);
    emscripten::function("notifyDbLoaded", &notifyDbLoaded);
    emscripten::function("isDbLoaded",     &isDbLoaded);
}
