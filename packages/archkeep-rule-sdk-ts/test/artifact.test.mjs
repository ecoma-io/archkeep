/**
 * The committed artifact: its digest, its shape, and the exact bytes it answers
 * with across the ABI.
 *
 * `../examples/forbidden-tag-dependency.wasm` is a binary in a repository that
 * reviews text, and `….wasm.sha256` beside it is the string a `customRules` row
 * pins it by — the mechanism that makes "the law CI ran is the law review saw"
 * checkable (`../../../docs/adr/0002-custom-rules-one-contract.md`). Two files
 * that must agree and no gate comparing them is a pair that silently stops
 * agreeing the first time one of them is rebuilt alone, and the failure surfaces
 * in a CONSUMER's tree as a load error naming a hash nobody here can explain.
 *
 * This file drives the module DIRECTLY — `new WebAssembly.Instance`, write the
 * bundle, unpack the `i64` — where `./golden.test.mjs` drives it through the
 * engine's real host. The split is deliberate and both halves are needed: the
 * host parses the verdict before handing it over, so the only place the BYTES
 * that cross the ABI can be pinned is here, and the only place the host's
 * refusals can be exercised is there. A change that reordered or renamed a
 * verdict key would still be a change to what the host reads, and this file is
 * what notices it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

/** @param {string} relative @returns {string} */
const packagePath = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

const ARTIFACT = packagePath("examples/forbidden-tag-dependency.wasm");
const DIGEST_FILE = packagePath("examples/forbidden-tag-dependency.wasm.sha256");

/** The four symbols the ABI names, and the kind each must be. */
const REQUIRED_EXPORTS = {
  memory: "memory",
  archkeep_alloc: "function",
  archkeep_describe: "function",
  archkeep_evaluate: "function",
};

test("the committed artifact hashes to the recorded digest", () => {
  const bytes = readFileSync(ARTIFACT);
  const recorded = readFileSync(DIGEST_FILE, "utf8").trim();

  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    recorded,
    "the committed artifact and its recorded digest have drifted apart — rebuild both with " +
      "./rebuild-example.sh rather than editing either one",
  );
  assert.equal(recorded.length, 64, "a sha256 is 64 hex characters");
  assert.match(
    recorded,
    /^[0-9a-f]{64}$/,
    "the recorded digest must be lowercase hex, which is how a policy row spells one",
  );
});

test("the committed artifact opens with the wasm magic", () => {
  // A four-byte check that catches the failures a digest cannot describe: a
  // truncated file, a text placeholder, a pointer left by a large-file filter.
  // All three would hash consistently and load as nothing.
  const bytes = readFileSync(ARTIFACT);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    "the artifact does not open with the wasm magic and version 1",
  );
});

test("the committed artifact declares no imports at all", () => {
  // The mechanism behind "a rule holds no ambient capability", checked on the
  // bytes rather than on the build flags that produced them: an AssemblyScript
  // module imports `env.abort` unless it is built with `--use abort=`
  // (`../rebuild-example.sh` argues the flag), and the host refuses any module
  // whose import section is non-empty. A rebuild that dropped the flag would
  // produce an artifact that still passes every other test in this file.
  const module = new WebAssembly.Module(readFileSync(ARTIFACT));
  assert.deepEqual(
    WebAssembly.Module.imports(module),
    [],
    "the artifact declares an import, and the contract grants none",
  );
});

test("the committed artifact exports the four symbols the ABI names", () => {
  const module = new WebAssembly.Module(readFileSync(ARTIFACT));
  const declared = new Map(
    WebAssembly.Module.exports(module).map((entry) => [entry.name, entry.kind]),
  );
  for (const [name, kind] of Object.entries(REQUIRED_EXPORTS)) {
    assert.equal(declared.get(name), kind, `the artifact exports no ${kind} named "${name}"`);
  }
});

/**
 * One call into the module, driven the way the host drives it.
 *
 * @param {WebAssembly.Instance} instance
 * @param {bigint} packed The `i64` an ABI export answered with.
 * @returns {string} The UTF-8 text at the range it named.
 */
