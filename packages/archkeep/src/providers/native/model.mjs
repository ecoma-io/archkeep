/**
 * `archkeep.json`: the native project-and-tag model, for a workspace with no
 * Nx at all.
 *
 * JSONC-tolerant, like every other config in this package, but NOT read
 * through `../../nx-json.mjs`: that module's whole reason to reach for Nx's
 * own parser is to give a config Nx ALSO reads (`nx.json`, `project.json`)
 * the exact JSONC leniency Nx gives it — there is no such thing to match
 * here, because Nx never opens `archkeep.json` at all; a workspace that has
 * one has no `nx.json` (`../../../../../docs/reference/configuration.md`, "This
 * page is for a workspace with no Nx at all"). Routing it through `parseNxJson`
 * anyway meant its JSONC tolerance — the trailing comma or `//` comment this
 * very module's header used to advertise as accepted — silently depended on
 * `nx` being resolvable from `node_modules`, which is exactly the dependency
 * a native, no-Nx workspace is promised it does not need
 * (`../../../AGENTS.md`, "the engine and the CLI run without it"). A
 * workspace with no `nx` installed and a commented `archkeep.json` — its OWN
 * root marker, the one file this provider cannot proceed without — would
 * fail before discovery ever ran, on a form this module's own docs call
 * valid. `stripJsonComments`/`stripTrailingCommas` below are the minimal,
 * in-repo, dependency-free fix: they handle only the two JSONC forms
 * documented here (`//` and `/* *\/` comments, one trailing comma before a
 * closing `}`/`]`), the same restraint `../../rules/match.mjs` argues for
 * not reimplementing minimatch — a stripper that guessed at more of JSON5
 * would silently mis-parse rather than visibly refuse an input it does not
 * actually understand.
 *
 * Never `import()`ed — unlike `module-boundaries.config.mjs`, this file
 * describes data rather than code, so there is nothing here that needs a
 * module loader and nothing here that could carry a side effect.
 *
 * This module validates SHAPE only: is `projects.declared[3].root` a string,
 * does a `coverage.exempt` row carry a `reason`. Whether a declared root
 * exists in the tree, whether two projects collide on one name, whether a
 * `projectRules` row matches anything — those are questions about the tree
 * this file describes, not about this file's own shape, and they are
 * `./discover.mjs`'s to answer, the same split `../../config.mjs` draws
 * between a malformed config and a config whose values do not hold up.
 *
 * `findNativeModelViolations`/`loadNativeModel` copy `../../config.mjs`'s own
 * split: a pure `(raw) -> string[]` validator, and a thin loader that reads,
 * parses, validates and throws — one error naming every violation at once,
 * because a reader fixing one typo at a time against a tool that only ever
 * shows the first is the slower way to get to a working config.
 */
import { globComplexityError, projectPatternError, safeMatchesGlob } from "../../rules/match.mjs";
import { resolveOptions } from "../../options.mjs";
import { findBoundaryConfigViolations, policyKeyViolations } from "../../config.mjs";
import { describe, isPlainObject, isStringArray } from "../../values.mjs";

/** The file this provider treats as a workspace root marker and its model. */
export const ARCHKEEP_MODEL_FILE = "archkeep.json";

/**
 * Copies every character of `text` to `out` up to and including the closing
 * quote of the string literal starting at `text[start]`, honouring `\"` so a
 * quote escaped inside the string does not end it early.
 *
 * Shared by `stripJsonComments` and `stripTrailingCommas` below so both scans
 * treat a `//`, `/*`, or `,` sitting inside a JSON string value as ordinary
 * text rather than syntax — a `archkeep.json` string that happens to contain
 * `"see a//b"` or `"waived, }"` must survive unmodified.
 *
 * @param {string} text
 * @param {number} start Index of the opening `"`.
 * @returns {{out: string, next: number}} The copied text and the index just
 *   past the closing quote (`text.length` if the string never closes).
 */
function copyStringLiteral(text, start) {
  let out = text[start];
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    out += c;
    i++;
    if (c === "\\" && i < text.length) {
      out += text[i];
      i++;
      continue;
    }
    if (c === '"') break;
  }
  return { out, next: i };
}

