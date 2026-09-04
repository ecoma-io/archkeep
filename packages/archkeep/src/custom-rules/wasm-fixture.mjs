/**
 * A core-WebAssembly emitter, for the tests of `./host.mjs`.
 *
 * The host under test refuses bytes for a different reason at every step of
 * the ABI, so its suite needs a rule module per refusal — one with an import,
 * one missing an export, one that traps, one that never returns, one that
 * hands back a range outside its own memory. Committing a `.wasm` blob per
 * case would put the fixtures beyond review (nobody diffs a binary),
 * and generating them from `.wat` would need `wat2wasm` on every machine that
 * runs the suite, which is the toolchain-at-check-time cost `../../AGENTS.md`
 * refuses for the analyzers and this package refuses everywhere else. So the
 * bytes are emitted here, in the language the repository already runs on, and
 * every emitted module is fed to a real `WebAssembly.Module` by the tests —
 * Node's own validator is the oracle, not this file's confidence.
 *
 * ## The two encoding facts a reader needs
 *
 * **Section order is normative.** A module's sections must appear in id order
 * — type(1), import(2), function(3), memory(5), global(6), export(7),
 * start(8), code(10), data(11) — and a validator rejects the module outright
 * when they do not, with a message about the section id rather than about the
 * order. The emitter writes them in that order and nothing here may reorder
 * them.
 *
 * **Every count, size and index is LEB128.** Unsigned for indices and lengths,
 * signed for `i32.const`/`i64.const` operands. A packed range whose pointer is
 * high enough sets bit 63 and therefore encodes as a NEGATIVE i64 — which is
 * exactly the out-of-bounds case the host has to survive, so the signed
 * encoder is load-bearing rather than incidental.
 *
 * ## What the emitted rule does
 *
 * `archkeep_describe` and `archkeep_evaluate` return a constant packed range
 * pointing at a data segment: the module is a canned answer, not a rule. That
 * is the right fixture for a host test — what is under test is the host's
 * reading of the ABI, and a fixture that computed its verdict would put a
 * second implementation of the contract in the way of that. `archkeep_alloc`
 * is a real bump allocator over a mutable global, because the host writes the
 * evidence at the pointer it returns and a fake would not catch a host that
 * wrote to the wrong place.
 */

/** The four exports the ABI requires, so a test can omit one by name. */
export const RULE_EXPORTS = Object.freeze([
  // used by its own test
  "memory",
  "archkeep_alloc",
  "archkeep_describe",
  "archkeep_evaluate",
]);

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const TYPE_I32 = 0x7f;
const TYPE_I64 = 0x7e;
const PAGE_BYTES = 65536;
/** Where the first data segment lands; below it is scratch nothing reads. */
const DATA_ORIGIN = 1024;

/**
 * Unsigned LEB128 — every length, count and index in the format.
 *
 * @param {number} value A non-negative integer.
 * @returns {number[]}
 */
function unsignedLeb(value) {
  const out = [];
  let rest = value >>> 0;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(rest === 0 ? byte : byte | 0x80);
  } while (rest !== 0);
  return out;
}

/**
 * Signed LEB128 — the operand of `i32.const` and `i64.const`.
 *
 * @param {number|bigint} value
 * @returns {number[]}
 */
