import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildEvidenceBundle, serializeEvidenceBundle } from "./evidence.mjs";
import {
  CUSTOM_RULE_MAX_VERDICT_BYTES,
  CUSTOM_RULE_MEMORY_LIMIT_BYTES,
  CUSTOM_RULE_TIMEOUT_MS,
  evaluateCustomRule,
  loadCustomRule,
} from "./host.mjs";
import { RULE_EXPORTS, buildRuleModule, invalidWasmBytes } from "./wasm-fixture.mjs";

const RULE = "no-app-to-ring";
const FINDING = "reached-ring";

/** A well-formed self-description, with one key overridable at a time. */
const selfDescription = (overrides = {}) => ({
  contract: 1,
  name: RULE,
  needs: ["model", "graph", "imports", "policy"],
  findings: [{ id: FINDING, message: "the app layer reached a ring internal" }],
  ...overrides,
});

/** A well-formed verdict, with one key overridable at a time. */
const verdictOf = (overrides = {}) => ({
  contract: 1,
  verdict: "pass",
  findings: [],
  ...overrides,
});

/** The bytes a real run would hand a rule. */
const EVIDENCE = serializeEvidenceBundle(
  buildEvidenceBundle({
    rule: { name: RULE },
    projects: [{ name: "app", root: "libs/app", tags: ["layer-app"] }],
    edges: [{ source: "app", target: "ring", type: "static" }],
    imports: [
      {
        site: {
          sourceFile: "libs/app/main.go",
          line: 7,
          column: 2,
          specifier: "example.test/ring/internal",
          kind: "static",
          spelling: { path: false, relative: false },
          resolved: { target: "ring", file: "libs/ring/x.go", external: false, packageName: null },
        },
        sourceProject: "app",
      },
    ],
    policy: { depConstraints: [], options: {} },
  }),
);

/**
 * A rule module's bytes, defaulting to the well-formed description and a
 * passing verdict. `describe`/`verdict` take documents; every other key is a
 * `buildRuleModule` option.
 *
 * @param {{describe?: any, verdict?: any} &
 *   import("./wasm-fixture.mjs").RuleModuleOptions} [options]
 * @returns {Uint8Array}
 */
function artifact({ describe: description = selfDescription(), verdict, ...options } = {}) {
  return buildRuleModule({
    describeJson:
      typeof description === "string" || description instanceof Uint8Array
        ? description
        : JSON.stringify(description),
    verdictJson:
      verdict === undefined || typeof verdict === "string" || verdict instanceof Uint8Array
        ? (verdict ?? JSON.stringify(verdictOf()))
        : JSON.stringify(verdict),
    ...options,
  });
}

/**
 * Loads a fixture under the hash a policy row would have pinned.
 *
 * @param {Parameters<typeof artifact>[0]} [options]
 * @param {{name?: string, timeoutMs?: number}} [declared]
 * @returns {Promise<import("./host.mjs").LoadedCustomRule>}
 */