/**
 * Strips `//` line comments and `/* *\/` block comments from `text`, leaving
 * every string literal untouched.
 *
 * @param {string} text
 * @returns {string}
 */
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const copied = copyStringLiteral(text, i);
      out += copied.out;
      i = copied.next;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Drops one trailing comma before a closing `}` or `]` — the comma, and only
 * the comma, so `{"a": 1,}` and `[1, 2,]` read as strict JSON afterward.
 * String literals are copied verbatim, so a comma inside one is never
 * mistaken for JSON structure (unlike a `,(\s*[}\]])` regex run AFTER
 * comments are stripped, which cannot tell a real trailing comma from the
 * same two characters inside a string value).
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingCommas(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const copied = copyStringLiteral(text, i);
      out += copied.out;
      i = copied.next;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parses `archkeep.json` itself — JSONC-tolerant on its own, with no
 * dependency on `nx` being installed. See this module's header for why
 * `../../nx-json.mjs`'s Nx-reaching parser is the wrong reader for this one
 * file: `readFile`'s JSON.parse runs first, exactly as `../../nx-json.mjs`
 * runs it first, so the common case (strict JSON, no comment, no trailing
 * comma) pays for none of the stripping below; only a file that failed the
 * first parse pays for a second pass.
 *
 * A file that still fails to parse after stripping throws the ORIGINAL
 * `JSON.parse` error, not one from the stripped text — the stripped text's
 * character offsets have shifted from the file on disk, so an error pointing
 * into it would send a reader to the wrong line.
 *
 * @param {string} text
 * @returns {object} Whatever the JSON describes.
 * @throws {Error} when `text` is not valid JSON even once comments and one
 *   trailing comma per closing bracket are stripped.
 */
function parseArchkeepJson(text) {
  try {
    return JSON.parse(text);
  } catch (plain) {
    try {
      return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
    } catch {
      throw plain;
    }
  }
}

/**
 * The manifest basenames `projects.infer` looks for when a workspace does not
 * say otherwise — one per language this package's analyzers cover
 * (`../../analysis/analyze.mjs`'s `LANGUAGE_BY_EXTENSION`), plus `project.json`
 * for a tree that kept Nx-shaped project boundaries without keeping Nx.
 */
export const DEFAULT_MANIFEST_NAMES = Object.freeze([
  "project.json",
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  // Maven: every tracked root pom.xml anchors a project (ADR 0005). Identity
  // is `(groupId, artifactId)` read by `../../analysis/jvm/maven.mjs`; the
  // name follows the same precedence as every other inferred manifest, so
  // pom-discovered projects land on their directory basename unless a
  // declared row names them.
  "pom.xml",
  // Gradle: settings.gradle / settings.gradle.kts anchors a Gradle build
  // (ADR 0005 Decision 2). Identity is the root project name and included
  // projects from the settings file; edges are read from build.gradle /
  // build.gradle.kts by `../../analysis/jvm/gradle.mjs`. The settings file
  // is the discovery manifest — it defines the reactor structure — while
  // the build files hold the dependency declarations.
  "settings.gradle",
  "settings.gradle.kts",
  // .NET/C#: every tracked root .csproj anchors a project (ADR 0006). Identity
  // is the project name read by `../../analysis/dotnet/csproj.mjs`; the
  // name follows the same precedence as every other inferred manifest, so
  // csproj-discovered projects land on their directory basename unless a
  // declared row names them.
  "*.csproj",
]);

const PROJECT_TYPES = ["app", "lib", "e2e"];

/**
 * The deliberate default for `projects.infer.exclude` — the anchor-exclusion
 * half of the phantom-project policy (issue #371): a tracked manifest inside a
 * directory that is documentation or test data about the workspace, rather
 * than a part of it, never anchors an inferred project, because inference over
 * it would judge a phantom as real. `docs/`, `fixtures/` and `__fixtures__/`
 * as whole path segments are the complete set: those three names mean "data
 * about the tree" in every convention this package has measured, and a name
 * like `examples/` was deliberately left OFF it — example projects are
 * commonly real, built, governed code, so excluding them by name would be the
 * same over-broad-by-name error the `obj`/`bin` half of the same issue
 * repudiated (`./discover.mjs`'s `isDotnetGeneratedOutput`).
 *
 * Two facts make this exclusion safe rather than a silent hole:
 *
 * - `projects.declared` is exempt — a workspace with a real project under one
 *   of these paths declares it, and declaration is the authoritative channel
 *   inference never touches.
 * - A dropped anchor's analyzable files do not vanish silently: they surface
 *   through `./coverage.mjs`'s unclaimed-file judgment as whole-file failures
 *   until the workspace either declares the project or records a reasoned
 *   `coverage.exempt` row — which is the loud, explicit opt-in for "this
 *   directory is fixture data".
 *
 * An explicit `exclude` list REPLACES this default (the `tsc` convention for
 * the same field): a workspace that names its own list takes over the whole
 * decision, `exclude: []` included — that spelling is the documented opt-out.
 * `excludeBeyondDefaults` extends the effective set — the defaults when
 * `exclude` is absent, an explicit list when it is present — without restating
 * it, so a workspace with `testdata/` or `golden/` directories does not copy
 * these three patterns by hand (issue #389).
 *
 * @see DEFAULT_MANIFEST_NAMES
 */
export const DEFAULT_INFER_EXCLUDE = Object.freeze([
  "**/docs/**",
  "**/fixtures/**",
  "**/__fixtures__/**",
]);

/**
 * A non-empty-string list's problems, each message naming the entry's own
 * index. `patternError`, when given, is the same-shaped check
 * `../../config.mjs`'s `listEntryViolations` runs — an entry that will not
 * compile against the matcher it is fed to throws later, mid-run, with no
 * idea which row of `archkeep.json` produced it.
 *
 * @param {unknown} value
 * @param {string} at
 * @param {((pattern: string) => string|null)|undefined} [patternError]
 * @returns {string[]}
 */
function stringListViolations(value, at, patternError) {
  if (value === undefined) return [];
  if (!isStringArray(value)) return [`${at}: must be an array of strings, got ${describe(value)}`];
  const violations = [];
  value.forEach((entry, index) => {
    if (entry === "") {
      violations.push(`${at}[${index}]: must not be empty`);
      return;
    }
    const problem = patternError?.(entry);
    if (problem) violations.push(`${at}[${index}]: '${entry}' ${problem}`);
  });
  return violations;
}

const DECLARED_KEYS = ["name", "root", "type", "tags", "implicitDependencies", "targets"];

/** One `projects.declared` row's problems, prefixed with its index. */
function declaredProjectViolations(row, index) {
  const at = `projects.declared[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  // Canonical form only, checked in full before anything downstream ever
  // compares this string against a tracked file: `./discover.mjs`'s `hasFile`
  // matches by exact prefix (`${root}/`), so any of these forms would either
  // match nothing a reader expects or match by coincidence, and the
  // leading/trailing-slash message below is not the right explanation for any
  // of them — a `'.'` root needs to be told to write `''` instead, not told
  // about slashes it does not have.
  if (typeof row.root !== "string") {
    violations.push(`${at}.root: must be a string, got ${describe(row.root)}`);
  } else if (row.root === ".") {
    violations.push(`${at}.root: '.' is not valid — write '' to name the workspace root itself`);
  } else if (row.root !== "") {
    if (row.root.includes("\\")) {
      violations.push(
        `${at}.root: '${row.root}' must use forward slashes — this tool matches paths ` +
          `posix-style regardless of the platform the tree is checked out on`,
      );
    } else if (row.root.startsWith("/") || row.root.endsWith("/")) {
      violations.push(
        `${at}.root: '${row.root}' must be workspace-relative with no leading or trailing ` +
          `slash — '' names the workspace root itself`,
      );
    } else if (row.root.split("/").some((segment) => segment === "." || segment === "..")) {
      violations.push(
        `${at}.root: '${row.root}' must be a canonical path — no '.' or '..' segment`,
      );
    }
  }
  if ("name" in row && (typeof row.name !== "string" || row.name === "")) {
    violations.push(
      `${at}.name: must be a non-empty string when present, got ${describe(row.name)}`,
    );
  }
  if ("type" in row && !PROJECT_TYPES.includes(/** @type {string} */ (row.type))) {
    violations.push(
      `${at}.type: must be one of ${PROJECT_TYPES.join(", ")}, got ${describe(row.type)}`,
    );
  }
  // Tag VALUES are not matched against anything — a project either carries a
  // tag or it does not — so the only requirement is the one every string list
  // here already enforces: non-empty (spec M8). `tagPatternError` belongs to
  // `depConstraints.sourceTag`/`onlyDependOnLibsWithTags`, a different
  // vocabulary this validator must not borrow.
  violations.push(...stringListViolations(row.tags, `${at}.tags`));
  // `implicitDependencies` is expanded by `../../rules/match.mjs`'s
  // `findMatchingProjects` — the exact function `./graph.mjs`'s promoted
  // `buildDependencies` already calls — so an entry it cannot resolve is
  // rejected here with the matcher's own reason (`projectPatternError`,
  // the validator `findMatchingProjects` itself is never given a chance to
  // run without) rather than at graph-build time, where it would name no row
  // of this file at all and `buildDependencies`'s own catch would just drop
  // the edge in silence.
  violations.push(
    ...stringListViolations(
      row.implicitDependencies,
      `${at}.implicitDependencies`,
      projectPatternError,
    ),
  );
  violations.push(...stringListViolations(row.targets, `${at}.targets`));
  for (const key of Object.keys(row)) {
    if (!DECLARED_KEYS.includes(key)) {
      violations.push(
        `${at}.${key}: not a declared-project field — expected one of ${DECLARED_KEYS.join(", ")}`,
      );
    }
  }
  return violations;
}

const INFER_KEYS = ["manifests", "include", "exclude", "excludeBeyondDefaults"];

/** `projects.infer`'s problems, or `[]` when the key is absent — absent means "use the defaults", not "malformed". */
function inferViolations(value) {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [`projects.infer: must be an object, got ${describe(value)}`];
  const violations = [
    ...stringListViolations(value.manifests, "projects.infer.manifests"),
    ...stringListViolations(value.include, "projects.infer.include", globComplexityError),
    ...stringListViolations(value.exclude, "projects.infer.exclude", globComplexityError),
    ...stringListViolations(
      value.excludeBeyondDefaults,
      "projects.infer.excludeBeyondDefaults",
      globComplexityError,
    ),
  ];
  // `[]` and "omit the key" both validate against `stringListViolations` above
  // — a list is still a list at length zero — but they must not mean the same
  // thing. Omitting `projects.infer` means "use the defaults" (see this
  // function's own doc comment); an explicit `[]` for `manifests` or
  // `include` matches no manifest and no path, which silently claims zero
  // projects by inference rather than the all/defaults an author reaching for
  // `[]` almost certainly wants. `exclude: []` is exempt: it already means
  // "exclude nothing," which is a real, useful, non-silent setting.
  for (const key of /** @type {const} */ (["manifests", "include"])) {
    if (Array.isArray(value[key]) && value[key].length === 0) {
      violations.push(
        `projects.infer.${key}: must not be empty — an empty list matches nothing and silently ` +
          `disables inference; omit 'projects.infer' entirely to disable it instead`,
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!INFER_KEYS.includes(key)) {
      violations.push(
        `projects.infer.${key}: not an infer field — expected one of ${INFER_KEYS.join(", ")}`,
      );
    }
  }
  return violations;
}

const PROJECT_RULE_KEYS = ["match", "tags", "type"];

/** One `projectRules` row's problems, prefixed with its index. */
function projectRuleViolations(row, index) {
  const at = `projectRules[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  if (typeof row.match !== "string" || row.match === "") {
    violations.push(
      `${at}.match: must be a non-empty glob over a project's root — matched with ` +
        `\`path.posix.matchesGlob\`, got ${describe(row.match)}`,
    );
  } else {
    const problem = globComplexityError(row.match);
    if (problem) violations.push(`${at}.match: '${row.match}' ${problem}`);
  }
  if (!("tags" in row) && !("type" in row)) {
    violations.push(
      `${at}: must set 'tags', 'type', or both — a row that sets neither matches ` +
        `projects and changes nothing about them`,
    );
  }
  // Same non-empty-string-only bar as `declaredProjectViolations` applies to
  // tag values — see the comment there.
  violations.push(...stringListViolations(row.tags, `${at}.tags`));
  if ("type" in row && !PROJECT_TYPES.includes(/** @type {string} */ (row.type))) {
    violations.push(
      `${at}.type: must be one of ${PROJECT_TYPES.join(", ")}, got ${describe(row.type)}`,
    );
  }
  for (const key of Object.keys(row)) {
    if (!PROJECT_RULE_KEYS.includes(key)) {
      violations.push(
        `${at}.${key}: not a projectRules field — expected one of ${PROJECT_RULE_KEYS.join(", ")}`,
      );
    }
  }
  return violations;
}

const EXEMPT_KEYS = ["path", "reason"];

/**
 * One `coverage.exempt` row's problems, prefixed with its index.
 *
 * The mandatory `reason` copies `../../config.mjs`'s `suppressionRowViolations`
 * exactly: a waiver with no reason written down is indistinguishable from
 * coverage that quietly stopped being enforced, which is the one state this
 * whole tool exists to make loud instead of silent.
 */
function exemptRowViolations(row, index) {
  const at = `coverage.exempt[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  if (typeof row.path !== "string" || row.path === "") {
    violations.push(
      `${at}.path: must be a non-empty glob over a workspace-relative path, matched with ` +
        `\`path.posix.matchesGlob\`, got ${describe(row.path)}`,
    );
  } else {
    const problem = globComplexityError(row.path);
    if (problem) violations.push(`${at}.path: '${row.path}' ${problem}`);
  }
  if (typeof row.reason !== "string" || row.reason.trim() === "") {
    violations.push(
      `${at}.reason: must be a non-empty string — a waiver is a coverage hole someone decided ` +
        `to accept, and one with no reason written down reads as coverage that is still enforced`,
    );
  }
  for (const key of Object.keys(row)) {
    if (!EXEMPT_KEYS.includes(key)) {
      violations.push(
        `${at}.${key}: not an exempt field — expected one of ${EXEMPT_KEYS.join(", ")}`,
      );
    }
  }
  return violations;
}

