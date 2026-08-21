/**
 * The core-WebAssembly host: the one place a rule this engine did not write is
 * loaded, executed, and held to the contract
 * (`../../../../docs/adr/0002-custom-rules-one-contract.md`).
 *
 * Two functions, because the two halves fail for unrelated reasons and the
 * failure classes are not interchangeable:
 *
 * - `loadCustomRule` answers "is this the law the policy declared?" — bytes
 *   that hash to what the row pinned, a module that compiles, exports the four
 *   symbols the ABI names, asks for nothing, and can describe itself. Every
 *   failure here is **load class**: the declared law could not be loaded, so
 *   the run refuses the way it refuses a malformed config rather than judging
 *   a tree against a law it never read.
 * - `evaluateCustomRule` answers "what does this rule say about this
 *   evidence?" Every failure here is **evaluate class**: the law loaded, this
 *   rule could not reach a verdict, and the rule's verdict becomes `unknown`
 *   with the cause named — never an approximation, and never a `pass` by
 *   omission (`../governance/verdict.mjs`, invariant I5).
 *
 * Neither ever returns an empty result standing in for "could not look". A
 * failure carries a `reason` naming what went wrong, because the reason is the
 * only thing that separates a rule that judged and found nothing from a rule
 * that never ran (`../../../../AGENTS.md`).
 *
 * ## No imports is the mechanism, not the promise
 *
 * The ADR's "a rule holds no ambient capability" is a property of the module,
 * not of this host's restraint: a core-wasm module can reach nothing it did
 * not import, so a module that imports nothing has no clock, no filesystem, no
 * network and no randomness to reach for. `WebAssembly.Module.imports(module)`
 * is where that is checked, and it is checked before anything is instantiated
 * — a module with an import cannot even be instantiated without the host
 * supplying it, and supplying a stub would be the quiet way to grant the
 * capability the contract refuses.
 *
 * ## Every call into a rule runs in a worker, under a budget
 *
 * `lattice_describe` and `lattice_evaluate` both run inside a
 * `node:worker_threads` Worker, through the one `runInWorker` below, because a
 * rule that never returns has to be stoppable: `worker.terminate()` interrupts
 * a wasm loop, and nothing else in Node can — a wasm loop on the main thread
 * starves the event loop, so a timer set beside it never fires. Reading the
 * self-description is not the cheap, safe half it looks like: it is the first
 * call into code the workspace declared and this engine did not write, and a
 * describe that spins would hang `check` forever, which is worse than any
 * wrong verdict. So the budget covers both, `CUSTOM_RULE_TIMEOUT_MS` by
 * default and injectable per call, and a describe that exceeds it is a LOAD
 * failure naming the budget — the law could not be loaded.
 *
 * The worker's source is a string in this file rather than a second module,
 * for a deployment reason: this package is installed into workspaces it is not
 * part of, often through a symlinked store layout, and a `new Worker(new
 * URL("./worker.mjs", import.meta.url))` would make execution depend on that
 * path resolving in a consumer's tree — the exact class of failure
 * `../../../../scripts/verify-package.mjs` exists to catch. A string has no
 * path to resolve. The cost is that the string is not linted or type-checked,
 * which is paid for by `./host.test.mjs` driving every outcome it can post.
 *
 * ## What crosses back is the claimed range, never the memory
 *
 * The worker unpacks the returned i64, bounds-checks it, and posts back only
 * the bytes the rule actually pointed at. Posting the whole linear memory
 * would have put the packing rule in one place — but the size of that copy is
 * the RULE's decision, not this host's: a rule that grows its memory to a
 * gigabyte would make every call a gigabyte structured clone, and growth is
 * exactly the lever a hostile artifact has. So the claim is capped at
 * `CUSTOM_RULE_MAX_VERDICT_BYTES` before anything is copied, and a claim past
 * the cap is a named failure rather than an allocation.
 *
 * ## Memory has a stated bound, and a declared limit
 *
 * `CUSTOM_RULE_MEMORY_LIMIT_BYTES` is the ADR's "bounded memory", implemented
 * as the honest v1: the worker measures `memory.buffer.byteLength` twice — once
 * after instantiation, once after the call returns — and a measurement past
 * the limit is a named failure. **The declared limit is that those are the
 * only two boundaries at which growth is observed**: a rule that grows to a
 * gigabyte and shrinks back inside one call is not caught, and wasm32 caps how
 * far that can go at 4 GiB regardless. What the two checks do buy is that no
 * rule can END a call holding more than the limit, and no rule can be
 * instantiated holding more.
 *
 * A Worker's `resourceLimits` is deliberately NOT set, and the reason is
 * measured rather than assumed: a worker created with
 * `maxOldGenerationSizeMb: 32` allocated a 64 MiB `WebAssembly.Memory` and
 * touched its last byte without complaint, because a wasm memory's backing
 * store lives outside the V8 heap those options bound. Setting them would
 * bound the wrong thing — the rule's memory would still be unbounded while
 * ordinary runs gained a new way to die — so the byteLength check is the
 * contract.
 *
 * ## One instance per call, never reused
 *
 * Each call builds a fresh `WebAssembly.Instance` inside its own worker, and
 * the instance that read the description is gone before evaluation starts. A
 * reused instance would carry one call's leftover heap into the next one's
 * judgment, which is a rule whose verdict depends on what ran before it — the
 * opposite of the determinism the carrier was chosen for.
 */

