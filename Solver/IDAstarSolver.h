

#include<bits/stdc++.h>
#include "../Model/RubiksCube.h"
#include "../PatternDatabases/CornerPatternDatabase.h"
#include "MovePruning.h"

#ifndef RUBIKS_CUBE_SOLVER_IDASTARSOLVER_H
#define RUBIKS_CUBE_SOLVER_IDASTARSOLVER_H

template<typename T, typename H>
class IDAstarSolver {
private:
    CornerPatternDatabase cornerDB;
    vector<RubiksCube::MOVE> moves;

    // Returns -1 if solution found, otherwise returns minimum f that exceeded bound.
    int search(T& cube, int g, int bound, int last) {
        int h = cornerDB.getNumMoves(cube);
        int f = g + h;
        if (f > bound) return f;
        if (cube.isSolved()) return -1;

        int minExceeded = INT_MAX;
        for (int i = 0; i < 18; i++) {
            if (isRedundantMove(last, i)) continue;
            auto mv = RubiksCube::MOVE(i);
            cube.move(mv);
            moves.push_back(mv);

            int t = search(cube, g + 1, bound, i);
            if (t == -1) return -1;
            if (t < minExceeded) minExceeded = t;

            moves.pop_back();
            cube.invert(mv);
        }
        return minExceeded;
    }

public:
    T rubiksCube;

    IDAstarSolver(T _rubiksCube, string fileName) {
        rubiksCube = _rubiksCube;
        cornerDB.fromFile(fileName);
    }

    vector<RubiksCube::MOVE> solve() {
        int bound = cornerDB.getNumMoves(rubiksCube);
        while (true) {
            moves.clear();
            T workCube = rubiksCube;   // search mutates this; keep rubiksCube pristine
            int t = search(workCube, 0, bound, -1);
            if (t == -1) {
                for (auto& mv : moves) rubiksCube.move(mv);  // bring member to solved state
                return moves;
            }
            bound = t;
        }
    }
};

#endif //RUBIKS_CUBE_SOLVER_IDASTARSOLVER_H