const WORKSPACE_LAYOUT_KEYS = ["appsDir", "libsDir"];

/** `workspaceLayout`'s problems, or `[]` when the key is absent — absent, never inferred. */
function workspaceLayoutViolations(value) {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [`workspaceLayout: must be an object, got ${describe(value)}`];
  const violations = [];
  for (const key of WORKSPACE_LAYOUT_KEYS) {
    if (typeof value[key] !== "string" || value[key] === "") {
      violations.push(
        `workspaceLayout.${key}: must be a non-empty string, got ${describe(value[key])}`,
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!WORKSPACE_LAYOUT_KEYS.includes(key)) {
      violations.push(
        `workspaceLayout.${key}: not a workspaceLayout field — expected one of ${WORKSPACE_LAYOUT_KEYS.join(", ")}`,
      );
    }
  }
  return violations;
}

const TOP_LEVEL_KEYS = [
  "projects",
  "projectRules",
  "coverage",
  "workspaceLayout",
  "boundaryConfig",
  "tsConfig",
];

/**
 * Everything wrong with the SHAPE of a loaded `archkeep.json`, as messages;
 * empty when it is well-formed. Pure, so a test drives it without a file on
 * disk — the same contract `../../config.mjs`'s `findBoundaryConfigViolations`
 * keeps.
 *
 * `boundaryConfig` and `tsConfig` are deliberately NOT checked here when
 * `boundaryConfig` is a string: both are then validated by `resolveOptions`
 * (`../../options.mjs`) inside `loadNativeModel` below, so there is one
 * validator and one default table for that pair rather than a second copy of
 * `DEFAULT_OPTIONS`'s rules. A `boundaryConfig` that is an OBJECT instead of a
 * string — the inline policy this file's own doc names as a second accepted
 * shape (`../../../../../docs/reference/configuration.md`, "boundaryConfig") —
 * bypasses `resolveOptions` entirely, since that function's whole contract is
 * "every value is a non-empty string", so its check is inline below, and it
 * reuses `../../config.mjs`'s own `findBoundaryConfigViolations` AND
 * `policyKeyViolations` rather than a second copy of what a policy object may
 * hold: the same pair `../../config.mjs`'s own `.json` dialect calls, with
 * `allowSchema: true` — the same key law a `.json` policy file has, so the
 * same JSON text that loads as a file loads inline (an inline `$schema` is
 * accepted and checked the same way, never rejected for living in this
 * object rather than its own file; `../../../../../docs/reference/policy-schema.md`,
 * "Inline policy (`archkeep.json` only)").
 *
 * @param {unknown} raw The parsed `archkeep.json`.
 * @returns {string[]}
 */
export function findNativeModelViolations(raw) {
  if (!isPlainObject(raw)) return [`archkeep.json: expected an object, got ${describe(raw)}`];

  const violations = [];
  const { projects, projectRules, coverage, workspaceLayout } = raw;

  // An inline policy is validated by the exact function every other route to
  // a boundary law runs through, so a malformed inline `depConstraints` row
  // is caught here rather than surfacing later as a rule that matches
  // nothing. A `boundaryConfig` that is a string is left alone here — see
  // this function's own doc comment for where that string is validated
  // instead — and one that is neither a string nor an object gets its own
  // message rather than silently falling through to "not checked here".
  if ("boundaryConfig" in raw) {
    if (isPlainObject(raw.boundaryConfig)) {
      violations.push(
        ...findBoundaryConfigViolations(raw.boundaryConfig).map(
          (message) => `boundaryConfig.${message}`,
        ),
        ...policyKeyViolations(raw.boundaryConfig, { allowSchema: true }).map(
          (message) => `boundaryConfig.${message}`,
        ),
      );
      // The policy's `coverage` key is an Nx/Moon channel, refused here BY
      // NAME on the one provider that already has its own: this very file's
      // `coverage.exempt` is where a native tree records an unowned-file
      // acceptance, and two channels for one decision on one tree is how
      // copies drift (the same posture as the `.moon`-beside-`archkeep.json`
      // refusal in `../model-gate.mjs`'s `requireSingleProjectModel`).
      // The file-dialect spelling of the same mistake — a native tree whose
      // boundaryConfig FILE declares `coverage` — is refused by
      // `../../commands/policy.mjs`'s `resolvePolicy`, which is the first
      // point that knows both the provider and the loaded policy.
      if ("coverage" in raw.boundaryConfig) {
        violations.push(
          `boundaryConfig.coverage: not accepted on a native workspace — this tree records ` +
            `unowned-file acceptances on archkeep.json's own coverage.exempt, and a second ` +
            `channel for the same decision is a copy that will drift. Move the rows there`,
        );
      }
    } else if (typeof raw.boundaryConfig !== "string") {
      violations.push(
        `boundaryConfig: must be a string (a filename) or an object (an inline policy), got ` +
          `${describe(raw.boundaryConfig)}`,
      );
    }
  }

  // `projects` is optional the same way every other top-level key here is —
  // `docs/reference/configuration.md`'s "The shape, field by field" names a bare
  // `{}` a valid `archkeep.json`, and an absent `projects` means exactly what
  // `projects: {}` already validated as: zero declared rows, no inference.
  // Rejecting `undefined` here (as this used to) contradicted that documented
  // minimal form outright — the loader could not read the one example the
  // page opens with. `discoverNativeProjects` (`./discover.mjs`) is still the
  // one that turns "zero projects" into a loud failure once the tree is
  // known; this validator's job stops at shape.
  if (projects !== undefined && !isPlainObject(projects)) {
    violations.push(`projects: must be an object, got ${describe(projects)}`);
  } else {
    const declaredProjects = /** @type {Record<string, unknown>} */ (projects ?? {});
    if ("declared" in declaredProjects && !Array.isArray(declaredProjects.declared)) {
      violations.push(
        `projects.declared: must be an array when present, got ${describe(declaredProjects.declared)}`,
      );
    } else {
      /** @type {unknown[]} */ (declaredProjects.declared ?? []).forEach((row, index) =>
        violations.push(...declaredProjectViolations(row, index)),
      );
    }
    violations.push(...inferViolations(declaredProjects.infer));
    for (const key of Object.keys(declaredProjects)) {
      if (key !== "declared" && key !== "infer") {
        violations.push(`projects.${key}: not a projects field — expected one of declared, infer`);
      }
    }
  }

  if (projectRules !== undefined) {
    if (!Array.isArray(projectRules)) {
      violations.push(`projectRules: must be an array when present, got ${describe(projectRules)}`);
    } else {
      projectRules.forEach((row, index) => violations.push(...projectRuleViolations(row, index)));
    }
  }

  if (coverage !== undefined) {
    if (!isPlainObject(coverage)) {
      violations.push(`coverage: must be an object when present, got ${describe(coverage)}`);
    } else {
      if ("exempt" in coverage && !Array.isArray(coverage.exempt)) {
        violations.push(
          `coverage.exempt: must be an array when present, got ${describe(coverage.exempt)}`,
        );
      } else {
        /** @type {unknown[]} */ (coverage.exempt ?? []).forEach((row, index) =>
          violations.push(...exemptRowViolations(row, index)),
        );
      }
      for (const key of Object.keys(coverage)) {
        if (key !== "exempt")
          violations.push(`coverage.${key}: not a coverage field — expected 'exempt'`);
      }
    }
  }

  violations.push(...workspaceLayoutViolations(workspaceLayout));

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      violations.push(
        `${key}: not a archkeep.json field — expected one of ${TOP_LEVEL_KEYS.join(", ")}`,
      );
    }
  }
  return violations;
}