import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

// A finding id is spelled the way a rule name is, by the contract's decision
// (`custom/<rule>/<finding>` has one alphabet end to end), so the grammar is
// read from the module that owns it rather than restated here.
import { CUSTOM_RULE_NAME_PATTERN } from "../config.mjs";
import { VERDICTS, isVerdict } from "../governance/verdict.mjs";
import { EVIDENCE_CONTRACT, EVIDENCE_KINDS } from "./evidence.mjs";

/**
 * How long one call into a rule gets to answer, in milliseconds. Ten seconds
 * is far past any real rule over a real workspace and far short of a CI job's
 * patience: the number exists to turn "hung forever" into "named failure", not
 * to price a rule's work.
 */
export const CUSTOM_RULE_TIMEOUT_MS = 10_000;

/**
 * The largest range this host will copy out of a rule's memory. Eight
 * mebibytes is orders of magnitude past any real verdict — the whole evidence
 * bundle for a large workspace is smaller — and it is what stops a claimed
 * length from being an allocation instruction.
 */
export const CUSTOM_RULE_MAX_VERDICT_BYTES = 8 * 1024 * 1024;

/**
 * The most linear memory a rule may hold at the two boundaries the worker
 * measures. 256 MiB is far past what reading an evidence bundle needs and far
 * short of what a workspace's CI runner can absorb without noticing.
 */
export const CUSTOM_RULE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/** The four ABI symbols a rule module must export, and the kind each must be. */
export const REQUIRED_EXPORTS = Object.freeze({
  memory: "memory",
  lattice_alloc: "function",
  lattice_describe: "function",
  lattice_evaluate: "function",
});

/** Every key `lattice_describe` may state. Anything else is refused by name. */
const DESCRIBE_KEYS = Object.freeze(["contract", "name", "needs", "findings"]);

/** Every key a catalogue entry may state. */
const CATALOGUE_KEYS = Object.freeze(["id", "message"]);

/** Every key a verdict may state. */
const VERDICT_KEYS = Object.freeze([
  "contract",
  "verdict",
  "findings",
  "reason",
  "notApplicableReason",
]);

/** Every key a verdict's finding may state. */
const FINDING_KEYS = Object.freeze(["id", "message", "sourceFile", "line", "column", "project"]);

/**
 * The contract version this host speaks, on both sides of the ABI. It is the
 * bundle's own version rather than a second number beside it: the evidence a
 * rule receives, the description it answers with, and the verdict it returns
 * version together, so a rule built for one is built for all three, and two
 * constants would let them drift into a state no rule could be built against.
 */
const CONTRACT = EVIDENCE_CONTRACT;

/**
 * The worker body, driving one call — `describe` or `evaluate` — against a
 * fresh instance.
 *
 * It performs the four steps that must happen next to the instance and cannot
 * be done from anywhere else: instantiate, measure memory, make the call, and
 * read the range the call named. Everything it decides is arithmetic on
 * numbers the instance owns; every WORD a reader ends up seeing is chosen on
 * the main thread from the outcome it posts, so the message table stays where
 * lint, `tsc` and coverage can read it.
 *
 * The evidence write is not guarded by a bounds check of its own — the engine
 * already has one. `Uint8Array.prototype.set` refuses an offset that does not
 * fit, and refuses a pointer that is not an index at all, so the `catch` names
 * the pointer the rule handed back instead of re-deriving a predicate the
 * platform already owns.
 *
 * `api.memory.buffer` is read outside any `try` on purpose. A module with no
 * memory export cannot reach here through `loadCustomRule`, which refuses it
 * by name; one that reaches here anyway throws where nothing catches, the
 * worker posts nothing, and the main thread's "died without answering" case
 * takes it. That is the loud direction — the alternative is a guard that
 * invents a verdict for a module the ABI has no way to drive.
 */
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

