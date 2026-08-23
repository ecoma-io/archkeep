#!/usr/bin/env node
// Holds CONTRIBUTING.md to what CI actually runs and what the Git hooks
// actually contain (issue #240).
//
// Two drifts, one owner — both copies live in CONTRIBUTING.md, so one gate
// holds them:
//
//   1. THE COMMAND ROSTER. CONTRIBUTING tells contributors to "Run all of
//      them before you push", but CI is where green is defined, and its
//      roster had moved: check-skills, check-docs-links, the sharded E2E
//      job, and package-vsix + verify-vsix ran on every pull request while
//      the document's roster stayed silent about them. A contributor who ran
//      exactly what the document listed — every line of it — still went red
//      on the pull request. This gate parses the `run:` steps out of
//      `.github/workflows/ci.yml` (the same source `check-packages.mjs`
//      reads its targets from) and requires every pnpm/node invocation to be
//      mentioned in CONTRIBUTING.md or named in this file's EXCEPTIONS table
//      with its reason. An exception nobody's step uses anymore is itself a
//      failure, so the table cannot fill up with stale pardons.
//
//   2. THE HOOK DOCUMENTATION. lefthook.yml is read once, by `lefthook
//      install`; afterwards nothing compares what it installed against what
//      CONTRIBUTING promises. Deleting or weakening a hook block would leave
//      the document describing gates that no longer exist — byte-for-byte
//      identical to a healthy tree. This gate parses lefthook.yml's hook
//      blocks and CONTRIBUTING's "What the hooks do" bullets and requires
//      the same hooks on both sides, and, within each hook, the same set of
//      commands: a documented gate whose block disappears fails, and a block
//      added without documentation fails.
//
// Every fact is DERIVED from its source — the workflow text, the hook file,
// the document — never restated here. What this file owns is the address of
// each claim and the small normalization layer between prose and shell (a
// documented `moon projects` satisfies a `pnpm exec moon projects` run line;
// a documented `prettier` satisfies `pnpm exec prettier --write …`). An
// empty result therefore means: every CI step is either documented or
// explicitly excepted, every exception is still in use, and every hook
// block and its documentation name the same commands.
//
// Resolution limit, stated rather than hidden: this pin holds COMMAND
// presence in both directions. It does not judge flag values — dropping
// `--max-warnings 0` from the lint hook or `stage_fixed` from the format
// hook stays below its resolution, and catching that class belongs to review
// of the lefthook.yml diff itself, which the file's own comments argue.
//
// Judgment is pure (`evaluateContributing`, `evaluateHooks`); only `main`
// reads files. The integration cases in `check-contributing-parity.test.mjs`
// run under CI's `pnpm test`, which is what makes these pins live.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DOC_PATH = "CONTRIBUTING.md";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const LEFTHOOK_PATH = "lefthook.yml";

/** Heading CONTRIBUTING's hook documentation lives under. */
export const HOOKS_HEADING = /^##\s+What the hooks do\s*$/m;

/**
 * The hooks table's header row: hook name | the commands it runs, in order.
 * A table rather than prose bullets because the pin has to tell "a gate this
 * hook runs" from "an incidental mention inside an explanation" — prose
 * cannot make that distinction structurally; a two-column table is exactly
 * that distinction. The explanations live on after the table as prose.
 */
export const HOOKS_TABLE_HEADER = /^\|\s*hook\s*\|\s*commands it runs[^|]*\|\s*$/;

/**
 * CI steps this gate deliberately does not hold CONTRIBUTING's command roster
 * to, each with the reason. A step listed here must still EXIST in ci.yml —
 * an exception whose step is gone fails as stale — and a step added to CI
 * without documentation and without an entry here fails.
 *
 * @type {{identity: string, reason: string}[]}
 */
export const EXCEPTIONS = [
  {
    identity: "pnpm exec commitlint",
    reason:
      "the pull-request-title check: it reads the title GitHub sends on the " +
      "pull_request event through env, so it is not a command a contributor " +
      "runs locally. CONTRIBUTING describes the rule it enforces under 'How a " +
      "pull request lands' (the squash-commit subject), which is the prose " +
      "copy of this step.",
  },
  {
    identity: 'node "$cli"',
    reason:
      "one line of the native-provider self-check, a composite CI-only step " +
      "that git-archives the tracked tree into a throwaway copy, removes the " +
      "Moon manifests, and runs the checker from outside the copy. It cannot " +
      "be reproduced as a local command, and ci.yml's own comments own its " +
      "full argument.",
  },
];

