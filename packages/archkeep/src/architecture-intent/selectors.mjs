/**
 * The exact-match selector engine for Architecture Intent.
 *
 * A boundary's `match[]` values select projects. This is deliberately NOT
 * `findMatchingProjects` (`../rules/match.mjs`): that matcher is a faithful port
 * of Nx's own, and Nx's unlabeled patterns fall back to a case-insensitive
 * substring regular expression over project names (`applyName`, match.mjs:193).
 * Two things make that fallback wrong here:
 *
 *   - A boundary is a claim about which projects share an architecture role.
 *     `{ "match": ["domain"] }` quietly pulling in `platform-domain` because a
 *     substring regex matched is a boundary that means something other than what
 *     its author wrote — a silent false negative (a real violation routed
 *     through the stray member is never reported). Nx tolerates the
 *     over-approximation because its matcher already guards other text; intent
 *     IS the contract, so it must mean exactly what it says.
 *   - The fallback interpolates the selector into `new RegExp(...)`. In intent
 *     the selector is attacker-adjacent input (anything a pull request can add),
 *     and building a RegExp from it is a rejection / injection surface. Exact
 *     string comparison constructs no RegExp, so neither the over-approximation
 *     nor an injection surface exists.
 *
 * So intent owns this tiny grammar, matched by string equality only. Three
 * labeled forms plus a bare name, `*` for everything, and `!` for set
 * difference — nothing else. No glob, no `?`, no character class, no regex. A
 * `label:` prefix that is not one of the three is a load error (a `tagz:x` typo
 * surfaces red, never as a silent zero-match), handled by
 * `../architecture-intent/model.mjs` calling `selectorType` — this module
 * resolves members, it does not validate the file.
 */

/** The three selector labels. `unlabeled` is a bare project name (equals `name:`). */
const SELECTOR_LABELS = Object.freeze(["name", "tag", "directory"]);

/**
 * Split a selector into `{exclude, label, value}` — `!` prefix removed, `*`
 * kept as `*`. The `!`-prefix is the only leading signal a selector has; it
 * does not participate in the label or value lookup.
 */
export function splitSelector(value) {
  const exclude = value.startsWith("!");
  const body = exclude ? value.substring(1) : value;
  const separator = body.indexOf(":");
  const label = separator === -1 ? null : body.substring(0, separator);
  const val = separator === -1 ? body : body.substring(separator + 1);
  return { exclude, label, value: val };
}

/** Whether `value` is a syntactically valid selector — `!` prefix, then a known label or none. */
export function isValidSelector(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const { exclude, label, value: body } = splitSelector(value);
  if (label !== null && !SELECTOR_LABELS.includes(label)) return false;
  if (body.length === 0) return false;
  return exclude === true || exclude === false;
}

/**
 * The projects positively selected by one selector — a fresh array every call,
 * so callers can union results, and a sorted array, so the first thing a caller
 * doing set-math sees is a deterministic order. The `!` prefix is ignored here:
 * exclusion is a LIST-level operation over a boundary's whole `match[]`
 * (`resolveMembers` below), because `!a` means "everything already matched,
 * minus `a`" and so has no meaning as a single selector.
 *
 * `nodes` is the provider-neutral project map `{name: {data: {root, tags}}}`
 * every command receives.
 *
 * @param {string} selector
 * @param {Record<string, {data?: {root?: string, tags?: string[]}}>} nodes
 * @returns {string[]}
 */