/**
 * A validated `archkeep.json`, with every default applied so nothing downstream
 * re-derives one: `projects.infer`'s three lists, `coverage.exempt`'s empty
 * array, `boundaryConfig`/`tsConfig` through `resolveOptions`.
 *
 * `workspaceLayout` is the one field intentionally NOT defaulted here — it
 * stays `undefined` when `archkeep.json` does not declare it, exactly as an
 * absent `nx.json` `workspaceLayout` leaves `graph.workspaceLayout` unset for
 * the Nx provider, so `../../rules/index.mjs`'s own
 * `graph.workspaceLayout ?? DEFAULT_WORKSPACE_LAYOUT` fallback is the only
 * place that ever applies the default. A second default here could disagree
 * with that one the day either changes.
 *
 * `boundaryConfig` rides through untouched when `raw.boundaryConfig` is an
 * inline object — `resolveOptions` never sees it, since its whole contract is
 * "every value is a non-empty string" and an inline policy is neither. It has
 * already passed `findNativeModelViolations`' own check by the time this runs
 * (`loadNativeModel` validates before normalizing), so nothing here re-checks
 * its shape.
 *
 * `boundaryConfigDeclared` is the one field on the model that `archkeep.json`
 * cannot write and this function computes: whether the file named a boundary
 * law at all, as against taking `../../options.mjs`'s `DEFAULT_OPTIONS`
 * filename by convention. Both string and inline-object spellings count as
 * declared — the workspace named its law either way, and the fact a reader
 * downstream needs is exactly "did somebody name one", never "in which of the
 * four spellings". That module's header owns the argument for why the bit has
 * to survive the merge at all.
 *
 * @param {Record<string, unknown>} raw Already validated by `findNativeModelViolations`.
 * @returns {object} `NativeModel` — see `./index.mjs`.
 */