/**
 * Splits a shell line into segments on the separators that end one command
 * and begin another. Deliberately simple — it does not track quotes, so a
 * separator inside a quoted string splits anyway. For the invocations this
 * repository's workflow actually carries, every such split only ever
 * produces extra NON-pnpm/non-node fragments, which are discarded; it can
 * never merge two real invocations into one, which is the direction that
 * would hide a step from this gate.
 *
 * GitHub Actions expressions are replaced before splitting, since their
 * interiors may contain anything.
 *
 * @param {string} line one physical shell line
 * @returns {string[]} trimmed command segments
 */
export function shellSegments(line) {
  return line
    .replace(/\$\{\{[^}]*\}\}/g, " ")
    .split(/[;&|()]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Extracts every pnpm/node invocation from a workflow's `run:` values —
 * inline values and block scalars both. Whole-line YAML comments are dropped
 * first, so prose in ci.yml mentioning a command can never become a step.
 *
 * @param {string} workflowText contents of ci.yml
 * @returns {{kind: "script"|"exec"|"node", tokens: string[], identity: string}[]}
 */
export function parseWorkflowInvocations(workflowText) {
  const lines = workflowText.split("\n");
  const shellLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, indent, value] = match;
    if (/^[|>][+-]?$/.test(value.trim())) {
      // Block scalar: everything deeper than the run: key belongs to it.
      const depth = indent.length;
      const block = [];
      i++;
      while (
        i < lines.length &&
        (lines[i].trim() === "" || lines[i].match(/^ */)[0].length > depth)
      ) {
        if (/^\s*#/.test(lines[i])) {
          i++;
          continue;
        }
        block.push(lines[i]);
        i++;
      }
      i--;
      shellLines.push(...block);
    } else {
      shellLines.push(value);
    }
  }

  /**
   * @type {{kind: "script"|"exec"|"node", tokens: string[], identity: string}[]}
   */
  const invocations = [];
  for (const shellLine of shellLines) {
    for (const segment of shellSegments(shellLine)) {
      const tokens = segment.split(/\s+/);
      if (tokens[0] === "pnpm") {
        if (tokens[1] === "exec" && tokens.length > 2) {
          invocations.push({
            kind: "exec",
            tokens: tokens.slice(2),
            identity: `pnpm exec ${tokens.slice(2).join(" ")}`,
          });
        } else if (tokens[1] && !tokens[1].startsWith("-")) {
          invocations.push({ kind: "script", tokens, identity: `pnpm ${tokens[1]}` });
        }
      } else if (tokens[0] === "node" && tokens[1]) {
        invocations.push({ kind: "node", tokens, identity: `node ${tokens[1]}` });
      }
    }
  }
  return invocations;
}

/**
 * Collects the command-shaped spans a reader could act on from CONTRIBUTING:
 * every inline-backtick span, plus every line of every fenced code block.
 * Returned as whitespace-split token arrays so matching can ignore the
 * `pnpm exec` prefix a fence spells out and a table cell omits.
 *
 * @param {string} contributingText contents of CONTRIBUTING.md
 * @returns {string[][]}
 */
export function collectCommandSpans(contributingText) {
  const spans = [];
  let inFence = false;
  for (const line of contributingText.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      for (const segment of shellSegments(line)) {
        spans.push(segment.split(/\s+/));
      }
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      spans.push(match[1].trim().split(/\s+/));
    }
  }
  return spans;
}

/** Targets of a `moon run` token list, `...:` prefixes and project prefixes stripped. */
function moonTargets(tokens) {
  return tokens
    .filter((token) => token.includes(":"))
    .map((token) =>
      token
        .replace(/^\.{3}:/, "")
        .split(":")
        .pop(),
    );
}

/**
 * Whether one collected span satisfies one CI invocation.
 *
 * @param {string[]} span
 * @param {{kind: string, tokens: string[]}} invocation
 * @returns {boolean}
 */