function run() {
  const memoryLimit = workerData.memoryLimit;
  const maxBytes = workerData.maxBytes;

  let instance;
  try {
    instance = new WebAssembly.Instance(workerData.module, {});
  } catch (error) {
    return { outcome: "instantiate", detail: String(error && error.message) };
  }
  const api = instance.exports;

  if (api.memory.buffer.byteLength > memoryLimit) {
    return { outcome: "memory", stage: "instantiation", byteLength: api.memory.buffer.byteLength };
  }

  let packed;
  if (workerData.call === "describe") {
    try {
      packed = api.lattice_describe();
    } catch (error) {
      return { outcome: "trap", stage: "lattice_describe", detail: String(error && error.message) };
    }
  } else {
    const evidence = workerData.evidence;
    let pointer;
    try {
      pointer = api.lattice_alloc(evidence.byteLength);
    } catch (error) {
      return { outcome: "trap", stage: "lattice_alloc", detail: String(error && error.message) };
    }
    const view = new Uint8Array(api.memory.buffer);
    try {
      view.set(evidence, pointer);
    } catch (error) {
      return {
        outcome: "unwritable",
        pointer: String(pointer),
        length: evidence.byteLength,
        memoryBytes: view.byteLength,
        detail: String(error && error.message),
      };
    }
    try {
      packed = api.lattice_evaluate(pointer, evidence.byteLength);
    } catch (error) {
      return { outcome: "trap", stage: "lattice_evaluate", detail: String(error && error.message) };
    }
  }

  // Re-read the buffer rather than reusing a view: a call that grew memory
  // detached every view taken before it.
  const byteLength = api.memory.buffer.byteLength;
  if (byteLength > memoryLimit) {
    return { outcome: "memory", stage: "the call", byteLength: byteLength };
  }

  if (typeof packed !== "bigint") {
    return { outcome: "packing", was: typeof packed, value: String(packed) };
  }
  const unsigned = BigInt.asUintN(64, packed);
  const ptr = Number(unsigned >> 32n);
  const len = Number(unsigned & 0xffffffffn);
  if (ptr + len > byteLength) {
    return { outcome: "range", ptr: ptr, len: len, byteLength: byteLength };
  }
  if (len > maxBytes) {
    return { outcome: "oversize", ptr: ptr, len: len, byteLength: byteLength };
  }
  return {
    outcome: "answered",
    ptr: ptr,
    len: len,
    byteLength: byteLength,
    slice: new Uint8Array(api.memory.buffer).slice(ptr, ptr + len),
  };
}