export function selectProjects(selector, nodes) {
  // used by its own test
  const { label, value } = splitSelector(selector);

  let found;
  // `*` is a TOKEN of this grammar, not a wildcard character in it, so only the
  // BARE `*` means "every project" — `label === null` is what says "bare".
  // `docs/reference/architecture-intent.md`'s selector table gives `*` its own
  // row ("every project") separate from the three labeled rows, each of which
  // reads as an exact-equality test: `name:<name>` is "the project with that
  // exact name", `tag:<tag>` is "every project carrying that tag",
  // `directory:<d>` is "every project whose root directory is exactly `<d>`".
  // Testing `value === "*"` FIRST discarded the label, so `name:*`, `tag:*` and
  // `directory:*` each silently returned every project in the graph — a
  // boundary that reads as "the project literally named `*`" quietly became
  // "all of them", and, worse, it could never reach the zero-member no-verdict
  // in `./judge.mjs` that a selector matching nothing is supposed to raise.
  //
  // So a label puts `*` back in the value's own alphabet: `name:*` selects the
  // project actually named `*` (none, in every real workspace, so the boundary
  // is loudly unresolvable); `tag:*` selects the projects carrying a tag
  // literally spelled `*`, NOT "any project carrying any tag"; `directory:*`
  // the projects rooted at a directory literally named `*`. That reading is
  // forced twice over — this module's header admits no glob, no `?`, no
  // character class and no regex, and the doc's table defines each labeled form
  // as an exact match — and it is also the fail-loud one: every labeled `*`
  // that an author meant as a wildcard now resolves to nothing and surfaces as
  // a no-verdict, where the old behaviour answered a question nobody asked with
  // a set nobody wrote.
  if (label === null && value === "*") {
    found = Object.keys(nodes);
  } else if (label === "tag") {
    found = Object.keys(nodes).filter((name) => (nodes[name].data?.tags ?? []).includes(value));
  } else if (label === "directory") {
    found = Object.keys(nodes).filter((name) => nodes[name].data?.root === value);
  } else {
    // name: and unlabeled both mean an exact project name. Exact equality —
    // no substring, no case folding — so `domain` selects nothing when only
    // `platform-domain` exists, and the boundary is accurately empty.
    //
    // `Object.hasOwn`, never `nodes[value]`: `nodes` is a caller-supplied map
    // whose keys are project NAMES, and most providers hand over a plain object
    // (`JSON.parse` of `nx graph --file=`, `Object.fromEntries` in a test) that
    // still inherits from `Object.prototype`. A truthiness test on it answered
    // `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `__proto__`
    // with an inherited member and reported the selector as matching a project
    // of that name — measured: `selectProjects("constructor", nodes)` returned
    // `["constructor"]` on a graph with no such project, while `"nosuch"`
    // correctly returned `[]`. That is the silent direction twice: the phantom
    // member kept the boundary's zero-member check in `./judge.mjs` from ever
    // firing, so `intentUnresolved` stayed 0 and `check` exited 0 where its
    // contract owes 3, and every row anchored on that boundary was judged
    // against a project the workspace does not contain. The same names reach
    // `dependencies.forbidden` through a `Map` and are loud there; this branch
    // was the one that answered from the prototype.
    found = Object.hasOwn(nodes, value) ? [value] : [];
  }

  return found.sort();
}

/**
 * The members of a boundary: the union of its positive selectors, minus
 * whatever its `!` selectors carve out — order-independent, because
 * `docs/reference/architecture-intent.md` documents `match[]` as a set
 * expression ("the union of its positive selectors minus its `!` selectors"),
 * not a sequence of edits applied left to right. A list with NO positive
 * selector at all, like `["!tag:type-package"]`, means "everything except…",
 * so an implicit `*` seeds the union in that case only — decided by whether
 * any entry lacks `!`, never by which entry the list happens to start with.
 *
 * This deliberately does NOT reuse `findMatchingProjects`'s
 * (`../rules/match.mjs`) upstream-Nx rule of checking only `patterns[0]`:
 * that check is a faithful port of Nx's own `find-matching-projects.js`
 * (`isExcludePattern(patterns[0])`), and it makes the result depend on
 * selector ORDER — `["!tag:legacy", "tag:layer:app"]` seeds the wildcard
 * (exclusion first) and then the later positive selector re-adds a legacy
 * project the exclusion just removed, while the reverse order never seeds the
 * wildcard and correctly excludes it. That is upstream Nx's documented
 * behaviour and stays correct in `../rules/match.mjs`, which exists to match
 * Nx byte-for-byte; it would be wrong here, where the same list must resolve
 * the same way regardless of how the author happened to order it.
 *
 * @param {string[]} patterns A boundary's `match[]`, already validated.
 * @param {Record<string, {data?: {root?: string, tags?: string[]}}>} nodes
 * @returns {string[]} Sorted member names.
 */
export function resolveMembers(patterns, nodes) {
  const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negatives = patterns.filter((pattern) => pattern.startsWith("!"));
  const members = new Set();
  for (const pattern of positives.length > 0 ? positives : ["*"]) {
    for (const name of selectProjects(pattern, nodes)) members.add(name);
  }
  for (const pattern of negatives) {
    for (const name of selectProjects(pattern, nodes)) members.delete(name);
  }
  return Array.from(members).sort();
}
