// Three readings of the same boundary law, differing only in what its
// `boundarySuppressions` table says about ONE violating import.
//
// The distinction is the whole point, and it is the one a unit test can fake
// but an installed binary cannot: a PERMANENT suppression removes the
// violation outright, an ACTIVE waiver keeps it (marked accepted, still exit
// 1), and an EXPIRED waiver keeps it and covers nothing. The middle and the
// last differ only by which side of the wall clock `expiresAt` falls on, so a
// run through the real binary is the only place the real clock decides.
//
// Every variant is built by extending the shared law rather than restating it
// (`./boundary-law.mjs`), the same arrangement `./determinism-sweep.mjs` uses
// and for the same reason: three copies of a constraint table drift.

import { MONOREPO_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/** Replaces the empty suppression table with `rows`. */
function withSuppressions(rows) {
  return MONOREPO_BOUNDARY_CONFIG.replace(
    "export const boundarySuppressions = [];",
    `export const boundarySuppressions = [\n${rows}\n];`,
  );
}

/** An ISO instant `days` from now — negative for the past. */
const shifted = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

/** The row's `path` glob covers the file `CORE_REACHES_APP` adds. */
const PATH = "libs/core/**";
const REASON = "core-to-app is being untangled";

/** No `expiresAt`: the violation is removed outright, forever. */
export const PERMANENT_SUPPRESSION = withSuppressions(
  `  { path: "${PATH}", reason: "${REASON}" },`,
);

/** A live term: the violation is kept, marked accepted, and still fails the run. */
export const ACTIVE_WAIVER = withSuppressions(
  `  { path: "${PATH}", reason: "${REASON}", expiresAt: "${shifted(365)}" },`,
);

/**
 * A lapsed term. Written relative to the run's own clock rather than as a
 * calendar date, so this fixture cannot become "active" or "expired" by the
 * passage of time — a fixed date would make the pair silently stop testing the
 * distinction the moment it passed.
 */
export const EXPIRED_WAIVER = withSuppressions(
  `  { path: "${PATH}", reason: "${REASON}", expiresAt: "${shifted(-1)}" },`,
);
