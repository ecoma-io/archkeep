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
export const SELECTOR_LABELS = Object.freeze(["name", "tag", "directory"]);

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
  const { label, value } = splitSelector(selector);

  let found;
  if (value === "*") {
    found = Object.keys(nodes);
  } else if (label === "tag") {
    found = Object.keys(nodes).filter((name) => (nodes[name].data?.tags ?? []).includes(value));
  } else if (label === "directory") {
    found = Object.keys(nodes).filter((name) => nodes[name].data?.root === value);
  } else {
    // name: and unlabeled both mean an exact project name. Exact equality —
    // no substring, no case folding — so `domain` selects nothing when only
    // `platform-domain` exists, and the boundary is accurately empty.
    found = nodes[value] ? [value] : [];
  }

  return found.sort();
}

/**
 * The members of a boundary: the union of its positive selectors, minus
 * whatever its `!` selectors carve out. A list opening with an exclusion means
 * "everything except…", so `["!tag:type-package"]` prepends an implicit `*` —
 * the same rule `findMatchingProjects` reproduces in `../rules/match.mjs`.
 *
 * @param {string[]} patterns A boundary's `match[]`, already validated.
 * @param {Record<string, {data?: {root?: string, tags?: string[]}}>} nodes
 * @returns {string[]} Sorted member names.
 */
export function resolveMembers(patterns, nodes) {
  const effective = patterns[0].startsWith("!") ? ["*", ...patterns] : patterns;
  const members = new Set();
  for (const pattern of effective) {
    const exclude = pattern.startsWith("!");
    for (const name of selectProjects(pattern, nodes)) {
      if (exclude) members.delete(name);
      else members.add(name);
    }
  }
  return Array.from(members).sort();
}