parentPort.postMessage(run());
`;

/** @type {(value: unknown) => value is Record<string, any>} */
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** @type {(value: unknown) => boolean} */
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/** A value's type, for a reason that shows what was actually there. */
function describeValue(value) {
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // A BigInt is the one value `JSON.stringify` THROWS on rather than skipping,
  // and this runs only on a refusal path — a formatter that threw would
  // replace the named reason with a TypeError about something else entirely.
  if (typeof value === "bigint") return `bigint ${value}`;
  return `${typeof value} ${JSON.stringify(value) ?? String(value)}`;
}

/** What an unknown thrown value has to say for itself. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @typedef {object} CustomRuleFailure
 * @property {"load"|"evaluate"} class Which half could not be reached: the law
 *   itself (`"load"` — the run refuses like a malformed config) or this rule's
 *   judgment over it (`"evaluate"` — the rule's verdict becomes `unknown`).
 * @property {string} reason What went wrong, named. Never empty, because an
 *   unnamed failure is indistinguishable from no failure at all.
 */

/**
 * @typedef {object} LoadedCustomRule
 * @property {boolean} ok
 * @property {WebAssembly.Module} [module] The compiled rule, present when `ok`.
 * @property {Record<string, any>} [describe] The validated self-description,
 *   present when `ok`.
 * @property {CustomRuleFailure} [failure] Present when not `ok`.
 */

/**
 * @typedef {object} CustomRuleOutcome
 * @property {boolean} ok
 * @property {Record<string, any>} [verdict] The validated verdict, present
 *   when `ok`.
 * @property {CustomRuleFailure} [failure] Present when not `ok`.
 */

/**
 * @param {"load"|"evaluate"} failureClass
 * @param {string} name
 * @param {string} reason
 * @returns {{ok: false, failure: CustomRuleFailure}}
 */
function failed(failureClass, name, reason) {
  return {
    ok: false,
    failure: { class: failureClass, reason: `custom rule "${name}": ${reason}` },
  };
}

/**
 * A budget both entry points take, refused the same way.
 *
 * A wrong budget is a bug in the pipeline that composed the call, not a fact
 * about the rule — reporting it as the rule's own failure would blame the
 * artifact for the caller's mistake.
 *
 * @param {unknown} timeoutMs
 * @param {string} entryPoint
 * @throws {Error}
 */
function requireBudget(timeoutMs, entryPoint) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `lattice: ${entryPoint} needs a positive timeout in milliseconds, got ` +
        `${describeValue(timeoutMs)}`,
    );
  }
}

/**
 * A range's bytes as a parsed JSON document. Decoding is fatal on purpose: a
 * lossy decode would turn malformed bytes into a document full of replacement
 * characters, which parses or fails for the wrong reason either way.
 *
 * `detail` is `null` on success and a sentence on failure, rather than a
 * discriminated `ok` union: this package's `typecheck` target runs without
 * `strict` (`../../tsconfig.json` argues why), and without `strictNullChecks`
 * a `true`/`false` discriminant widens to `boolean`, so narrowing a union on
 * it silently stops working and every success-branch field read becomes an
 * error. One shape with a nullable `detail` needs no narrowing at all.
 *
 * @param {Uint8Array} bytes
 * @returns {{value: any, detail: string|null}}
 */
function decodeJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return { value: null, detail: `returned bytes that are not UTF-8 (${messageOf(error)})` };
  }
  try {
    return { value: JSON.parse(text), detail: null };
  } catch (error) {
    return { value: null, detail: `returned text that is not JSON (${messageOf(error)})` };
  }
}

/**
 * Keys an object states that the contract has no place for.
 *
 * @param {Record<string, any>} document
 * @param {readonly string[]} allowed
 * @returns {string[]}
 */
const unknownKeys = (document, allowed) =>
  Object.keys(document).filter((key) => !allowed.includes(key));

/**
 * Why a worker run carries no answer, or `null` when it carries one.
 *
 * One table for both entry points, because the ways a call into a rule can go
 * wrong do not depend on which call it was — only the CLASS does, and that is
 * the caller's to decide. A second copy of these sentences under `load` would
 * be the one that drifted.
 *
 * @param {WorkerOutcome} outcome
 * @param {{call: string, timeoutMs: number}} run The exported symbol that was
 *   called, and the budget it was given.
 * @returns {string|null}
 */
function outcomeReason(outcome, { call, timeoutMs }) {
  switch (outcome.outcome) {
    case "timeout":
      return (
        `${call} did not return within its ${timeoutMs}ms budget and was terminated — a rule ` +
        `that never answers is a run that never ends`
      );
    case "instantiate":
      return `the module could not be instantiated (${outcome.detail})`;
    case "trap":
      return `${outcome.stage} trapped (${outcome.detail})`;
    case "unwritable":
      return (
        `lattice_alloc answered ${outcome.pointer} for ${outcome.length} evidence bytes, which ` +
        `does not fit in its ${outcome.memoryBytes} bytes of linear memory (${outcome.detail})`
      );
    case "memory":
      return (
        `it held ${outcome.byteLength} bytes of linear memory after ${outcome.stage}, past the ` +
        `${CUSTOM_RULE_MEMORY_LIMIT_BYTES}-byte limit — a rule's memory is bounded so a hostile ` +
        `artifact cannot make the machine that enforces the law the thing it takes down`
      );
    case "packing":
      return (
        `${call} returned ${outcome.was} ${outcome.value}, not the packed i64 the ABI fixes — a ` +
        `function declared with any other result type reaches this host as something that is ` +
        `not a BigInt`
      );
    case "range":
      return (
        `${call} returned the range ${outcome.ptr}..${outcome.ptr + outcome.len}, which is ` +
        `outside its own ${outcome.byteLength} bytes of linear memory — bytes this host cannot ` +
        `read are bytes nothing can be concluded from`
      );
    case "oversize":
      return (
        `${call} claimed ${outcome.len} bytes, past the ${CUSTOM_RULE_MAX_VERDICT_BYTES}-byte ` +
        `cap this host will copy out of a rule — a claimed length is a number the rule chose, ` +
        `and honouring it unchecked would make it an allocation instruction`
      );
    case "died":
      return (
        `the worker running it ${outcome.detail} before it answered — no answer was produced, ` +
        `and an absent answer is never read as a passing one`
      );
    default:
      return null;
  }
}

/**
 * Loads one declared rule from its artifact bytes.
 *
 * Reading the artifact is the caller's, not this module's: the commands layer
 * owns files and this host owns bytes, the same split `../rules/README.md`
 * states for the boundary rules. So an unreadable artifact is a load failure
 * the caller reports; everything from the hash onward is decided here.
 *
 * It is asynchronous because reading the self-description means calling into
 * the artifact, and every call into an artifact is budgeted — see this
 * module's header.
 *
 * @param {{name: string, artifactBytes: Uint8Array, declaredSha256: string,
 *   timeoutMs?: number}} declared
 * @returns {Promise<LoadedCustomRule>}
 * @throws {Error} when the budget is not a positive number of milliseconds.
 */