export function spanSatisfiesInvocation(span, invocation) {
  if (invocation.kind === "script") {
    return span[0] === "pnpm" && span[1] === invocation.tokens[1];
  }
  if (invocation.kind === "node") {
    return span[0] === "node" && span[1] === invocation.tokens[1];
  }
  const tokens = invocation.tokens;
  if (tokens[0] === "moon" && tokens[1] === "run") {
    // The document may spell `moon run` without CI's flags, but it must name
    // at least every target CI runs.
    if (!(span[0] === "moon" && span[1] === "run")) return false;
    const needed = new Set(moonTargets(tokens));
    const have = new Set(moonTargets(span));
    for (const target of needed) {
      if (!have.has(target)) return false;
    }
    return needed.size > 0;
  }
  const bare = tokens.filter((token) => !token.startsWith("--"));
  if (span.length < bare.length) return false;
  return bare.every((token, index) => span[index] === token);
}

/**
 * Part 1: every CI invocation is documented or explicitly excepted, and
 * every exception is still earning its place.
 *
 * @param {object} input
 * @param {string} input.contributingText contents of CONTRIBUTING.md
 * @param {string} input.workflowText contents of ci.yml
 * @param {{identity: string, reason: string}[]} [input.exceptions]
 * @returns {{failures: string[], checked: string[]}}
 */
export function evaluateContributing({ contributingText, workflowText, exceptions = EXCEPTIONS }) {
  const failures = [];
  const checked = [];

  const invocations = parseWorkflowInvocations(workflowText);
  if (invocations.length === 0) {
    failures.push(
      `${WORKFLOW_PATH} contains no pnpm or node invocation, so there is no CI ` +
        `roster to hold CONTRIBUTING.md to. Either CI stopped running ` +
        `commands, or this gate's parser no longer reads the file — both ` +
        `need looking at.`,
    );
    return { failures, checked };
  }

  const spans = collectCommandSpans(contributingText);
  if (spans.length === 0) {
    failures.push(
      `${DOC_PATH} contains no command spans, so there is nothing to compare CI's roster against.`,
    );
    return { failures, checked };
  }

  const identities = new Set(invocations.map((invocation) => invocation.identity));
  for (const invocation of invocations) {
    const documented = spans.some((span) => spanSatisfiesInvocation(span, invocation));
    const exception = exceptions.find((entry) => entry.identity === invocation.identity);
    if (!documented && !exception) {
      failures.push(
        `\`${invocation.identity}\` runs in CI (${WORKFLOW_PATH}) but ${DOC_PATH} never ` +
          `mentions it, and it is not in this gate's exception list. Document it ` +
          `for contributors, or add an exception stating why it is not something ` +
          `a local run can carry.`,
      );
    } else if (documented) {
      checked.push(`CI step \`${invocation.identity}\`: documented`);
    }
  }

  for (const exception of exceptions) {
    if (!identities.has(exception.identity)) {
      failures.push(
        `Exception \`${exception.identity}\` matches no step in ${WORKFLOW_PATH} anymore. ` +
          `The step was removed or renamed — delete the exception or repoint it, ` +
          `so the list stays a table of live decisions rather than accumulated pardons.`,
      );
    } else {
      checked.push(`exception \`${exception.identity}\`: still in use`);
    }
  }

  return { failures, checked };
}

/**
 * Parses lefthook.yml's hook blocks: hook name → command key → `run:` value.
 * Deliberately minimal — enough structure for this repository's hook file,
 * whose shape is stable — with the safety property that any reshaping that
 * confuses the parser yields FEWER hooks, and a shorter hook list fails
 * against the document side rather than passing silently.
 *
 * @param {string} lefthookText contents of lefthook.yml
 * @returns {Map<string, Map<string, string>>}
 */
export function parseLefthookHooks(lefthookText) {
  /** @type {Map<string, Map<string, string>>} */
  const hooks = new Map();
  let hook = null;
  let inCommands = false;
  let command = null;
  let commandsIndent = -1;

  for (const raw of lefthookText.split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    if (raw.trim() === "") continue;
    const indent = raw.match(/^ */)[0].length;
    if (indent === 0) {
      const top = /^([A-Za-z][\w-]*):\s*$/.exec(raw);
      if (top) {
        hook = top[1];
        hooks.set(hook, new Map());
      }
      inCommands = false;
      command = null;
      continue;
    }
    if (hook === null) continue;
    if (/^commands:\s*$/.test(raw.trim())) {
      inCommands = true;
      commandsIndent = indent;
      command = null;
      continue;
    }
    if (!inCommands || indent <= commandsIndent) continue;
    const entry = /^([\w.-]+):\s*(.*)$/.exec(raw.trim());
    if (!entry) continue;
    const [, key, inline] = entry;
    if (inline === "") {
      // A bare `key:` at the commands' child level opens a new command block;
      // its properties (`glob`, `run`, `stage_fixed`) carry inline values.
      command = key;
      hooks.get(hook)?.set(command, "");
      continue;
    }
    if (command !== null && key === "run") {
      hooks.get(hook)?.set(command, inline.trim());
    }
  }
  return hooks;
}