export function normalizeNativeModel(raw) {
  // `raw.projects` may be absent — `findNativeModelViolations` above validates
  // that shape the same way it validates `projects: {}`, so this has to read
  // it back the same way rather than assume the key is always present.
  const projects = /** @type {Record<string, unknown>} */ (raw.projects ?? {});
  const declared = /** @type {unknown[]} */ (projects.declared) ?? [];
  const rawInfer = /** @type {Record<string, unknown>|undefined} */ (projects.infer);

  // The provenance of `boundaryConfig`, computed once and used three ways:
  // twice to decide what `resolveOptions` is even asked, and once as the
  // model's own `boundaryConfigDeclared`. It is deliberately NOT read back
  // off `resolvedOptions`, which would be wrong for the inline spelling —
  // an inline policy object never reaches `resolveOptions` at all, so that
  // object's own bit says `false` for the one shape where the workspace was
  // most explicit about naming its law.
  const declaresBoundaryConfig = "boundaryConfig" in raw;
  const inlineBoundaryConfig = isPlainObject(raw.boundaryConfig) ? raw.boundaryConfig : undefined;
  const resolvedOptions = resolveOptions(
    (declaresBoundaryConfig && inlineBoundaryConfig === undefined) || "tsConfig" in raw
      ? {
          ...(declaresBoundaryConfig && inlineBoundaryConfig === undefined
            ? { boundaryConfig: raw.boundaryConfig }
            : {}),
          ...("tsConfig" in raw ? { tsConfig: raw.tsConfig } : {}),
        }
      : undefined,
  );

  return {
    projects: {
      declared: declared.map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        return {
          name: typeof r.name === "string" ? r.name : undefined,
          root: /** @type {string} */ (r.root),
          type: typeof r.type === "string" ? r.type : undefined,
          tags: /** @type {string[]} */ (r.tags) ?? [],
          implicitDependencies: /** @type {string[]} */ (r.implicitDependencies) ?? [],
          targets: /** @type {string[]} */ (r.targets) ?? [],
        };
      }),
      // Spec §3.1: an absent `projects.infer` key means the declared list is
      // exhaustive — no inference at all — not "infer with every default."
      // `./discover.mjs`'s `model.projects.infer ? inferProjectRoots(...) : []`
      // already reads it that way; filling this in regardless (as this object
      // used to) made that ternary always truthy and inference always ran,
      // silently claiming a vendored `package.json` as a project no
      // `archkeep.json` author asked for. Only a *present* `projects.infer` gets
      // its own three lists defaulted, key by key.
      infer:
        rawInfer === undefined
          ? undefined
          : {
              manifests: rawInfer.manifests ?? DEFAULT_MANIFEST_NAMES,
              include: rawInfer.include ?? ["**"],
              // `exclude` replaces the defaults (`DEFAULT_INFER_EXCLUDE`'s doc
              // comment owns the why); `excludeBeyondDefaults` then extends the
              // effective set — the defaults when `exclude` is absent, the
              // explicit list when it is present — without restating it.
              exclude: [
                .../** @type {string[]|undefined} */ (rawInfer.exclude ?? DEFAULT_INFER_EXCLUDE),
                .../** @type {string[]|undefined} */ (rawInfer.excludeBeyondDefaults ?? []),
              ],
            },
    },
    projectRules: /** @type {unknown[]} */ (raw.projectRules ?? []).map((row) => {
      const r = /** @type {Record<string, unknown>} */ (row);
      return {
        match: /** @type {string} */ (r.match),
        tags: /** @type {string[]} */ (r.tags) ?? [],
        type: typeof r.type === "string" ? r.type : undefined,
      };
    }),
    coverage: {
      exempt: /** @type {unknown[]} */ (
        /** @type {Record<string, unknown>|undefined} */ (raw.coverage)?.exempt ?? []
      ).map((row) => /** @type {{path: string, reason: string}} */ (row)),
    },
    workspaceLayout: /** @type {{appsDir: string, libsDir: string}|undefined} */ (
      raw.workspaceLayout
    ),
    boundaryConfig: inlineBoundaryConfig ?? resolvedOptions.boundaryConfig,
    boundaryConfigDeclared: declaresBoundaryConfig,
    tsConfig: resolvedOptions.tsConfig,
  };
}

