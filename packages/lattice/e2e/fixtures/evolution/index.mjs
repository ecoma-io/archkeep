// Dogfooding fixtures: real graph snapshots of THIS repository, captured from
// two points on its own history — the commit that migrated the workspace from
// Nx to Moonrepo (`3a514b2`, "add Moon provider, migrate repository from Nx
// to Moonrepo") and its parent (`2b48860`).
//
// These are real bytes produced by `lattice history <dir> --capture` at each
// commit, with only the machine-local workspace header sanitised (root and the
// provenance commit hash are zeroed, because a snapshot's identity excludes
// the header and a fixture that varied `root` between machines would be
// unportable). They prove the `history` command records this repository's own
// architectural evolution: the two projects' tag sets changed, the declared
// boundary law changed, and the provider changed nx → moon — three of the
// transition's signals, all present in the captured record.
//
// A history fixture lives here so a test can drive `computeEvolution` over
// real snapshots rather than constructed ones, and so the record stays
// reviewable: `lattice history <dir>` over these two files yields the
// transition described in `docs/usage/history.md`'s dogfooding section.

/** The pre-migration snapshot: an Nx workspace. */
export const NX_SNAPSHOT = "0001-bd99dc43.json";

/** The post-migration snapshot: a Moon workspace. */
export const MOON_SNAPSHOT = "0002-16b61777.json";
