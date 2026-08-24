/**
 * The envelope's field roster, as something a test can compare.
 *
 * `../../../../docs/reference/json-output.md` promises that every field name
 * in it, and `schemaVersion` itself, are a public contract: no field is
 * renamed, no field changes type, and a capability that does not fit the
 * current shape ships as a new field rather than as a change to an existing
 * one. Until this module existed, nothing in the tree went red when a field
 * was renamed or dropped — the promise was prose, and `./json.mjs` enforces
 * only the three consistency rules between `status`, `exitCode`, `coverage`
 * and `decision`, never the roster itself.
 *
 * This module is the half that can be measured. It turns an envelope into a
 * flat, sorted list of `path: type` entries, and `../../e2e/envelope-shape.e2e.mjs`
 * compares that list — for every command the CLI declares — against the
 * snapshot committed beside it.
 *
 * ## What the roster is, and what it is NOT
 *
 * It is a MEASURED shape, in the sense `scripts/differential-real-trees.mjs`
 * uses for `expectViolations`: the answer a real run gives today, written
 * down so that a change to it has to be made on purpose. It is not a second
 * copy of the documentation's field tables, and it must not be maintained as
 * one — a hand-written roster would be exactly the second statement of a rule
 * `../../../../AGENTS.md` refuses, drifting from both the docs and the code.
 * The snapshot is regenerated from a run and reviewed as a diff; the diff IS
 * the review question ("is this rename allowed by the promise?").
 *
 * ## Why every node carries an entry, containers included
 *
 * A roster of leaves alone cannot see an emptied object: drop every key of
 * `workspace` and the leaf list simply loses four rows, which reads the same
 * as four fields having been renamed elsewhere. So each node emits its own
 * `path: type` — `workspace: object` survives its children — and the type
 * vocabulary keeps `null` apart from `object`, because `result.goWork` being
 * `null` on a tree with no `go.work` and being an object on a tree with one
 * is precisely the difference a consumer branches on.
 *
 * ## Arrays collapse, and that is the point
 *
 * Every element of an array folds onto one `path[]` prefix, so a roster does
 * not grow with the number of violations a fixture happens to produce — the
 * shape is what is under contract, not the count. A path that appears with
 * two types across elements (an optional field present on one row and absent
 * on another) yields both entries, which is how an optional field is
 * recorded rather than hidden.
 *
 * The root itself gets no entry: `./json.mjs` cannot return anything but an
 * object, so a row asserting it is one would be a row that can never move.
 */

/**
 * The type name a roster entry carries. Deliberately coarser than JavaScript's
 * own vocabulary in one place and finer in two: `null` is its own name rather
 * than `object`, and arrays are `array` rather than `object`, because those
 * are the two distinctions a consumer's parser actually branches on.
 *
 * @param {unknown} value
 * @returns {"null"|"array"|"object"|"string"|"number"|"boolean"}
 */
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "object" || type === "string" || type === "number" || type === "boolean") {
    return type;
  }
  // `undefined`, a function, a symbol, a bigint: none can survive
  // `JSON.stringify`, so a value of that type in an envelope is a bug in the
  // command that built it rather than a shape to record. Naming it is the
  // loud direction — recording it as some neighbouring type would put a row
  // in the roster describing a field no consumer will ever receive.
  throw new Error(
    `archkeep: refusing to build an envelope roster over a ${type} — an envelope holds only ` +
      `JSON values, so a ${type} in it is a bug in the command that built the envelope.`,
  );
}

/**
 * Every node of `envelope`, as sorted `"<path>: <type>"` entries.
 *
 * Paths are dotted, with `[]` marking a step through an array: a violation's
 * message id is `result.violations[].messageId`. Duplicate entries — the same
 * path with the same type on many array elements — collapse to one.
 *
 * @param {object} envelope The envelope `./json.mjs` built.
 * @returns {string[]} Sorted, unique `path: type` entries.
 * @throws {Error} when the envelope is not an object, or holds a value no
 *   JSON document can carry.
 */
export function envelopeFieldPaths(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(
      `archkeep: refusing to build an envelope roster over ${envelope === null ? "null" : `a ${Array.isArray(envelope) ? "array" : typeof envelope}`} ` +
        `— an envelope is the object ./json.mjs returns.`,
    );
  }
  /** @type {Map<string, Set<string>>} */
  const byPath = new Map();
  walk(envelope, "", byPath);
  // Sorted by path first and type second, rather than by the rendered string:
  // `"tool.name: string"` sorts BEFORE `"tool: object"` under a plain string
  // sort (`.` is below `:`), which would print every child above its own
  // parent and make the snapshot's diffs harder to read than they need to be.
  return [...byPath.keys()]
    .sort()
    .flatMap((path) => [...(byPath.get(path) ?? [])].sort().map((type) => `${path}: ${type}`));
}

/**
 * Records `value` at `path` and descends. `path` is `""` only for the root,
 * whose own entry is deliberately not recorded (see this module's header).
 *
 * @param {unknown} value
 * @param {string} path
 * @param {Map<string, Set<string>>} byPath
 */
function walk(value, path, byPath) {
  if (path !== "") {
    const types = byPath.get(path) ?? new Set();
    types.add(typeName(value));
    byPath.set(path, types);
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    for (const element of value) walk(element, `${path}[]`, byPath);
    return;
  }
  if (typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    walk(
      /** @type {Record<string, unknown>} */ (value)[key],
      path === "" ? key : `${path}.${key}`,
      byPath,
    );
  }
}

/**
 * The two directions a roster can move, named separately because they are not
 * the same review question.
 *
 * `added` is the additive direction the promise allows — a new field, which
 * still has to be recorded so that "additive" is a claim someone made rather
 * than a diff nobody read. `removed` is the direction the promise forbids: a
 * field that was in the roster and is not in the run either was renamed,
 * dropped, or changed type, and every one of those breaks a consumer that
 * parses this output today.
 *
 * @param {string[]} recorded The snapshot's entries for this command.
 * @param {string[]} observed `envelopeFieldPaths` over a real run.
 * @returns {{added: string[], removed: string[]}}
 */
export function compareFieldPaths(recorded, observed) {
  const recordedSet = new Set(recorded);
  const observedSet = new Set(observed);
  return {
    added: observed.filter((entry) => !recordedSet.has(entry)),
    removed: recorded.filter((entry) => !observedSet.has(entry)),
  };
}
