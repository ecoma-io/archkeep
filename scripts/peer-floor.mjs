// The lowest major version a peer range permits, or `null` when the range
// names no floor at all (`*`, `latest`). Lives beside verify-package.mjs,
// whose Nx-floor lane derives the minimum supported `nx` major from the
// manifest's own claim instead of holding a copy of it.
//
// Re-derive, never copy: the floor lane follows the manifest's claim; a
// parser holding its own version of the claim would agree with it only
// until one of them moved.
//
// Reads the `>=` comparators first — `>=21` and `>=21.4.2` both floor at 21,
// — then falls back to caret/tilde shapes. Deliberately non-exhaustive: it
// reads the shapes this manifest actually uses and returns `null` for
// anything else, so the lane reports the gap loudly instead of guessing a
// floor the manifest does not state.

/**
 * @param {string} range a semver range as written in `peerDependencies`
 * @returns {number | null} the lowest permitted major, or null if unbounded
 */
export function parsePeerFloorMajor(range) {
  const ge = [...range.matchAll(/>=\s*(\d+)/g)].map((m) => Number(m[1]));
  if (ge.length > 0) return Math.max(...ge);
  const bounded = /^[^*\d]*\s*(\d+)/.exec(range.trim());
  if (bounded) return Number(bounded[1]);
  return null;
}
