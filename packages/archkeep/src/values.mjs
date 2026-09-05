/**
 * The value side of a refusal, shared by every layer that validates: the two
 * shape guards a validator refuses with, and the describer that names the
 * value a refusal is about.
 *
 * **They live at the floor of the package because every layer above needs
 * them and none of them may reach up to get them.** The one pre-existing home
 * for a shared guard was `./custom-rules/values.mjs`, but `custom-rules/`
 * sits above its own dependencies — `./custom-rules/host.mjs` imports
 * `./config.mjs` and `./governance/verdict.mjs` — so a validator in
 * `src/config.mjs` or `src/governance/` importing the guard from there would
 * point a foundational module up into a directory that depends back on it.
 * The definitions are here instead, `custom-rules/values.mjs` re-exports the
 * guard so its own importers keep their spelling, and the layer direction
 * stays one-way.
 *
 * **Two describers deliberately live elsewhere**, and this module is not the
 * place to finish the job:
 *
 * - `./commands/delta-classify.mjs` and `./commands/delta-snapshot.mjs`
 *   render a refused primitive BARELY — `typeof` alone, no JSON dump —
 *   because their refusals name shapes, not contents.
 * - `./governance/clock.mjs` omits the array branch; its only call site
 *   checks `typeof` before describing, so an array is never rendered.
 *
 * Each is pinned by its own test file, and converging any of them onto the
 * rendering below would change the sentence an unchanged workspace is told —
 * a semantic change, not a cleanup.
 */

/** @type {(value: unknown) => value is Record<string, any>} */
export const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @type {(value: unknown) => value is string[]} */
export const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Whether a value is a string a reader could actually act on — non-empty
 * after trimming. The verdict contract's reason fields (I3/I4) refuse
 * everything else: `""` and `"   "` are byte-present but semantically
 * absent, and a non-string reason would ship a `typeof` artifact where the
 * reader was promised a sentence.
 *
 * @type {(value: unknown) => value is string}
 */
export const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/**
 * A value's type, for an error message that shows what was actually there.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}