/**
 * CONTRIBUTING's hooks table: hook name → the backticked command spans its
 * row claims, in the order written. Scoped to the "What the hooks do"
 * section, and read only after the table's own header row, so no other
 * table in the document can satisfy a hook.
 *
 * @param {string} contributingText contents of CONTRIBUTING.md
 * @returns {Map<string, string[][]>}
 */
export function extractHookBullets(contributingText) {
  const heading = HOOKS_HEADING.exec(contributingText);
  /** @type {Map<string, string[][]>} */
  const rows = new Map();
  if (!heading) return rows;
  const rest = contributingText.slice(heading.index);
  const nextHeading = /\n#{1,6}\s/.exec(rest.slice(1));
  const body = nextHeading ? rest.slice(0, nextHeading.index + 1) : rest;

  let seenHeader = false;
  for (const line of body.split("\n")) {
    if (!seenHeader) {
      if (HOOKS_TABLE_HEADER.test(line)) seenHeader = true;
      continue;
    }
    const row = /^\|\s*`([A-Za-z][\w-]*)`\s*\|(.+)\|?\s*$/.exec(line);
    if (!row) continue;
    if (/^\s*[-\s]+\s*$/.test(row[2])) continue; // alignment row
    const spans = [...row[2].matchAll(/`([^`]+)`/g)].map((match) => match[1].trim().split(/\s+/));
    rows.set(row[1], spans);
  }
  return rows;
}

/**
 * Derives the tool signature a `run:` line executes: the leading tokens that
 * name the binary (and subcommand), stopping at flags and `{…}` placeholders.
 * `pnpm exec prettier --write …` → ["prettier"];
 * `pnpm exec moon projects` → ["moon", "projects"].
 *
 * @param {string} runValue
 * @returns {string[]}
 */
export function runSignature(runValue) {
  let tokens = runValue.trim().split(/\s+/);
  if (tokens[0] === "pnpm") tokens = tokens.slice(1);
  if (tokens[0] === "exec") tokens = tokens.slice(1);
  const signature = [];
  for (const token of tokens) {
    if (token.startsWith("-") || token.includes("{")) break;
    signature.push(token);
  }
  return signature;
}

/**
 * Whether a documented span claims a signature: equal leading tokens, case-
 * insensitive, ignoring the span's own `pnpm [exec]` prefix.
 *
 * @param {string[]} span
 * @param {string[]} signature
 * @returns {boolean}
 */
export function spanMatchesSignature(span, signature) {
  if (signature.length === 0) return false;
  const normalized = [...span];
  if (normalized[0]?.toLowerCase() === "pnpm") normalized.shift();
  if (normalized[0]?.toLowerCase() === "exec") normalized.shift();
  if (normalized.length < signature.length) return false;
  return signature.every(
    (token, index) => normalized[index]?.toLowerCase() === token.toLowerCase(),
  );
}

/**
 * Part 2: lefthook.yml's hooks and CONTRIBUTING's hook documentation carry
 * the same hooks, running the same commands, in both directions.
 *
 * @param {object} input
 * @param {string} input.contributingText contents of CONTRIBUTING.md
 * @param {string} input.lefthookText contents of lefthook.yml
 * @returns {{failures: string[], checked: string[]}}
 */
export function evaluateHooks({ contributingText, lefthookText }) {
  const failures = [];
  const checked = [];

  const hooks = parseLefthookHooks(lefthookText);
  if (hooks.size === 0) {
    failures.push(
      `${LEFTHOOK_PATH} yielded no hook blocks, so there is nothing to compare ` +
        `the documentation against. Either the file stopped declaring hooks — ` +
        `which would silently uninstall every gate it carried — or this gate's ` +
        `parser no longer reads it.`,
    );
    return { failures, checked };
  }

  const rows = extractHookBullets(contributingText);
  if (rows.size === 0) {
    failures.push(
      `${DOC_PATH}'s "What the hooks do" section has no hooks table where this pin ` +
        `expects one (a "| hook | commands it runs … |" table). The section moved ` +
        `or was rewritten — update the document and this gate together.`,
    );
    return { failures, checked };
  }

  for (const hook of hooks.keys()) {
    if (!rows.has(hook)) {
      failures.push(
        `${LEFTHOOK_PATH} declares hook \`${hook}\`, but ${DOC_PATH}'s hooks table ` +
          `has no row for it. A hook contributors were never told about is a gate ` +
          `that surprises at commit time — document it.`,
      );
    }
  }
  for (const [hook, spans] of rows) {
    if (!hooks.has(hook)) {
      failures.push(
        `${DOC_PATH} documents hook \`${hook}\`, but ${LEFTHOOK_PATH} declares no such ` +
          `block. The hook was removed or renamed — update the document, because ` +
          `prose claiming a gate that does not exist is the silent direction this ` +
          `repository refuses.`,
      );
      continue;
    }
    const commands = hooks.get(hook);
    const signatures = [...commands.values()].map((run) => runSignature(run));
    const readable = signatures.filter((signature) => signature.length > 0);
    if (readable.length !== signatures.length) {
      failures.push(
        `Hook \`${hook}\` has a \`run:\` this pin cannot read a tool signature from ` +
          `(${[...commands.entries()]
            .filter(([, run]) => runSignature(run).length === 0)
            .map(([key]) => key)
            .join(", ")}). ` +
          `Extend the signature derivation rather than letting an unreadable gate pass.`,
      );
      continue;
    }
    for (const [key, run] of commands) {
      const signature = runSignature(run);
      if (!spans.some((span) => spanMatchesSignature(span, signature))) {
        failures.push(
          `${LEFTHOOK_PATH}'s \`${hook}\` runs \`${signature.join(" ")}\` (command \`${key}\`), ` +
            `but ${DOC_PATH}'s \`${hook}\` row never names it. The hook gained a gate ` +
            `without documentation.`,
        );
      } else {
        checked.push(
          `hook \`${hook}\` command \`${key}\`: documented as \`${signature.join(" ")}\``,
        );
      }
    }
    for (const span of spans) {
      if (!signatures.some((signature) => spanMatchesSignature(span, signature))) {
        failures.push(
          `${DOC_PATH}'s \`${hook}\` row names \`${span.join(" ")}\`, but no command ` +
            `block in ${LEFTHOOK_PATH}'s \`${hook}\` runs it. The gate was removed or ` +
            `weakened below what the document promises — restore the hook or correct ` +
            `the row.`,
        );
      }
    }
  }

  return { failures, checked };
}

