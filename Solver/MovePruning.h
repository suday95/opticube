//
// MovePruning.h — shared move-ordering pruning for all solvers.
//
// MOVE enum layout (see RubiksCube.h): each face owns 3 consecutive
// indices, so face = move/3:
//   0:L 1:R 2:U 3:D 4:F 5:B   →  axis = face/2  (L/R, U/D, F/B)
//
// Two redundancies are removed from the search:
//   1. Same face twice in a row  (e.g. R then R')  — always combinable.
//   2. Opposite faces in both orders (e.g. R L and L R) — they commute,
//      so we keep only one canonical order (lower face index first).
//
// This drops the effective branching factor from 18 to ~13.3 without
// ever discarding an optimal solution.
//

#ifndef RUBIKS_CUBE_SOLVER_MOVEPRUNING_H
#define RUBIKS_CUBE_SOLVER_MOVEPRUNING_H

inline bool isRedundantMove(int prev, int curr) {
    if (prev < 0) return false;                  // no previous move
    int pf = prev / 3, cf = curr / 3;
    if (pf == cf) return true;                   // same face twice
    if (pf / 2 == cf / 2 && pf > cf) return true; // commuting pair, keep one order
    return false;
}

#endif //RUBIKS_CUBE_SOLVER_MOVEPRUNING_H