function signedLeb(value) {
  const out = [];
  let rest = BigInt(value);
  for (;;) {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    const done = (rest === 0n && (byte & 0x40) === 0) || (rest === -1n && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

/**
 * A vector: its element count, then the elements.
 *
 * @param {number[][]} items
 * @returns {number[]}
 */
const vector = (items) => [...unsignedLeb(items.length), ...items.flat()];

/**
 * One section: its id, its content's byte length, then the content.
 *
 * @param {number} id
 * @param {number[]} content
 * @returns {number[]}
 */
const section = (id, content) => [id, ...unsignedLeb(content.length), ...content];

/**
 * A name: its byte length, then its UTF-8 bytes.
 *
 * @param {string} text
 * @returns {number[]}
 */
const encodedName = (text) => {
  const bytes = [...new TextEncoder().encode(text)];
  return [...unsignedLeb(bytes.length), ...bytes];
};

/**
 * The bytes a fixture answers with, from a string or supplied raw.
 *
 * Raw bytes are accepted so a test can hand back a sequence that is not valid
 * UTF-8 at all: "the rule returned bytes that do not decode" is a distinct
 * failure from "the rule returned text that is not JSON", and a string
 * argument can only ever produce the second.
 *
 * @param {string|Uint8Array} payload
 * @returns {number[]}
 */
const payloadBytes = (payload) =>
  typeof payload === "string" ? [...new TextEncoder().encode(payload)] : [...payload];

/**
 * `(ptr << 32) | len`, the ABI's packed return value, as the SIGNED i64 an
 * `i64.const` operand has to be. A pointer with bit 31 set pushes the packed
 * value past 2^63, and encoding that as a positive number produces a varint
 * the validator rejects outright ("extra bits in varint") — so the module
 * would never compile and the host's high-pointer path would never be
 * reached. `asIntN` is the two's-complement wrap that makes the same bits a
 * legal constant.
 *
 * @param {{ptr: number, len: number}} range
 * @returns {bigint}
 */
const packRange = (range) => BigInt.asIntN(64, (BigInt(range.ptr) << 32n) | BigInt(range.len));

/**
 * @typedef {object} RuleModuleOptions
 * @property {string|Uint8Array} [describeJson] What `archkeep_describe` returns.
 * @property {string|Uint8Array} [verdictJson] What `archkeep_evaluate` returns.
 * @property {"return"|"trap"|"loop"|"i32-return"} [describeBehavior] `"trap"`
 *   runs `unreachable`; `"loop"` never returns, which is the fixture that
 *   proves reading a self-description is budgeted like every other call into a
 *   rule; `"i32-return"` declares the wrong result type, so the load half of
 *   the ABI meets the same not-a-BigInt value the evaluate half can.
 * @property {"return"|"trap"|"loop"|"once"|"i32-return"|"echo"|"by-length"} [evaluateBehavior]
 *   `"loop"` never returns (the timeout fixture); `"once"` answers the full
 *   range on the first call of an instance and a zero-length one after, which
 *   is how a test can tell a fresh instance from a reused one; `"i32-return"`
 *   declares the wrong result type, which reaches JavaScript as a number
 *   instead of the BigInt the packed i64 arrives as; `"echo"` returns the
 *   range it was handed, so the verdict a host reads back IS the evidence it
 *   wrote — the only shape that proves the bytes made the round trip;
 *   `"by-length"` answers `verdictJsonAlternate` when the evidence it was
 *   handed is at least `alternateWhenLengthAtLeast` bytes long and
 *   `verdictJson` otherwise — the one shape that lets a two-sided judgment
 *   receive DIFFERENT verdicts per side while both run the identical bytes,
 *   because the sides' evidence bundles differ in size and nothing else about
 *   the module may.
 * @property {string|Uint8Array} [verdictJsonAlternate] The `"by-length"`
 *   behaviour's second answer.
 * @property {number} [alternateWhenLengthAtLeast] The `"by-length"`
 *   behaviour's threshold, in evidence bytes.
 * @property {"bump"|"out-of-bounds"|"trap"} [allocBehavior]
 *   `"out-of-bounds"` hands back a pointer past the end of memory; `"trap"`
 *   runs `unreachable`, which is what a rule whose allocator refuses a size
 *   does — the host never reaches the point of writing anything.
 * @property {{ptr: number, len: number}} [describeRange] Overrides the range
 *   `archkeep_describe` returns, whatever the data segment actually holds.
 * @property {{ptr: number, len: number}} [verdictRange] The same, for
 *   `archkeep_evaluate`.
 * @property {string} [omitExport] One of `RULE_EXPORTS`, left undeclared.
 * @property {string} [misdeclareExport] One of `RULE_EXPORTS`, declared under
 *   the right name and the wrong kind.
 * @property {boolean} [withImport] Declare an imported function, which the
 *   contract grants no module.
 * @property {boolean} [trapOnStart] Give the module a start function that
 *   traps, so instantiation fails rather than compilation — what a rule whose
 *   static initializer panics actually does.
 * @property {number} [memoryPages] Linear memory size, in 64 KiB pages.
 * @property {number} [growPagesOnEvaluate] Pages `archkeep_evaluate` grows its
 *   memory by before it answers — the shape a rule whose memory passes the
 *   limit at instantiation and exceeds it by the time it returns actually has.
 */

/**
 * Emits one rule module's bytes.
 *
 * @param {RuleModuleOptions} [options]
 * @returns {Uint8Array}
 */
export function buildRuleModule(options = {}) {
  // used by its own test
  const {
    describeJson = "{}",
    verdictJson = "{}",
    verdictJsonAlternate = "{}",
    alternateWhenLengthAtLeast = 0,
    describeBehavior = "return",
    evaluateBehavior = "return",
    allocBehavior = "bump",
    describeRange,
    verdictRange,
    omitExport,
    misdeclareExport,
    withImport = false,
    trapOnStart = false,
    memoryPages = 1,
    growPagesOnEvaluate = 0,
  } = options;

  const describeBody = payloadBytes(describeJson);
  const verdictBody = payloadBytes(verdictJson);
  const alternateBody = payloadBytes(verdictJsonAlternate);
  const describeAt = DATA_ORIGIN;
  const verdictAt = describeAt + describeBody.length;
  const alternateAt = verdictAt + verdictBody.length;
  const heapAt = alternateAt + alternateBody.length;

  const describeAnswer = describeRange ?? { ptr: describeAt, len: describeBody.length };
  const verdictAnswer = verdictRange ?? { ptr: verdictAt, len: verdictBody.length };
  const alternateAnswer = { ptr: alternateAt, len: alternateBody.length };

  // Five types, indexed in this order by the function and import sections.
  const types = [
    [0x60, ...vector([]), ...vector([[TYPE_I64]])], // 0 — () -> i64
    [0x60, ...vector([[TYPE_I32]]), ...vector([[TYPE_I32]])], // 1 — (i32) -> i32
    [0x60, ...vector([[TYPE_I32], [TYPE_I32]]), ...vector([[TYPE_I64]])], // 2 — (i32, i32) -> i64
    [0x60, ...vector([]), ...vector([])], // 3 — () -> ()
    [0x60, ...vector([[TYPE_I32], [TYPE_I32]]), ...vector([[TYPE_I32]])], // 4 — (i32, i32) -> i32
    [0x60, ...vector([]), ...vector([[TYPE_I32]])], // 5 — () -> i32
  ];

  const imports = withImport
    ? [[...encodedName("env"), ...encodedName("host_log"), 0x00, ...unsignedLeb(3)]]
    : [];
  // Imported functions occupy the low function indices, so every export below
  // is offset by however many the module declared.
  const definedAt = imports.length;

  // The `"i32-return"` variants are the ones declared with a different result
  // type: the module is perfectly valid wasm, and only the host's reading of
  // what came back can tell that it is not the ABI's packed i64. Each half of
  // the ABI has its own, because each half reads the value on its own path.
  const evaluateType = evaluateBehavior === "i32-return" ? 4 : 2;
  const describeType = describeBehavior === "i32-return" ? 5 : 0;
  const functions = [
    [...unsignedLeb(1)],
    [...unsignedLeb(describeType)],
    [...unsignedLeb(evaluateType)],
  ];
  // A fourth `() -> ()` function, named by the start section below.
  if (trapOnStart) functions.push([...unsignedLeb(3)]);

  const allocInstructions =
    allocBehavior === "trap"
      ? [0x00, 0x0b]
      : allocBehavior === "out-of-bounds"
        ? // Past the end of memory, ignoring the requested length: the host must
          // notice before it writes rather than after it has corrupted a heap.
          [0x41, ...signedLeb(memoryPages * PAGE_BYTES + 16), 0x0b]
        : [
            0x23,
            ...unsignedLeb(0), // global.get $bump — the pointer handed back
            0x23,
            ...unsignedLeb(0), // global.get $bump
            0x20,
            ...unsignedLeb(0), // local.get 0 — the requested length
            0x6a, // i32.add
            0x24,
            ...unsignedLeb(0), // global.set $bump
            0x0b,
          ];

  const describeInstructions =
    describeBehavior === "trap"
      ? [0x00, 0x0b]
      : describeBehavior === "loop"
        ? [...LOOP_FOREVER]
        : describeBehavior === "i32-return"
          ? [0x41, ...signedLeb(0), 0x0b]
          : [0x42, ...signedLeb(packRange(describeAnswer)), 0x0b];

  // The growth runs first, so the answer is computed against whatever memory
  // the call ends up holding — which is the order a real allocator works in.
  const evaluateInstructions = [
    ...(growPagesOnEvaluate === 0
      ? []
      : [0x41, ...signedLeb(growPagesOnEvaluate), 0x40, 0x00, 0x1a]),
    ...evaluateInstructionsFor(verdictAnswer, evaluateBehavior, {
      alternate: alternateAnswer,
      threshold: alternateWhenLengthAtLeast,
    }),
  ];

  const bodies = [allocInstructions, describeInstructions, evaluateInstructions];
  if (trapOnStart) bodies.push([0x00, 0x0b]);
  const code = bodies.map((instructions) => {
    const body = [...unsignedLeb(0), ...instructions]; // no locals
    return [...unsignedLeb(body.length), ...body];
  });

  const globals = [
    [TYPE_I32, 0x01, 0x41, ...signedLeb(heapAt), 0x0b], // 0 — $bump
    [TYPE_I32, 0x01, 0x41, ...signedLeb(0), 0x0b], // 1 — $evaluated
  ];

  /** @type {number[][]} */
  const exports = [];
  const declare = (name, kind, index) => {
    if (omitExport === name) return;
    // A misdeclared symbol is exported as global 0 instead: the name is
    // present and the kind is wrong, which a host checking names alone would
    // wave through and then fail on at the first call.
    if (misdeclareExport === name) {
      exports.push([...encodedName(name), 0x03, ...unsignedLeb(0)]);
      return;
    }
    exports.push([...encodedName(name), kind, ...unsignedLeb(index)]);
  };
  declare("memory", 0x02, 0);
  declare("archkeep_alloc", 0x00, definedAt + 0);
  declare("archkeep_describe", 0x00, definedAt + 1);
  declare("archkeep_evaluate", 0x00, definedAt + 2);

  const data = [
    dataSegment(describeAt, describeBody),
    dataSegment(verdictAt, verdictBody),
    dataSegment(alternateAt, alternateBody),
  ];

  return new Uint8Array([
    ...MAGIC,
    ...section(1, vector(types)),
    ...(imports.length === 0 ? [] : section(2, vector(imports))),
    ...section(3, vector(functions)),
    ...section(5, vector([[0x00, ...unsignedLeb(memoryPages)]])),
    ...section(6, vector(globals)),
    ...section(7, vector(exports)),
    ...(trapOnStart ? section(8, unsignedLeb(definedAt + 3)) : []),
    ...section(10, vector(code)),
    ...section(11, vector(data)),
  ]);
}

/**
 * One active data segment in memory 0 at a constant offset.
 *
 * @param {number} offset
 * @param {number[]} bytes
 * @returns {number[]}
 */
function dataSegment(offset, bytes) {
  return [0x00, 0x41, ...signedLeb(offset), 0x0b, ...vector(bytes.map((byte) => [byte]))];
}

/**
 * A body that never returns. The trailing `unreachable` is load-bearing: the
 * loop never exits, but the validator still type-checks the instructions after
 * it and the function owes its result type there — `unreachable` is the only
 * instruction that satisfies a result it cannot produce, which is what makes
 * this sequence valid for a function of any signature.
 */
const LOOP_FOREVER = Object.freeze([
  0x03,
  0x40, // loop, no result
  0x0c,
  ...unsignedLeb(0), // br 0 — back to the top, forever
  0x0b, // end loop
  0x00, // unreachable
  0x0b,
]);

/**
 * The body of `archkeep_evaluate` for one behaviour.
 *
 * `"once"` answers `answer` the first time an instance is asked and a
 * zero-length range at the same pointer afterwards, driven by a mutable global
 * the call sets on its way out. It is the counter-evidence for instance reuse:
 * two evaluations that both see the full answer prove each got its own
 * instance, and no assertion about the host's internals is needed.
 *
 * `"by-length"` compares the evidence length it was handed (local 1) against
 * a constant threshold and answers one of two constant ranges — the smallest
 * program whose verdict is a function of the evidence, which is what lets one
 * module answer a two-sided judgment differently per side.
 *
 * @param {{ptr: number, len: number}} answer The range a first call returns.
 * @param {"return"|"trap"|"loop"|"once"|"i32-return"|"echo"|"by-length"} behaviour
 * @param {{alternate: {ptr: number, len: number}, threshold: number}} [byLength]
 *   The `"by-length"` behaviour's second answer and its evidence-byte
 *   threshold.
 * @returns {number[]}
 */
function evaluateInstructionsFor(answer, behaviour, byLength) {
  if (behaviour === "trap") return [0x00, 0x0b];
  if (behaviour === "by-length" && byLength !== undefined) {
    return [
      0x20,
      ...unsignedLeb(1), // local.get 1 — the evidence length the host wrote
      0x41,
      ...signedLeb(byLength.threshold), // i32.const threshold
      0x4e, // i32.ge_s
      0x04,
      TYPE_I64, // if (result i64)
      0x42,
      ...signedLeb(packRange(byLength.alternate)),
      0x05, // else
      0x42,
      ...signedLeb(packRange(answer)),
      0x0b, // end if
      0x0b,
    ];
  }
  if (behaviour === "i32-return") return [0x41, ...signedLeb(0), 0x0b];
  if (behaviour === "echo") {
    return [
      0x20,
      ...unsignedLeb(0), // local.get 0 — the pointer the host wrote at
      0xad, // i64.extend_i32_u
      0x42,
      ...signedLeb(32),
      0x86, // i64.shl
      0x20,
      ...unsignedLeb(1), // local.get 1 — the length it wrote
      0xad,
      0x84, // i64.or
      0x0b,
    ];
  }
  if (behaviour === "loop") return [...LOOP_FOREVER];
  if (behaviour === "once") {
    return [
      0x23,
      ...unsignedLeb(1), // global.get $evaluated
      0x04,
      TYPE_I64, // if (result i64)
      0x42,
      ...signedLeb(packRange({ ptr: answer.ptr, len: 0 })),
      0x05, // else
      0x42,
      ...signedLeb(packRange(answer)),
      0x0b, // end if
      0x41,
      ...signedLeb(1),
      0x24,
      ...unsignedLeb(1), // global.set $evaluated
      0x0b,
    ];
  }
  return [0x42, ...signedLeb(packRange(answer)), 0x0b];
}

/**
 * Bytes that are not a WebAssembly module at all.
 *
 * The magic number is deliberately wrong rather than the body truncated: a
 * truncated module still compiles far enough to fail somewhere specific, and
 * what the host's test needs is the plainest possible "these are not module
 * bytes".
 *
 * @returns {Uint8Array}
 */
export function invalidWasmBytes() {
  // used by its own test
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02]);
}