function main() {
  const paths = {
    doc: join(root, DOC_PATH),
    workflow: join(root, WORKFLOW_PATH),
    lefthook: join(root, LEFTHOOK_PATH),
  };
  for (const path of Object.values(paths)) {
    if (!existsSync(path)) {
      console.error(`${path} is missing, and it is one side of the parity this pin enforces.`);
      process.exit(1);
    }
  }

  const contributingText = readFileSync(paths.doc, "utf8");
  const workflowText = readFileSync(paths.workflow, "utf8");
  const lefthookText = readFileSync(paths.lefthook, "utf8");

  const roster = evaluateContributing({ contributingText, workflowText });
  const hooksResult = evaluateHooks({ contributingText, lefthookText });
  const failures = [...roster.failures, ...hooksResult.failures];

  if (roster.checked.length === 0 && hooksResult.checked.length === 0) {
    console.error("Nothing was checked — both halves of the pin produced no coverage.");
    process.exit(1);
  }
  for (const line of [...roster.checked, ...hooksResult.checked]) console.log(`ok   ${line}`);
  if (failures.length > 0) {
    console.error("");
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths —
 * duplicated beside each gate script (see `check-packages.mjs`) because the
 * obvious URL spelling goes false behind a symlinked checkout, and a gate
 * that silently skips its own main is the green-nothing this directory
 * refuses to produce.
 *
 * @param {string | URL} moduleUrl
 * @param {string} [argv1]
 * @returns {boolean}
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();
