/**
 * The three questions every refusal in this layer asks of a value: is it a
 * plain object, is it a string with something in it, and — for the sentence
 * that refuses it — what was it actually.
 *
 * **They live here because the first two copies had already drifted.**
 * `./evidence.mjs` and `./host.mjs` each grew their own `describeValue`, and
 * by the time anyone compared them they rendered the same value two ways:
 * `string "x"` in one, `string ("x")` in the other. Neither was wrong, which
 * is exactly the problem — two refusals about the same shape read as though
 * they came from two different tools, and a reader holding a load failure
 * beside a bundle failure has no way to tell that the difference means
 * nothing. The BigInt guard is the other half of the warning: it was written
 * into both copies by hand, in one sitting, and the next fix would have landed
 * in only one of them.
 *
 * The rendering is fixed here and nowhere else: `an array of N`, `null`,
 * `undefined`, and otherwise the value's type followed by its JSON.
 */

/** @type {(value: unknown) => value is Record<string, any>} */
export const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @type {(value: unknown) => boolean} */
export const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/**
 * A value's type, for a refusal that shows what was actually there.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // A BigInt is the one value `JSON.stringify` THROWS on rather than skipping,
  // and this runs only on a refusal path — a formatter that threw would
  // replace the named reason with a TypeError about something else entirely.
  if (typeof value === "bigint") return `bigint ${value}`;
  return `${typeof value} ${JSON.stringify(value) ?? String(value)}`;
}