export async function loadCustomRule({
  name,
  artifactBytes,
  declaredSha256,
  timeoutMs = CUSTOM_RULE_TIMEOUT_MS,
}) {
  requireBudget(timeoutMs, "loadCustomRule");
  const refuse = (reason) => failed("load", name, reason);

  if (!ArrayBuffer.isView(artifactBytes)) {
    return refuse(
      `the artifact was handed over as ${describeValue(artifactBytes)} rather than a view of its ` +
        `bytes — this host takes the artifact's bytes, never a path`,
    );
  }

  const computed = createHash("sha256").update(artifactBytes).digest("hex");
  if (computed !== declaredSha256) {
    return refuse(
      `the artifact hashes to ${computed}, and the policy pinned ${describeValue(declaredSha256)} ` +
        `— the hash is what makes "the law CI ran is the law review saw" checkable, so a ` +
        `mismatch is a refusal, never a quieter law`,
    );
  }

  /** @type {WebAssembly.Module} */
  let module;
  try {
    // The cast is a type-checker fact, not a runtime one: TypeScript 5.7
    // narrowed `BufferSource` to `ArrayBufferView<ArrayBuffer>`, which the
    // `Buffer` a caller gets back from `readFile` (an `ArrayBufferLike` view,
    // often pooled at a non-zero offset) does not satisfy — while the runtime
    // accepts it and has since wasm shipped. Reading `.buffer` instead would
    // be the wrong fix twice over: it would type-check and it would hash a
    // pooled buffer's other tenants.
    module = new WebAssembly.Module(/** @type {BufferSource} */ (artifactBytes));
  } catch (error) {
    return refuse(`the artifact is not a valid WebAssembly module (${messageOf(error)})`);
  }

  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    const named = imports.map((entry) => `${entry.module}.${entry.name}`).join(", ");
    return refuse(
      `the module declares ${imports.length} import(s) (${named}) and the contract grants no ` +
        `imports — a rule reaches nothing it did not import, which is what makes "no ambient ` +
        `capability" a property of the module rather than a promise about this host`,
    );
  }

  const declaredExports = new Map(
    WebAssembly.Module.exports(module).map((entry) => [entry.name, entry.kind]),
  );
  for (const [required, kind] of Object.entries(REQUIRED_EXPORTS)) {
    const found = declaredExports.get(required);
    if (found === undefined) {
      return refuse(
        `the module exports no ${kind} named "${required}" — the ABI requires ` +
          `${Object.keys(REQUIRED_EXPORTS).join(", ")}, and a rule missing one cannot be driven ` +
          `at all`,
      );
    }
    if (found !== kind) {
      return refuse(`the module exports "${required}" as a ${found}, and the ABI needs a ${kind}`);
    }
  }

  const answered = await runInWorker({ module, call: "describe", timeoutMs });
  const failure = outcomeReason(answered, { call: "lattice_describe", timeoutMs });
  if (failure !== null) return refuse(failure);

  const document = decodeJson(answered.slice);
  if (document.detail !== null) return refuse(`lattice_describe ${document.detail}`);

  const violation = describeViolation(document.value, name);
  if (violation !== null) return refuse(violation);

  return { ok: true, module, describe: document.value };
}

/**
 * What is wrong with a rule's self-description, or `null`.
 *
 * `needs` is deliberately NOT judged here — see `needsViolation`.
 *
 * @param {unknown} document
 * @param {string} declaredName
 * @returns {string|null}
 */
function describeViolation(document, declaredName) {
  if (!isPlainObject(document)) {
    return `lattice_describe returned ${describeValue(document)}, not a self-description object`;
  }

  const unknown = unknownKeys(document, DESCRIBE_KEYS);
  if (unknown.length > 0) {
    return (
      `lattice_describe states ${unknown.map((key) => `"${key}"`).join(", ")}, which contract ` +
      `${CONTRACT} has no place for — a key this host does not read is a claim the rule's author ` +
      `believes is being honoured`
    );
  }

  if (document.contract !== CONTRACT) {
    return (
      `lattice_describe states contract ${describeValue(document.contract)}, and this engine ` +
      `speaks contract ${CONTRACT} — a rule built against another contract is not approximated`
    );
  }

  if (document.name !== declaredName) {
    return (
      `lattice_describe calls itself ${describeValue(document.name)}, and the policy declared it ` +
      `"${declaredName}" — the declared name is what every finding is namespaced under, so the ` +
      `two must be one name`
    );
  }

  return catalogueViolation(document.findings);
}

/**
 * What is wrong with a rule's findings catalogue, or `null`.
 *
 * The catalogue is the reason this is checked at load rather than when a
 * finding arrives: it is the reportingDescriptor set a SARIF result resolves
 * against, so a rule whose catalogue is malformed produces findings that
 * cannot be rendered — discovered on the run that finally fails, long after
 * the rule was reviewed.
 *
 * @param {unknown} findings
 * @returns {string|null}
 */
