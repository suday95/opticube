// ─────────────────────────────────────────────────────────
//  SolverServer.cpp — HTTP bridge to the C++ Rubik's solvers
//
//  Endpoints:
//    GET  /health             -> { ok:true }
//    POST /solve  { solver:"IDDFS"|"DFS"|"BFS"|"IDA", scramble:["R","U2",...] }
//         200 -> { moves:[...], time_ms, depth }
//         400 -> { error:"..." }   (e.g. scramble too deep for that solver)
//
//  The frontend sends the SCRAMBLE applied from a solved cube;
//  we replay it onto a fresh cube and run the chosen algorithm.
//  Timing uses std::chrono around solve() only — the real compute cost.
// ─────────────────────────────────────────────────────────
#include <bits/stdc++.h>
#include <chrono>

#include "lib/httplib.h"
#include "lib/json.hpp"

#include "../Model/RubiksCubeBitboard.cpp"
#include "../Solver/DFSSolver.h"
#include "../Solver/BFSSolver.h"
#include "../Solver/IDDFSSolver.h"
#include "../Solver/IDAstarSolver.h"

using json = nlohmann::json;
using namespace std;

// ── move string <-> enum ──────────────────────────────────
static const vector<string> MOVE_STR = {
    "L","L'","L2","R","R'","R2","U","U'","U2",
    "D","D'","D2","F","F'","F2","B","B'","B2",
};
static unordered_map<string, int> buildMoveMap() {
    unordered_map<string, int> m;
    for (int i = 0; i < (int)MOVE_STR.size(); i++) m[MOVE_STR[i]] = i;
    return m;
}
static const unordered_map<string, int> MOVE_MAP = buildMoveMap();

// per-solver guards: max scramble depth we'll accept (#3)
static const int DFS_MAX   = 8;
static const int BFS_MAX   = 7;
static const int IDDFS_MAX = 8;
static const int IDA_MAX   = 20;

static string g_dbFile;   // path to corner pattern database (for IDA*)

// add permissive CORS so the browser frontend can call us
static void cors(httplib::Response &res) {
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type");
}
static void fail(httplib::Response &res, int code, const string &msg) {
    cors(res);
    res.status = code;
    res.set_content(json({{"error", msg}}).dump(), "application/json");
}

int main(int argc, char **argv) {
    int port = (argc > 1) ? atoi(argv[1]) : 8080;
    const char *envDb = getenv("RUBIKS_DB");
    g_dbFile = envDb ? string(envDb) : string("Databases/cornerDepth5V1.txt");

    httplib::Server svr;

    // CORS preflight
    svr.Options(R"(/.*)", [](const httplib::Request &, httplib::Response &res) {
        cors(res);
        res.status = 204;
    });

    svr.Get("/health", [](const httplib::Request &, httplib::Response &res) {
        cors(res);
        res.set_content(json({{"ok", true}}).dump(), "application/json");
    });

    svr.Post("/solve", [](const httplib::Request &req, httplib::Response &res) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) { return fail(res, 400, "invalid JSON body"); }

        string solver = body.value("solver", "IDDFS");
        vector<string> scramble;
        if (body.contains("scramble") && body["scramble"].is_array())
            for (auto &m : body["scramble"]) scramble.push_back(m.get<string>());

        // validate moves
        for (auto &m : scramble)
            if (!MOVE_MAP.count(m)) return fail(res, 400, "unknown move: " + m);

        // build the scrambled cube
        RubiksCubeBitboard cube;
        for (auto &m : scramble) cube.move(RubiksCube::MOVE(MOVE_MAP.at(m)));

        // already solved → trivial
        if (cube.isSolved()) {
            cors(res);
            res.set_content(json({{"moves", json::array()}, {"time_ms", 0.0}, {"depth", 0}}).dump(),
                            "application/json");
            return;
        }

        int depth = (int)scramble.size();
        vector<RubiksCube::MOVE> sol;
        bool solved = false;

        auto t0 = chrono::high_resolution_clock::now();
        try {
            if (solver == "DFS") {
                if (depth > DFS_MAX) return fail(res, 400, "scramble depth " + to_string(depth) +
                                                 " exceeds DFS limit " + to_string(DFS_MAX));
                DFSSolver<RubiksCubeBitboard, HashBitboard> s(cube, depth);
                sol = s.solve();
                solved = s.rubiksCube.isSolved();
            } else if (solver == "BFS") {
                if (depth > BFS_MAX) return fail(res, 400, "scramble depth " + to_string(depth) +
                                                 " exceeds BFS limit " + to_string(BFS_MAX));
                BFSSolver<RubiksCubeBitboard, HashBitboard> s(cube);
                sol = s.solve();
                solved = s.rubiksCube.isSolved();
            } else if (solver == "IDDFS") {
                if (depth > IDDFS_MAX) return fail(res, 400, "scramble depth " + to_string(depth) +
                                                   " exceeds IDDFS limit " + to_string(IDDFS_MAX));
                IDDFSSolver<RubiksCubeBitboard, HashBitboard> s(cube, depth);
                sol = s.solve();
                solved = s.rubiksCube.isSolved();
            } else if (solver == "IDA") {
                if (depth > IDA_MAX) return fail(res, 400, "scramble depth " + to_string(depth) +
                                                 " exceeds IDA* limit " + to_string(IDA_MAX));
                ifstream f(g_dbFile);
                if (!f.good()) return fail(res, 500, "pattern database not found: " + g_dbFile);
                IDAstarSolver<RubiksCubeBitboard, HashBitboard> s(cube, g_dbFile);
                sol = s.solve();
                solved = s.rubiksCube.isSolved();
            } else {
                return fail(res, 400, "unknown solver: " + solver);
            }
        } catch (const exception &e) {
            return fail(res, 500, string("solver crashed: ") + e.what());
        }
        auto t1 = chrono::high_resolution_clock::now();
        double ms = chrono::duration<double, milli>(t1 - t0).count();

        if (!solved) return fail(res, 422, "solver could not solve within limits");

        json moves = json::array();
        for (auto mv : sol) moves.push_back(RubiksCube::getMove(mv));

        cors(res);
        res.set_content(json({{"moves", moves},
                              {"time_ms", ms},
                              {"depth", (int)sol.size()}}).dump(),
                        "application/json");
    });

    cout << "Rubik's solver server listening on http://0.0.0.0:" << port << "\n";
    cout << "  corner DB (IDA*): " << g_dbFile << "\n";
    svr.listen("0.0.0.0", port);
    return 0;
}