function readPacked(instance, packed) {
  assert.equal(typeof packed, "bigint", "an ABI export answers with the packed i64");
  const unsigned = BigInt.asUintN(64, packed);
  const pointer = Number(unsigned >> 32n);
  const length = Number(unsigned & 0xffffffffn);
  const memory = /** @type {WebAssembly.Memory} */ (instance.exports.memory);
  assert.ok(
    pointer + length <= memory.buffer.byteLength,
    `the range ${pointer}..${pointer + length} leaves the module's own linear memory`,
  );
  return Buffer.from(new Uint8Array(memory.buffer).slice(pointer, pointer + length)).toString(
    "utf8",
  );
}

/**
 * The module's answer over one evidence document, as the raw bytes it returned.
 *
 * @param {string} fixture A file under `../fixtures/`.
 * @returns {string}
 */
function evaluateRaw(fixture) {
  const module = new WebAssembly.Module(readFileSync(ARTIFACT));
  const instance = new WebAssembly.Instance(module, {});
  const evidence = readFileSync(packagePath(`fixtures/${fixture}`));
  const alloc = /** @type {(len: number) => number} */ (instance.exports.archkeep_alloc);
  const pointer = alloc(evidence.byteLength);
  new Uint8Array(/** @type {WebAssembly.Memory} */ (instance.exports.memory).buffer).set(
    evidence,
    pointer,
  );
  const evaluate = /** @type {(ptr: number, len: number) => bigint} */ (
    instance.exports.archkeep_evaluate
  );
  return readPacked(instance, evaluate(pointer, evidence.byteLength));
}

test("the describe bytes are the ones that cross the ABI", () => {
  const module = new WebAssembly.Module(readFileSync(ARTIFACT));
  const instance = new WebAssembly.Instance(module, {});
  const describe = /** @type {() => bigint} */ (instance.exports.archkeep_describe);
  assert.equal(
    readPacked(instance, describe()),
    '{"contract":1,"name":"forbidden-tag-dependency","needs":["model","graph"],"findings":' +
      '[{"id":"dependency-on-forbidden-tag","message":"a project depends on a project carrying ' +
      'the forbidden tag"}]}',
  );
});

test("the verdict bytes are the ones that cross the ABI", () => {
  // The one place the exact BYTES are pinned rather than the document.
  // `./golden.test.mjs` compares parsed verdicts, because key order is a
  // serializer's business and a conformance suite four SDKs must reproduce
  // cannot turn on one of them. This test exists anyway: the bytes are what
  // crosses the ABI, and it is byte-for-byte the string the Rust SDK's own
  // suite pins over the same fixture
  // (`../../archkeep-rule-sdk-rust/tests/golden.rs`).
  assert.equal(
    evaluateRaw("edge-into-forbidden-tag.json"),
    '{"contract":1,"verdict":"fail","findings":[{"id":"dependency-on-forbidden-tag","message":' +
      '"beta depends on gamma, which carries \\"layer-infrastructure\\"","sourceFile":' +
      '"packages/beta/src/store.rs","project":"beta"}]}',
  );
});

test("a bundle the rule cannot read becomes unknown rather than pass", () => {
  // The silent direction, at the ABI. Driven here rather than through the host
  // because the host writes a bundle IT built, and what has to be proven is
  // what the module does with bytes that are not one.
  const module = new WebAssembly.Module(readFileSync(ARTIFACT));
  for (const bytes of [
    Buffer.from("not json at all", "utf8"),
    Buffer.from('{"contract":1,"rule":', "utf8"),
    Buffer.from('{"contract":7,"rule":{"name":"x","params":{}}}', "utf8"),
    Buffer.from("", "utf8"),
  ]) {
    const instance = new WebAssembly.Instance(module, {});
    const alloc = /** @type {(len: number) => number} */ (instance.exports.archkeep_alloc);
    const pointer = alloc(Math.max(bytes.byteLength, 1));
    new Uint8Array(/** @type {WebAssembly.Memory} */ (instance.exports.memory).buffer).set(
      bytes,
      pointer,
    );
    const evaluate = /** @type {(ptr: number, len: number) => bigint} */ (
      instance.exports.archkeep_evaluate
    );
    const verdict = JSON.parse(readPacked(instance, evaluate(pointer, bytes.byteLength)));
    assert.equal(
      verdict.verdict,
      "unknown",
      `${JSON.stringify(bytes.toString("utf8"))} did not become an unknown verdict`,
    );
    assert.ok(
      typeof verdict.reason === "string" && verdict.reason.length > 0,
      "an unknown verdict names what could not be established",
    );
    assert.deepEqual(verdict.findings, []);
  }
});