function catalogueViolation(findings) {
  if (!Array.isArray(findings)) {
    return `lattice_describe states findings ${describeValue(findings)}, not a catalogue array`;
  }
  if (findings.length === 0) {
    return (
      `lattice_describe states an empty findings catalogue — a rule that can name nothing it ` +
      `might find can never report one, and would read as permanently clean`
    );
  }

  const seen = new Set();
  for (const [index, entry] of findings.entries()) {
    if (!isPlainObject(entry)) {
      return `lattice_describe findings[${index}] is ${describeValue(entry)}, not an object`;
    }
    const unknown = unknownKeys(entry, CATALOGUE_KEYS);
    if (unknown.length > 0) {
      return (
        `lattice_describe findings[${index}] states ` +
        `${unknown.map((key) => `"${key}"`).join(", ")}, and a catalogue entry carries ` +
        `${CATALOGUE_KEYS.join(" and ")} only`
      );
    }
    if (typeof entry.id !== "string" || !CUSTOM_RULE_NAME_PATTERN.test(entry.id)) {
      return (
        `lattice_describe findings[${index}].id is ${describeValue(entry.id)}, and a finding id ` +
        `is lowercase words joined by single dashes (${CUSTOM_RULE_NAME_PATTERN.source})`
      );
    }
    if (seen.has(entry.id)) {
      return (
        `lattice_describe declares the finding id "${entry.id}" twice — two entries under one id ` +
        `make the namespaced id ambiguous, and a report would resolve findings to whichever ` +
        `entry it happened to read last`
      );
    }
    seen.add(entry.id);
    if (!isNonEmptyString(entry.message)) {
      return (
        `lattice_describe findings[${index}].message is ${describeValue(entry.message)} — a ` +
        `catalogue entry with no message renders as a finding that says nothing`
      );
    }
  }
  return null;
}

/**
 * What is wrong with a rule's declared evidence needs, or `null`.
 *
 * This is evaluate class rather than load class, and the split is the ADR's:
 * a rule that asks for a kind this engine cannot supply has loaded perfectly
 * well, and what it cannot do is judge — so it becomes an `unknown` verdict
 * with the gap named, never an approximation over the kinds that were
 * available. The roster it is checked against is `EVIDENCE_KINDS`, which lives
 * beside the code that produces the kinds (`./evidence.mjs`).
 *
 * @param {unknown} describe
 * @returns {string|null}
 */
function needsViolation(describe) {
  const needs = isPlainObject(describe) ? describe.needs : undefined;
  if (!Array.isArray(needs)) {
    return (
      `it declares needs ${describeValue(needs)}, not an array of evidence kinds — a rule that ` +
      `cannot state what it needs cannot be handed it`
    );
  }
  for (const kind of needs) {
    if (!EVIDENCE_KINDS.includes(kind)) {
      return (
        `it needs the evidence kind ${describeValue(kind)}, which contract ${CONTRACT} does not ` +
        `carry — this engine supplies ${EVIDENCE_KINDS.join(", ")}, and judging over the kinds it ` +
        `does hold would be a verdict computed from evidence the rule said was not enough`
      );
    }
  }
  return null;
}

/**
 * Runs one rule over one evidence bundle, in its own worker, under a budget.
 *
 * @param {{module: WebAssembly.Module, describe: Record<string, any>,
 *   evidenceBytes: Uint8Array, timeoutMs?: number}} run
 * @returns {Promise<CustomRuleOutcome>}
 * @throws {Error} when the caller's own arguments are wrong — bytes that are
 *   not bytes, a budget that is not a positive number. Those are bugs in the
 *   pipeline that composed the call, not facts about the rule, and reporting
 *   them as the rule's `unknown` would blame the wrong thing.
 */
export async function evaluateCustomRule({
  module,
  describe,
  evidenceBytes,
  timeoutMs = CUSTOM_RULE_TIMEOUT_MS,
}) {
  if (!(evidenceBytes instanceof Uint8Array)) {
    throw new Error(
      `lattice: evaluateCustomRule needs the evidence bundle's bytes, got ` +
        `${describeValue(evidenceBytes)} — serializeEvidenceBundle (./evidence.mjs) produces them`,
    );
  }
  requireBudget(timeoutMs, "evaluateCustomRule");

  const name = isPlainObject(describe) ? describe.name : undefined;
  const refuse = (reason) => failed("evaluate", String(name), reason);

  const needs = needsViolation(describe);
  if (needs !== null) return refuse(needs);

  const answered = await runInWorker({
    module,
    call: "evaluate",
    evidence: evidenceBytes,
    timeoutMs,
  });
  const failure = outcomeReason(answered, { call: "lattice_evaluate", timeoutMs });
  if (failure !== null) return refuse(failure);

  const document = decodeJson(answered.slice);
  if (document.detail !== null) return refuse(`lattice_evaluate ${document.detail}`);

  const violation = verdictViolation(document.value, describe);
  if (violation !== null) return refuse(`it returned a hollow verdict — ${violation}`);

  return { ok: true, verdict: document.value };
}