/**
 * Loads and validates the `archkeep.json` at a workspace root.
 *
 * The path-taking, throw-on-malformed shape mirrors `../../config.mjs`'s
 * `loadBoundaryConfigFile` exactly, down to the two message shapes: every
 * shape violation reported at once, or a wrapped read failure. That parity is
 * deliberate — a defect in the project's own model is a "could not reach a
 * verdict" failure exactly like a defect in the boundary law is, and both
 * exit the same way (`../../../cli.mjs`, `EXIT.error`).
 *
 * @param {string} root Absolute workspace root.
 * @param {{readFile: (path: string) => string|null}} io
 * @returns {object} `NativeModel` — see `./index.mjs`.
 * @throws {Error} when the file is missing, unreadable, or malformed.
 */
export function loadNativeModel(root, { readFile }) {
  const text = readFile(ARCHKEEP_MODEL_FILE);
  const path = `${root}/${ARCHKEEP_MODEL_FILE}`;
  if (text === null) {
    throw new Error(`archkeep: cannot load ${path}: no such file`);
  }
  let raw;
  try {
    raw = parseArchkeepJson(text);
  } catch (cause) {
    throw new Error(`archkeep: cannot load ${path}: ${cause?.message ?? cause}`, { cause });
  }
  const violations = findNativeModelViolations(raw);
  if (violations.length > 0) {
    throw new Error(`archkeep: ${path} is malformed:\n  ${violations.join("\n  ")}`);
  }
  return normalizeNativeModel(raw);
}

// Re-exported so a caller matching a project root against a glob (discovery,
// coverage) reaches for the one matcher `archkeep.json` uses throughout,
// rather than importing `../../rules/match.mjs` a second time for the same
// job. `safeMatchesGlob`, not a bare `path.posix.matchesGlob`: `projectRules`
// and `coverage.exempt` are validated against `globComplexityError` above at
// config load (`projectRuleViolations`, `exemptRowViolations`), and this
// export is the backstop for any pattern that reaches matching without going
// through that validation — see `../../rules/match.mjs`'s own doc comment.
export const matchesGlob = safeMatchesGlob;