function load(options = {}, { name = RULE, timeoutMs } = {}) {
  const artifactBytes = artifact(options);
  return loadCustomRule({
    name,
    artifactBytes,
    declaredSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Loads a fixture and evaluates it, asserting the load half succeeded.
 *
 * @param {Parameters<typeof artifact>[0]} [options]
 * @param {{timeoutMs?: number}} [run]
 * @returns {Promise<import("./host.mjs").CustomRuleOutcome>}
 */
async function evaluate(options = {}, run = {}) {
  const loaded = await load(options);
  expect(loaded.failure?.reason ?? null).toBe(null);
  return await evaluateCustomRule({
    module: loaded.module,
    describe: loaded.describe,
    evidenceBytes: EVIDENCE,
    ...run,
  });
}

/**
 * Evaluates with a verdict document the fixture returns verbatim.
 *
 * @param {any} verdict
 * @param {Parameters<typeof artifact>[0]} [options]
 * @returns {Promise<import("./host.mjs").CustomRuleOutcome>}
 */
const evaluateVerdict = (verdict, options = {}) => evaluate({ verdict, ...options });

/**
 * The same bytes, as the type the WebAssembly APIs declare. TypeScript 5.7
 * narrowed `BufferSource` to `ArrayBufferView<ArrayBuffer>`, which a plain
 * `Uint8Array` annotation no longer satisfies; the runtime has always taken
 * one.
 *
 * @param {Uint8Array} bytes
 * @returns {BufferSource}
 */
const source = (bytes) => /** @type {BufferSource} */ (bytes);

describe("the emitted fixtures are modules Node accepts", () => {
  // The suite's oracle. Every refusal below is only evidence about the host if
  // the bytes it refused were otherwise a real module — a fixture Node would
  // have rejected anyway would make `loadCustomRule` look right for the wrong
  // reason, and the "not valid wasm" case would then be the only one passing.
  /** @type {Array<[string, Parameters<typeof artifact>[0]]>} */
  const variants = [
    ["the well-formed rule", {}],
    ["a describe that traps", { describeBehavior: "trap" }],
    ["a describe that never returns", { describeBehavior: "loop" }],
    ["an evaluate that grows its memory", { growPagesOnEvaluate: 2 }],
    ["a memory larger than the limit", { memoryPages: 4097 }],
    ["an evaluate that traps", { evaluateBehavior: "trap" }],
    ["an evaluate that never returns", { evaluateBehavior: "loop" }],
    ["an evaluate that answers once", { evaluateBehavior: "once" }],
    ["an evaluate that echoes its input", { evaluateBehavior: "echo" }],
    ["an evaluate declared to return i32", { evaluateBehavior: "i32-return" }],
    ["an allocator that answers past memory", { allocBehavior: "out-of-bounds" }],
    ["a range outside memory", { verdictRange: { ptr: 60_000, len: 10_000 } }],
    ["a misdeclared export", { misdeclareExport: "lattice_alloc" }],
    ...RULE_EXPORTS.map(
      (name) =>
        /** @type {[string, Parameters<typeof artifact>[0]]} */ ([
          `a module missing ${name}`,
          { omitExport: name },
        ]),
    ),
  ];

  for (const [what, options] of variants) {
    it(`compiles and instantiates ${what}`, async () => {
      const { instance } = await WebAssembly.instantiate(source(artifact(options)), {});
      expect(instance).toBeInstanceOf(WebAssembly.Instance);
    });
  }

  it("compiles a module with an import, and needs one supplied to instantiate it", async () => {
    const { instance } = await WebAssembly.instantiate(source(artifact({ withImport: true })), {
      env: { host_log: () => {} },
    });
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(source(artifact({ withImport: true })))),
    ).toEqual([{ module: "env", name: "host_log", kind: "function" }]);
    expect(instance).toBeInstanceOf(WebAssembly.Instance);
  });

  it("emits a module whose start function traps", async () => {
    await expect(
      WebAssembly.instantiate(source(artifact({ trapOnStart: true })), {}),
    ).rejects.toThrow(WebAssembly.RuntimeError);
  });
});

describe("loadCustomRule", () => {
  it("loads a rule whose bytes hash to what the policy pinned", async () => {
    const loaded = await load();
    expect(loaded.ok).toBe(true);
    expect(loaded.failure).toBeUndefined();
    expect(loaded.module).toBeInstanceOf(WebAssembly.Module);
    expect(loaded.describe).toEqual(selfDescription());
  });

  /** @type {Array<[string, () => Promise<import("./host.mjs").LoadedCustomRule>, RegExp]>} */
  const refusals = [
    [
      "the artifact arrives as something other than bytes",
      () =>
        loadCustomRule({
          name: RULE,
          artifactBytes: /** @type {any} */ ("tools/rules/rule.wasm"),
          declaredSha256: "0".repeat(64),
        }),
      /rather than a view of its bytes/u,
    ],
    [
      "the bytes do not hash to the pinned sha256",
      () =>
        loadCustomRule({
          name: RULE,
          artifactBytes: artifact(),
          declaredSha256: "0".repeat(64),
        }),
      /hashes to [0-9a-f]{64}, and the policy pinned string "0{64}"/u,
    ],
    [
      "the bytes are not a WebAssembly module",
      () =>
        loadCustomRule({
          name: RULE,
          artifactBytes: invalidWasmBytes(),
          declaredSha256: createHash("sha256").update(invalidWasmBytes()).digest("hex"),
        }),
      /not a valid WebAssembly module/u,
    ],
    [
      "the module declares an import",
      () => load({ withImport: true }),
      /declares 1 import\(s\) \(env\.host_log\) and the contract grants no imports/u,
    ],
    [
      "the module exports memory as something else",
      () => load({ misdeclareExport: "memory" }),
      /exports "memory" as a global, and the ABI needs a memory/u,
    ],
    [
      "the module cannot be instantiated",
      () => load({ trapOnStart: true }),
      /could not be instantiated \(unreachable\)/u,
    ],
    [
      "lattice_describe traps",
      () => load({ describeBehavior: "trap" }),
      /trapped \(unreachable\)/u,
    ],
    [
      "lattice_describe names a range outside its memory",
      () => load({ describeRange: { ptr: 65_000, len: 1_000 } }),
      /returned the range 65000\.\.66000, which is outside its own 65536 bytes/u,
    ],
    [
      "lattice_describe returns bytes that are not UTF-8",
      () => load({ describe: new Uint8Array([0xff, 0xfe, 0xfd]) }),
      /returned bytes that are not UTF-8/u,
    ],
    [
      "lattice_describe returns text that is not JSON",
      () => load({ describe: "not json at all" }),
      /returned text that is not JSON/u,
    ],
    [
      "lattice_describe returns something that is not an object",
      () => load({ describe: "[]" }),
      /not a self-description object/u,
    ],
    [
      "lattice_describe states a key the contract has no place for",
      () => load({ describe: { ...selfDescription(), timeoutMs: 500 } }),
      /states "timeoutMs", which contract 1 has no place for/u,
    ],
    [
      "lattice_describe states another contract",
      () => load({ describe: selfDescription({ contract: 2 }) }),
      /states contract number 2, and this engine speaks contract 1/u,
    ],
    [
      "lattice_describe calls itself something else",
      () => load({ describe: selfDescription({ name: "no-ring-to-app" }) }),
      /calls itself string "no-ring-to-app", and the policy declared it "no-app-to-ring"/u,
    ],
    [
      "the findings catalogue is not an array",
      () => load({ describe: selfDescription({ findings: {} }) }),
      /not a catalogue array/u,
    ],
    [
      "the findings catalogue is empty",
      () => load({ describe: selfDescription({ findings: [] }) }),
      /empty findings catalogue/u,
    ],
    [
      "a catalogue entry is not an object",
      () => load({ describe: selfDescription({ findings: [null] }) }),
      /findings\[0\] is null, not an object/u,
    ],
    [
      "a catalogue entry states an unknown key",
      () =>
        load({
          describe: selfDescription({
            findings: [{ id: FINDING, message: "m", severity: "high" }],
          }),
        }),
      /findings\[0\] states "severity"/u,
    ],
    [
      "a catalogue id is not spelled the way an id is",
      () =>
        load({ describe: selfDescription({ findings: [{ id: "Reached Ring", message: "m" }] }) }),
      /findings\[0\]\.id is string "Reached Ring", and a finding id is lowercase words/u,
    ],
    [
      "a catalogue id is declared twice",
      () =>
        load({
          describe: selfDescription({
            findings: [
              { id: FINDING, message: "first" },
              { id: FINDING, message: "second" },
            ],
          }),
        }),
      /declares the finding id "reached-ring" twice/u,
    ],
    [
      "a catalogue entry has no message",
      () => load({ describe: selfDescription({ findings: [{ id: FINDING, message: "  " }] }) }),
      /findings\[0\]\.message is string " {2}"/u,
    ],
  ];

  for (const [what, run, expected] of refusals) {
    it(`refuses to load when ${what}`, async () => {
      const loaded = await run();
      expect(loaded.ok).toBe(false);
      expect(loaded.module).toBeUndefined();
      expect(loaded.describe).toBeUndefined();
      expect(loaded.failure.class).toBe("load");
      expect(loaded.failure.reason).toMatch(expected);
      // Every reason names the rule, because a report line has to stand alone.
      expect(loaded.failure.reason).toContain(`custom rule "${RULE}"`);
    });
  }

  it("refuses to load a rule whose description never returns, naming the budget", async () => {
    // Reading a self-description is the FIRST call into code the workspace
    // declared and this engine did not write. Left unbudgeted on the main
    // thread it would hang `check` forever — a declared rule deadlocking the
    // checker is worse than any wrong verdict, because nothing is reported at
    // all and nothing says why.
    const loaded = await load({ describeBehavior: "loop" }, { timeoutMs: 75 });
    expect(loaded.ok).toBe(false);
    expect(loaded.describe).toBeUndefined();
    expect(loaded.failure.class).toBe("load");
    expect(loaded.failure.reason).toMatch(
      /lattice_describe did not return within its 75ms budget and was terminated/u,
    );
  });

  it("refuses to load a rule whose memory is past the limit at instantiation", async () => {
    const loaded = await load({ memoryPages: 4097 });
    expect(loaded.ok).toBe(false);
    expect(loaded.failure.class).toBe("load");
    expect(loaded.failure.reason).toMatch(
      new RegExp(
        `it held 268500992 bytes of linear memory after instantiation, past the ` +
          `${CUSTOM_RULE_MEMORY_LIMIT_BYTES}-byte limit`,
        "u",
      ),
    );
  });

  it("refuses a budget that is not a positive number of milliseconds", async () => {
    const artifactBytes = artifact();
    await expect(
      loadCustomRule({
        name: RULE,
        artifactBytes,
        declaredSha256: createHash("sha256").update(artifactBytes).digest("hex"),
        timeoutMs: /** @type {any} */ (Number.POSITIVE_INFINITY),
      }),
    ).rejects.toThrow(/loadCustomRule needs a positive timeout/u);
  });

  for (const name of RULE_EXPORTS) {
    it(`refuses to load a module that exports no ${name}`, async () => {
      const loaded = await load({ omitExport: name });
      expect(loaded.ok).toBe(false);
      expect(loaded.failure.class).toBe("load");
      expect(loaded.failure.reason).toContain(`named "${name}"`);
    });
  }
});

describe("evaluateCustomRule", () => {
  it("answers a canned verdict from the evidence bundle's bytes", async () => {
    const result = await evaluate();
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.verdict).toEqual(verdictOf());
  });

  it("hands the rule the exact evidence bytes, at the pointer lattice_alloc named", async () => {
    // The echoing fixture returns the range it was handed, so the "verdict"
    // the host reads back IS the evidence it wrote. Nothing else proves the
    // write landed where the allocator said and the length survived the ABI —
    // a host that wrote at the wrong offset would still read a valid document
    // out of a canned data segment.
    const roundTrip = serializeEvidenceBundle(
      buildEvidenceBundle({
        rule: { name: RULE },
        projects: [],
        edges: [],
        imports: [],
        policy: { depConstraints: [], options: {} },
      }),
    );
    const echoed = JSON.stringify(verdictOf({ verdict: "unknown", reason: "round trip" }));
    const loaded = await load({ evaluateBehavior: "echo" });
    const result = await evaluateCustomRule({
      module: loaded.module,
      describe: loaded.describe,
      evidenceBytes: new TextEncoder().encode(echoed),
    });
    expect(result.ok).toBe(true);
    expect(result.verdict).toEqual(JSON.parse(echoed));
    expect(roundTrip.byteLength).toBeGreaterThan(0);
  });

  it("gives every evaluation its own instance", async () => {
    // The `"once"` fixture answers the full range the first time an instance
    // is asked and a zero-length one after. Two evaluations that both see the
    // verdict are two instances; a reused one would make the second read an
    // empty document and fail as unparseable.
    const loaded = await load({ evaluateBehavior: "once" });
    const first = await evaluateCustomRule({
      module: loaded.module,
      describe: loaded.describe,
      evidenceBytes: EVIDENCE,
    });
    const second = await evaluateCustomRule({
      module: loaded.module,
      describe: loaded.describe,
      evidenceBytes: EVIDENCE,
    });
    expect(first.verdict).toEqual(verdictOf());
    expect(second.verdict).toEqual(verdictOf());
  });

  it("accepts a failing verdict with a fully positioned finding", async () => {
    const rich = verdictOf({
      verdict: "fail",
      findings: [
        {
          id: FINDING,
          message: "libs/app reached libs/ring's internals",
          sourceFile: "libs/app/main.go",
          line: 7,
          column: 2,
          project: "app",
        },
      ],
    });
    const result = await evaluateVerdict(rich);
    expect(result.ok).toBe(true);
    expect(result.verdict).toEqual(rich);
  });

  it("accepts the two verdicts that carry a reason", async () => {
    const unknown = await evaluateVerdict(
      verdictOf({ verdict: "unknown", reason: "the go analyzer reported a parse failure" }),
    );
    expect(unknown.ok).toBe(true);
    const notApplicable = await evaluateVerdict(
      verdictOf({ verdict: "not_applicable", notApplicableReason: "no project carries the tag" }),
    );
    expect(notApplicable.ok).toBe(true);
  });

  it("states its three bounds as constants a run can hold to", () => {
    expect(CUSTOM_RULE_TIMEOUT_MS).toBe(10_000);
    expect(CUSTOM_RULE_MAX_VERDICT_BYTES).toBe(8 * 1024 * 1024);
    expect(CUSTOM_RULE_MEMORY_LIMIT_BYTES).toBe(256 * 1024 * 1024);
  });

  it("refuses evidence that is not the bundle's bytes", async () => {
    const loaded = await load();
    await expect(
      evaluateCustomRule({
        module: loaded.module,
        describe: loaded.describe,
        evidenceBytes: /** @type {any} */ (JSON.stringify({ contract: 1 })),
      }),
    ).rejects.toThrow(/needs the evidence bundle's bytes/u);
  });

  it("refuses a budget that is not a positive number of milliseconds", async () => {
    const loaded = await load();
    await expect(
      evaluateCustomRule({
        module: loaded.module,
        describe: loaded.describe,
        evidenceBytes: EVIDENCE,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/needs a positive timeout/u);
    await expect(
      evaluateCustomRule({
        module: loaded.module,
        describe: loaded.describe,
        evidenceBytes: EVIDENCE,
        timeoutMs: /** @type {any} */ (5n),
      }),
    ).rejects.toThrow(/needs a positive timeout in milliseconds, got bigint 5/u);
  });
});

describe("what evaluateCustomRule refuses, by name", () => {
  /** @param {{ok: boolean, verdict?: object, failure?: {class: string, reason: string}}} result */
  const assertRefused = (result, expected) => {
    expect(result.ok).toBe(false);
    // The half that matters: a refused evaluation carries NO verdict. A
    // caller reading `result.verdict` on a refusal would read `undefined`,
    // never a state it could mistake for a judgment.
    expect(result.verdict).toBeUndefined();
    expect(result.failure.class).toBe("evaluate");
    expect(result.failure.reason).toContain(`custom rule "${RULE}"`);
    expect(result.failure.reason).toMatch(expected);
  };

  it("refuses when the rule needs an evidence kind this contract does not carry", async () => {
    const result = await evaluate({
      describe: selfDescription({ needs: ["model", "go.interfaces"] }),
    });
    assertRefused(result, /needs the evidence kind string "go\.interfaces"/u);
    expect(result.failure.reason).toContain("model, graph, imports, policy");
  });

  it("refuses when the rule cannot state what it needs", async () => {
    const loaded = await load({ describe: selfDescription() });
    const result = await evaluateCustomRule({
      module: loaded.module,
      describe: { ...loaded.describe, needs: "everything" },
      evidenceBytes: EVIDENCE,
    });
    assertRefused(result, /declares needs string "everything", not an array of evidence kinds/u);
  });

  it("refuses when what it was handed is not a self-description at all", async () => {
    // A describe that never came from `loadCustomRule`. It still has to reach a
    // named failure: the one answer it must not reach is a verdict.
    const loaded = await load();
    const result = await evaluateCustomRule({
      module: loaded.module,
      describe: /** @type {any} */ (null),
      evidenceBytes: EVIDENCE,
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBeUndefined();
    expect(result.failure.class).toBe("evaluate");
    expect(result.failure.reason).toMatch(/declares needs undefined/u);
  });

  it("refuses when lattice_evaluate traps", async () => {
    assertRefused(
      await evaluate({ evaluateBehavior: "trap" }),
      /lattice_evaluate trapped \(unreachable\)/u,
    );
  });

  it("refuses when the rule never returns, naming the budget", async () => {
    const result = await evaluate({ evaluateBehavior: "loop" }, { timeoutMs: 75 });
    assertRefused(result, /did not return within its 75ms budget and was terminated/u);
  });

  it("refuses when lattice_alloc answers a pointer the evidence cannot be written at", async () => {
    assertRefused(
      await evaluate({ allocBehavior: "out-of-bounds" }),
      /lattice_alloc answered 65552 for \d+ evidence bytes, which does not fit in its 65536 bytes/u,
    );
  });

  it("refuses a packed range that points outside the rule's own memory", async () => {
    assertRefused(
      await evaluate({ verdictRange: { ptr: 60_000, len: 10_000 } }),
      /returned the range 60000\.\.70000, which is outside its own 65536 bytes/u,
    );
  });

  it("refuses a packed pointer high enough to arrive as a negative i64", async () => {
    // The signed/unsigned half of the packing rule: with bit 63 set the value
    // reaches JavaScript negative, and reading it signed would produce a
    // negative length that slips past a naive bounds check.
    assertRefused(
      await evaluate({ verdictRange: { ptr: 0xffff_0000, len: 4 } }),
      /returned the range 4294901760\.\.4294901764, which is outside its own 65536 bytes/u,
    );
  });

  it("refuses when the rule ends the call holding more memory than the limit", async () => {
    // The second of the two boundaries the worker measures. This module is
    // inside the limit when it is instantiated and past it by the time it
    // answers, which is the only shape a limit checked once would miss.
    const result = await evaluate({ growPagesOnEvaluate: 4097 });
    assertRefused(
      result,
      new RegExp(
        `it held 268566528 bytes of linear memory after the call, past the ` +
          `${CUSTOM_RULE_MEMORY_LIMIT_BYTES}-byte limit`,
        "u",
      ),
    );
  });

  it("refuses a claimed range larger than this host will ever copy", async () => {
    // In bounds and absurd: the memory really is 256 MiB, so the range is
    // readable — and honouring it would make the rule's own number decide how
    // large a buffer this host allocates and clones between threads.
    const result = await evaluate({
      memoryPages: 4096,
      verdictRange: { ptr: 0, len: CUSTOM_RULE_MAX_VERDICT_BYTES + 1 },
    });
    assertRefused(
      result,
      new RegExp(
        `lattice_evaluate claimed ${CUSTOM_RULE_MAX_VERDICT_BYTES + 1} bytes, past the ` +
          `${CUSTOM_RULE_MAX_VERDICT_BYTES}-byte cap this host will copy out of a rule`,
        "u",
      ),
    );
  });

  it("refuses a result that is not the packed i64 the ABI fixes", async () => {
    assertRefused(
      await evaluate({ evaluateBehavior: "i32-return" }),
      /returned number 0, not the packed i64 the ABI fixes/u,
    );
  });

  it("refuses a verdict whose bytes are not UTF-8", async () => {
    assertRefused(
      await evaluateVerdict(new Uint8Array([0xc3, 0x28])),
      /returned bytes that are not UTF-8/u,
    );
  });

  it("refuses a verdict that is not JSON", async () => {
    assertRefused(await evaluateVerdict("{not json"), /returned text that is not JSON/u);
  });

  it("refuses when the worker dies before it answers", async () => {
    // A module that never passed the load gate: it exports no memory, so the
    // worker throws where nothing catches and posts nothing at all. An
    // evaluation that produced no message is the silent shape this whole
    // module exists to refuse — it must never settle as a verdict.
    const loaded = await load();
    const result = await evaluateCustomRule({
      module: new WebAssembly.Module(source(artifact({ omitExport: "memory" }))),
      describe: loaded.describe,
      evidenceBytes: EVIDENCE,
    });
    assertRefused(result, /the worker running it .* before it answered/u);
  });

  it("refuses when the module cannot be instantiated in the worker", async () => {
    const loaded = await load();
    const result = await evaluateCustomRule({
      module: /** @type {any} */ (undefined),
      describe: loaded.describe,
      evidenceBytes: EVIDENCE,
    });
    assertRefused(result, /could not be instantiated/u);
  });

  /** @type {Array<[string, any, RegExp]>} */
  const hollow = [
    ["it is not an object", "[]", /it is an array of 0, not a verdict object/u],
    [
      "it states a key the contract has no place for",
      verdictOf({ severity: "high" }),
      /states "severity", which contract 1 has no place for/u,
    ],
    [
      "it states another contract",
      verdictOf({ contract: 2 }),
      /states contract number 2, and this engine speaks contract 1/u,
    ],
    [
      "its verdict is not one of the four",
      verdictOf({ verdict: "clean" }),
      /states the verdict string "clean", and the vocabulary is pass, fail, unknown, not_applicable/u,
    ],
    [
      "it leaves its findings out",
      { contract: 1, verdict: "pass" },
      /states findings undefined — every verdict states its findings/u,
    ],
    [
      "it fails and names no finding",
      verdictOf({ verdict: "fail" }),
      /it fails and names no finding/u,
    ],
    [
      "it passes and carries findings",
      verdictOf({ findings: [{ id: FINDING, message: "found one" }] }),
      /it passes and carries 1 finding\(s\)/u,
    ],
    [
      "it is unknown and says nothing about why",
      verdictOf({ verdict: "unknown" }),
      /it is "unknown" and its reason is undefined/u,
    ],
    [
      "it is not applicable and says nothing about why",
      verdictOf({ verdict: "not_applicable" }),
      /it is "not_applicable" and its notApplicableReason is undefined/u,
    ],
    [
      "it passes and carries a reason anyway",
      verdictOf({ reason: "could not read three files" }),
      /it is "pass" and carries a reason, which only the "unknown" verdict carries/u,
    ],
    [
      "it passes and carries a notApplicableReason anyway",
      verdictOf({ notApplicableReason: "no project carries the tag" }),
      /it is "pass" and carries a notApplicableReason/u,
    ],
    [
      "a finding is not an object",
      verdictOf({ verdict: "fail", findings: ["reached-ring"] }),
      /findings\[0\] is string "reached-ring", not a finding object/u,
    ],
    [
      "a finding states a key the contract has no place for",
      verdictOf({ verdict: "fail", findings: [{ id: FINDING, message: "m", severity: 9 }] }),
      /findings\[0\] states "severity"/u,
    ],
    [
      "a finding names an id the catalogue does not declare",
      verdictOf({ verdict: "fail", findings: [{ id: "reached-nothing", message: "m" }] }),
      /findings\[0\]\.id is string "reached-nothing", which the rule's own catalogue does not declare/u,
    ],
    [
      "a finding has no message",
      verdictOf({ verdict: "fail", findings: [{ id: FINDING, message: "" }] }),
      /findings\[0\]\.message is string ""/u,
    ],
    [
      "a finding's sourceFile is empty",
      verdictOf({ verdict: "fail", findings: [{ id: FINDING, message: "m", sourceFile: "" }] }),
      /findings\[0\]\.sourceFile is string ""/u,
    ],
    [
      "a finding's project is empty",
      verdictOf({ verdict: "fail", findings: [{ id: FINDING, message: "m", project: "" }] }),
      /findings\[0\]\.project is string ""/u,
    ],
    [
      "a finding puts a line on no file",
      verdictOf({ verdict: "fail", findings: [{ id: FINDING, message: "m", line: 4 }] }),
      /findings\[0\] states a line and no sourceFile/u,
    ],
    [
      "a finding's column is 0-based",
      verdictOf({
        verdict: "fail",
        findings: [{ id: FINDING, message: "m", sourceFile: "libs/app/main.go", column: 0 }],
      }),
      /findings\[0\]\.column is number 0, and positions are 1-based integers/u,
    ],
  ];

  for (const [what, verdict, expected] of hollow) {
    it(`refuses a hollow verdict when ${what}`, async () => {
      const result = await evaluateVerdict(verdict);
      assertRefused(result, expected);
      expect(result.failure.reason).toContain("hollow verdict");
    });
  }

  it("can never surface a pass that carries findings", async () => {
    // The silent direction, stated as its own case rather than left inside the
    // table above. The dangerous outcome is not the wording of the refusal —
    // it is a caller reading `verdict.verdict === "pass"` off a document that
    // also named a violation, and acting on the half it read first. There is
    // no path through this host that produces one.
    for (const findings of [
      [{ id: FINDING, message: "found one" }],
      [
        { id: FINDING, message: "one" },
        { id: FINDING, message: "two" },
      ],
    ]) {
      const result = await evaluateVerdict(verdictOf({ verdict: "pass", findings }));
      expect(result.ok).toBe(false);
      expect(result.verdict).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('"pass"');
    }
  });

  it("resolves a finding against an empty catalogue rather than waving it through", async () => {
    // A description that reached here without a catalogue — one this host did
    // not load — must not make every finding id acceptable by default.
    const loaded = await load({
      verdict: verdictOf({ verdict: "fail", findings: [{ id: FINDING, message: "m" }] }),
    });
    const result = await evaluateCustomRule({
      module: loaded.module,
      describe: { name: RULE, needs: [] },
      evidenceBytes: EVIDENCE,
    });
    assertRefused(result, /which the rule's own catalogue does not declare/u);
  });
});