/**
 * What is wrong with a verdict, or `null`.
 *
 * The obligations are the four-state vocabulary's, not this host's invention
 * (`../governance/verdict.mjs` states I1–I5 and `../report/evidence.mjs`
 * enforces the same ones for a command's own decision): `fail` names what
 * failed, `pass` names nothing, `unknown` names why it could not tell,
 * `not_applicable` names why it did not apply. A rule that breaks one of them
 * has returned a shape, not a judgment — hence "hollow", and hence a refusal
 * rather than a best-effort read.
 *
 * The `reason` / `notApplicableReason` checks run in BOTH directions: a
 * `reason` on a passing verdict is a rule that meant to say `unknown` and
 * said `pass`, which is precisely the failure the vocabulary exists to
 * refuse, so it is named rather than ignored.
 *
 * @param {unknown} verdict
 * @param {Record<string, any>} describe
 * @returns {string|null}
 */
function verdictViolation(verdict, describe) {
  if (!isPlainObject(verdict)) {
    return `it is ${describeValue(verdict)}, not a verdict object`;
  }

  const unknown = unknownKeys(verdict, VERDICT_KEYS);
  if (unknown.length > 0) {
    return (
      `it states ${unknown.map((key) => `"${key}"`).join(", ")}, which contract ${CONTRACT} has ` +
      `no place for`
    );
  }

  if (verdict.contract !== CONTRACT) {
    return (
      `it states contract ${describeValue(verdict.contract)}, and this engine speaks contract ` +
      `${CONTRACT}`
    );
  }

  if (!isVerdict(verdict.verdict)) {
    return (
      `it states the verdict ${describeValue(verdict.verdict)}, and the vocabulary is ` +
      `${VERDICTS.join(", ")}`
    );
  }

  if (!Array.isArray(verdict.findings)) {
    return (
      `it states findings ${describeValue(verdict.findings)} — every verdict states its findings, ` +
      `and a clean rule states the empty list rather than leaving the field out`
    );
  }

  const catalogue = new Set(
    (Array.isArray(describe.findings) ? describe.findings : []).map((entry) => entry?.id),
  );
  for (const [index, finding] of verdict.findings.entries()) {
    const violation = findingViolation(finding, index, catalogue);
    if (violation !== null) return violation;
  }

  if (verdict.verdict === "fail" && verdict.findings.length === 0) {
    return `it fails and names no finding, so nothing says what failed`;
  }
  if (verdict.verdict === "pass" && verdict.findings.length > 0) {
    return (
      `it passes and carries ${verdict.findings.length} finding(s) — "pass" and "fail" cannot ` +
      `both be true of the same rule, and the finding is the half that is evidenced`
    );
  }

  return (
    reasonViolation(verdict, "reason", "unknown") ??
    reasonViolation(verdict, "notApplicableReason", "not_applicable")
  );
}

/**
 * Whether a verdict's reason field and its verdict agree, in both directions.
 *
 * @param {Record<string, any>} verdict
 * @param {"reason"|"notApplicableReason"} field
 * @param {"unknown"|"not_applicable"} requiredFor
 * @returns {string|null}
 */
function reasonViolation(verdict, field, requiredFor) {
  const present = isNonEmptyString(verdict[field]);
  if (verdict.verdict === requiredFor && !present) {
    return (
      `it is "${requiredFor}" and its ${field} is ${describeValue(verdict[field])} — ` +
      `"${requiredFor}" is a claim about what could not be established, and a reader has to be ` +
      `told which`
    );
  }
  if (verdict.verdict !== requiredFor && verdict[field] !== undefined) {
    return (
      `it is "${verdict.verdict}" and carries a ${field}, which only the "${requiredFor}" ` +
      `verdict carries — a rule that meant "${requiredFor}" and said "${verdict.verdict}" would ` +
      `be read as having decided`
    );
  }
  return null;
}

/**
 * What is wrong with one finding, or `null`.
 *
 * @param {unknown} finding
 * @param {number} index
 * @param {Set<unknown>} catalogue Ids `lattice_describe` declared.
 * @returns {string|null}
 */
function findingViolation(finding, index, catalogue) {
  if (!isPlainObject(finding)) {
    return `findings[${index}] is ${describeValue(finding)}, not a finding object`;
  }

  const unknown = unknownKeys(finding, FINDING_KEYS);
  if (unknown.length > 0) {
    return (
      `findings[${index}] states ${unknown.map((key) => `"${key}"`).join(", ")}, and a finding ` +
      `carries ${FINDING_KEYS.join(", ")} only`
    );
  }

  if (!catalogue.has(finding.id)) {
    return (
      `findings[${index}].id is ${describeValue(finding.id)}, which the rule's own catalogue ` +
      `does not declare — a finding a report cannot resolve to a catalogue entry is a finding ` +
      `SARIF drops`
    );
  }
  if (!isNonEmptyString(finding.message)) {
    return `findings[${index}].message is ${describeValue(finding.message)}`;
  }
  if (finding.sourceFile !== undefined && !isNonEmptyString(finding.sourceFile)) {
    return `findings[${index}].sourceFile is ${describeValue(finding.sourceFile)}`;
  }
  if (finding.project !== undefined && !isNonEmptyString(finding.project)) {
    return `findings[${index}].project is ${describeValue(finding.project)}`;
  }

  for (const axis of ["line", "column"]) {
    if (finding[axis] === undefined) continue;
    if (finding.sourceFile === undefined) {
      return (
        `findings[${index}] states a ${axis} and no sourceFile — a position with no file sends a ` +
        `reader to a line in nothing`
      );
    }
    if (!Number.isInteger(finding[axis]) || finding[axis] < 1) {
      return (
        `findings[${index}].${axis} is ${describeValue(finding[axis])}, and positions are 1-based ` +
        `integers (../analysis/contract.md fixes that for every position this tool reports)`
      );
    }
  }

  return null;
}

/**
 * One worker run's raw result. It is a single flat shape rather than a
 * discriminated union for the reason `decodeJson` states: without
 * `strictNullChecks` the literal discriminants widen and narrowing stops
 * working, so a union here would type-check as if every field were always
 * present — which is worse than not modelling the variants at all.
 *
 * @typedef {object} WorkerOutcome
 * @property {"answered"|"instantiate"|"trap"|"unwritable"|"memory"|"packing"|"range"|"oversize"|"died"|"timeout"} outcome
 * @property {Uint8Array} [slice] `"answered"`: exactly the bytes the rule pointed at.
 * @property {number} [ptr] The pointer half of the packed range.
 * @property {number} [len] The length half of the packed range.
 * @property {number} [byteLength] The linear memory's size when it was measured.
 * @property {string} [stage] `"trap"`: which export trapped. `"memory"`: which
 *   of the two boundaries the measurement was taken at.
 * @property {string} [was] `"packing"`: the type that arrived instead of a BigInt.
 * @property {string} [value] `"packing"`: what that value said for itself.
 * @property {string} [pointer] `"unwritable"`: what `lattice_alloc` answered.
 * @property {number} [length] `"unwritable"`: how many evidence bytes there were.
 * @property {number} [memoryBytes] `"unwritable"`: how much memory there was.
 * @property {string} [detail] The engine's own words, where it had any.
 */

/**
 * One call into a rule, in its own worker, settled exactly once.
 *
 * Every listener routes through `settle`, and the guard is what makes the
 * budget mean something: `terminate()` makes the worker exit, so without it
 * the `exit` listener would answer the timeout race with "exited with code 1"
 * and the reason a reader saw would name the symptom instead of the budget.
 * `exit` still has a case of its own, because a worker that dies without
 * posting anything is the silent shape this whole module is built against.
 *
 * @param {{module: WebAssembly.Module, call: "describe"|"evaluate",
 *   evidence?: Uint8Array, timeoutMs: number}} run
 * @returns {Promise<WorkerOutcome>}
 */
function runInWorker({ module, call, evidence, timeoutMs }) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        module,
        call,
        evidence,
        maxBytes: CUSTOM_RULE_MAX_VERDICT_BYTES,
        memoryLimit: CUSTOM_RULE_MEMORY_LIMIT_BYTES,
      },
    });

    let settled = false;
    /** @param {WorkerOutcome} outcome */
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      // Resolve only once the thread is actually gone, rather than firing
      // `terminate()` off and answering immediately. A call that returned
      // while its worker was still winding down would leave a thread running
      // past the run that owns it — measured here as a vitest child exiting
      // before it flushed its coverage file, and in a consumer's tree it
      // would be a `check` that had answered but not yet ended. The same
      // callback takes both settlements: `terminate()` resolves with the exit
      // code and does not reject, and answering the caller is the right move
      // either way.
      const answer = () => resolve(outcome);
      worker.terminate().then(answer, answer);
    };

    const budget = setTimeout(() => settle({ outcome: "timeout" }), timeoutMs);
    worker.on("message", settle);
    worker.on("error", (error) =>
      settle({ outcome: "died", detail: `failed (${messageOf(error)})` }),
    );
    worker.on("exit", (code) => settle({ outcome: "died", detail: `exited with code ${code}` }));
  });
}
