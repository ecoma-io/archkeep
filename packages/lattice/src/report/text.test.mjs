import { describe, expect, it } from "vitest";

import {
  formatConstraint,
  formatCoverageGaps,
  formatDeclaredEdges,
  formatFailures,
  formatGoWork,
  formatPolicy,
  formatReport,
  formatTsconfigPaths,
  formatViolation,
} from "./text.mjs";

/**
 * What a developer must be able to do from the report alone: jump to the site,
 * name the rule, and know which line of the boundary config to argue with. Each
 * test below pins one of those, because a report that is merely non-empty is
 * indistinguishable from one that is useful.
 */

const violation = (overrides = {}) => ({
  sourceFile: "acme/libs/engine-domain/doc.go",
  line: 12,
  column: 23,
  specifier: "example.com/acme/engine-adapters",
  kind: "static",
  messageId: "onlyTagsConstraintViolation",
  message: 'A project tagged with "layer:domain" can only depend on libs tagged with layer:domain',
  sourceProject: "engine-domain",
  targetProject: "engine-adapters",
  constraint: {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain", "layer:util"],
  },
  data: {},
  ...overrides,
});

describe("a violation entry", () => {
  it("opens with an unindented file:line:column so a terminal and an editor can jump to it", () => {
    const [first] = formatViolation(violation()).split("\n");
    expect(first).toBe("acme/libs/engine-domain/doc.go:12:23  onlyTagsConstraintViolation");
  });

  it("names the upstream messageId, which is what makes the verdict comparable to ESLint's", () => {
    // Two tools that both say "error" agree on nothing until they name the same
    // rule — the id is the contract, and a report that dropped it would leave a
    // differential comparison with nothing to compare (../rules/messages.mjs).
    expect(formatViolation(violation())).toContain("onlyTagsConstraintViolation");
  });

  it("carries the import as written, its form, and the project pair it crosses", () => {
    expect(formatViolation(violation())).toContain(
      'import      "example.com/acme/engine-adapters" (static)  engine-domain → engine-adapters',
    );
  });

  it("names the constraint row that fired, which is the line a fix has to agree with", () => {
    expect(formatViolation(violation())).toContain(
      "constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain, layer:util]",
    );
  });

  it("renders the rule description and remediation when the constraint row carries them", () => {
    const text = formatViolation(
      violation({
        constraint: {
          sourceTag: "layer:domain",
          onlyDependOnLibsWithTags: ["layer:domain"],
          description: "Domain isolation",
          remediation: "Depend on an application-owned interface",
        },
      }),
    );
    expect(text).toContain("rule        Domain isolation");
    expect(text).toContain("remediation Depend on an application-owned interface");
  });

  it("omits the rule and remediation lines when the constraint row has none", () => {
    const text = formatViolation(violation());
    expect(text).not.toContain("rule        ");
    expect(text).not.toContain("remediation ");
  });

  it("indents every line of a multi-line message, so a wrapped one is not read as a second site", () => {
    const text = formatViolation(
      violation({
        messageId: "noCircularDependencies",
        message:
          'Circular dependency between "a" and "b" detected: a -> b\n\nCircular file chain:\na.ts',
      }),
    );
    const lines = text.split("\n");
    // Only the position line may start at column 0; anything else reads as a
    // new entry to both a human scanning the margin and a `grep '^[^ ]'`.
    expect(lines.filter((line) => line !== "" && !line.startsWith(" "))).toEqual([lines[0]]);
  });

  it("says so plainly when an import resolved to no project, instead of printing an empty pair", () => {
    expect(
      formatViolation(
        violation({ targetProject: null, messageId: "noRelativeOrAbsoluteExternals" }),
      ),
    ).toContain("engine-domain → (unresolved)");
  });

  it("says so plainly when the importing file belongs to no project either", () => {
    expect(
      formatViolation(
        violation({
          sourceProject: null,
          targetProject: null,
          messageId: "bannedExternalImportsViolation",
        }),
      ),
    ).toContain("(no project) → (unresolved)");
  });
});

describe("the constraint line", () => {
  it("renders whatever fields the row carries, so a new upstream field cannot go missing", () => {
    // Enumerating today's four constraint keys would silently drop the fifth
    // the day @nx/enforce-module-boundaries adds one.
    expect(
      formatConstraint({
        sourceTag: "layer:view",
        bannedExternalImports: ["@tauri-apps/*"],
        someFieldUpstreamAddsLater: ["x"],
      }),
    ).toBe(
      "sourceTag layer:view → bannedExternalImports [@tauri-apps/*] → someFieldUpstreamAddsLater [x]",
    );
  });

  it("spells out a combo row's whole tag set, since it matches only projects carrying all of them", () => {
    expect(
      formatConstraint({
        allSourceTags: ["type:lib", "layer:domain"],
        onlyDependOnLibsWithTags: [],
      }),
    ).toBe("allSourceTags [type:lib, layer:domain] → onlyDependOnLibsWithTags []");
  });

  it("explains an absent row rather than printing nothing, which would read as a missing field", () => {
    expect(formatConstraint(null)).toContain("not driven by a depConstraints row");
  });
});

// P1-02: a row's decisionRef used to render verbatim, unverified — a live
// violation quoted a completely nonexistent ADR id as if it were a confirmed
// authority. `formatConstraint` stays pure (no filesystem access of its
// own): the caller resolves every decisionRef ONCE against the workspace's
// ADR registry and hands back the VALUES that did not resolve.
describe("the constraint line — decisionRef resolution (P1-02)", () => {
  it("renders a decisionRef verbatim when no unresolved set is passed — unchanged from before this existed", () => {
    expect(formatConstraint({ sourceTag: "layer:view", decisionRef: "adr:0012" })).toBe(
      "sourceTag layer:view → decisionRef [adr:0012]",
    );
  });

  it("renders a decisionRef verbatim when it is not a member of the unresolved set", () => {
    const resolved = new Set(["9999-does-not-exist"]);
    expect(formatConstraint({ sourceTag: "layer:view", decisionRef: "0001-real" }, resolved)).toBe(
      "sourceTag layer:view → decisionRef [0001-real]",
    );
  });

  it("flags a decisionRef in the unresolved set, loudly, instead of quoting it as a confirmed authority", () => {
    const unresolved = new Set(["9999-does-not-exist"]);
    const text = formatConstraint(
      { sourceTag: "scope:app", decisionRef: "9999-does-not-exist" },
      unresolved,
    );
    expect(text).toContain("decisionRef [9999-does-not-exist]");
    expect(text).toContain("UNRESOLVED");
    expect(text).toContain("no matching ADR, rule, or fitness record");
  });

  it("leaves every other key's rendering untouched by the unresolved set", () => {
    const unresolved = new Set(["9999-does-not-exist"]);
    expect(
      formatConstraint(
        { sourceTag: "scope:app", onlyDependOnLibsWithTags: ["scope:allowed"] },
        unresolved,
      ),
    ).toBe("sourceTag scope:app → onlyDependOnLibsWithTags [scope:allowed]");
  });
});

describe("a violation entry — decisionRef resolution (P1-02)", () => {
  it("quotes an unresolved decisionRef as UNRESOLVED in the constraint line of a live violation", () => {
    // The audit's own reproduction: `check` exits 1 on a real violation, and
    // the report used to quote the row's bogus decisionRef as if legitimate.
    const text = formatViolation(
      violation({
        constraint: {
          sourceTag: "scope:app",
          onlyDependOnLibsWithTags: ["scope:allowed"],
          decisionRef: "9999-does-not-exist",
        },
      }),
      new Set(["9999-does-not-exist"]),
    );
    expect(text).toContain(
      "constraint  sourceTag scope:app → onlyDependOnLibsWithTags [scope:allowed]",
    );
    expect(text).toContain("decisionRef [9999-does-not-exist]");
    expect(text).toContain("UNRESOLVED");
  });

  it("renders exactly as before when no unresolved set is passed", () => {
    const text = formatViolation(
      violation({
        constraint: {
          sourceTag: "scope:app",
          onlyDependOnLibsWithTags: ["scope:allowed"],
          decisionRef: "9999-does-not-exist",
        },
      }),
    );
    expect(text).not.toContain("UNRESOLVED");
  });
});

describe("formatDeclaredEdges — decisionRef resolution (P1-02)", () => {
  const declaredEdgeFinding = (overrides = {}) => ({
    messageId: "onlyTagsConstraintViolation",
    file: "libs/app/project.json",
    source: "app",
    target: "lib",
    message:
      'A project tagged with "scope:app" can only depend on libs tagged with "scope:allowed"',
    constraint: {
      sourceTag: "scope:app",
      onlyDependOnLibsWithTags: ["scope:allowed"],
      decisionRef: "9999-does-not-exist",
    },
    ...overrides,
  });

  it("flags an unresolved decisionRef on a declared-edge (implicitDependencies) finding too", () => {
    const text = formatDeclaredEdges(
      { findings: [declaredEdgeFinding()], judged: 1 },
      new Set(["9999-does-not-exist"]),
    );
    expect(text).toContain("decisionRef [9999-does-not-exist]");
    expect(text).toContain("UNRESOLVED");
  });

  it("renders exactly as before when no unresolved set is passed", () => {
    const text = formatDeclaredEdges({ findings: [declaredEdgeFinding()], judged: 1 });
    expect(text).not.toContain("UNRESOLVED");
  });
});

describe("analysis failures", () => {
  it("marks them blind spots rather than verdicts, so a reader cannot mistake one for a violation", () => {
    const text = formatFailures([
      { sourceFile: "a/b.ts", line: 3, column: 8, reason: "TypeScript cannot resolve 'x'" },
    ]);
    expect(text).toContain("not verdicts");
    expect(text).toContain("the run does not fail on them");
    expect(text).toContain("a/b.ts:3:8  TypeScript cannot resolve 'x'");
  });

  it("prints a whole-file failure without a position, rather than inventing line 1", () => {
    const text = formatFailures([
      { sourceFile: "a/b.rs", line: null, column: null, reason: "unreadable" },
    ]);
    expect(text).toContain("a/b.rs  unreadable");
    expect(text).not.toContain("a/b.rs:");
  });

  it("separates a file with no verdict from an import with none, because only one fails the run", () => {
    // One heading for both is what let a file nobody analyzed sit in a list
    // headed "the run does not fail on them" while the summary above counted
    // it as inspected. A reader must be able to tell coverage that is missing
    // from a position that has no static answer.
    const text = formatFailures([
      {
        sourceFile: "a/b.ts",
        line: 3,
        column: 8,
        reason: "import(url) is not statically knowable",
      },
      { sourceFile: "a/c.vue", line: null, column: null, reason: "Vue analysis failed" },
    ]);
    expect(text).toContain("1 file could not be analyzed at all");
    expect(text).toContain("the run fails");
    expect(text).toContain("a/c.vue  Vue analysis failed");
    expect(text).toContain("blind spots inside files that were analyzed");
    expect(text).toContain("a/b.ts:3:8");
    // The blind-spot count must not absorb the unanalyzed file, or the two
    // sections would disagree about how much the run actually covered.
    expect(text).toContain("1 import could not be resolved");
  });

  it("counts unanalyzed files rather than their failures, so one bad file cannot look like many", () => {
    const text = formatFailures([
      { sourceFile: "a/b.vue", line: null, column: null, reason: "first" },
      { sourceFile: "a/b.vue", line: null, column: null, reason: "second" },
    ]);
    expect(text).toContain("1 file could not be analyzed at all");
  });

  it("uses the plural forms when more than one file was never analyzed", () => {
    const text = formatFailures([
      { sourceFile: "a/b.vue", line: null, column: null, reason: "first" },
      { sourceFile: "c/d.rs", line: null, column: null, reason: "second" },
    ]);
    expect(text).toContain("2 files could not be analyzed at all");
    expect(text).toContain("they are not covered by the verdict above");
  });

  it("says nothing at all when there were none", () => {
    expect(formatFailures([])).toBe("");
  });
});

describe("go.work drift", () => {
  const finding = (overrides = {}) => ({
    messageId: "goWorkStaleUse",
    file: "go.work",
    line: 4,
    column: 2,
    directory: "libs/gone",
    project: null,
    message: 'go.work uses "./libs/gone", but the workspace has no tracked go.mod there',
    ...overrides,
  });

  it("renders a finding like a violation: a clickable position line, then the indented message", () => {
    const text = formatGoWork({ findings: [finding()], moduleProjects: 2 });
    expect(text).toContain("go.work:4:2  goWorkStaleUse");
    expect(text).toContain('    go.work uses "./libs/gone"');
    expect(text).toContain("✖ go.work drifts from the project graph: 1 finding");
    expect(text).toContain("the run fails");
  });

  it("prints a missing-use finding without a position, rather than inventing line 1", () => {
    const text = formatGoWork({
      findings: [
        finding({ messageId: "goWorkMissingUse", line: null, column: null, project: "beta" }),
      ],
      moduleProjects: 2,
    });
    expect(text).toContain("go.work  goWorkMissingUse");
    expect(text).not.toContain("go.work:");
  });

  it("claims agreement out loud when the check ran clean, stating how many modules that covers", () => {
    // A clean go.work saying nothing would be indistinguishable from a run
    // that never looked at it — the same reason the summary line counts files.
    expect(formatGoWork({ findings: [], moduleProjects: 3 })).toBe(
      "✔ go.work agrees with the project graph (3 Go module projects)",
    );
  });

  it("says nothing at all when the workspace has no go.work, which is the one silent case allowed", () => {
    expect(formatGoWork(null)).toBe("");
    expect(formatGoWork(undefined)).toBe("");
  });

  it("claims agreement with the singular module form for a one-module workspace", () => {
    expect(formatGoWork({ findings: [], moduleProjects: 1 })).toBe(
      "✔ go.work agrees with the project graph (1 Go module project)",
    );
  });

  it("keeps a blank line inside a finding's message, indented like the rest", () => {
    const text = formatGoWork({
      findings: [
        finding({ message: "line one\n\nline three", line: null, column: null, project: "beta" }),
      ],
      moduleProjects: 1,
    });
    expect(text).toContain("    line one\n\n    line three");
  });
});

describe("tsconfig paths hygiene", () => {
  const deadAlias = (overrides = {}) => ({
    messageId: "tsconfigDeadPathAlias",
    file: "tsconfig.base.json",
    line: null,
    column: null,
    alias: "@acme/engine-domain",
    targets: ["libs/engine-domain/src/index.ts"],
    message: 'tsconfig.base.json maps "@acme/engine-domain" only to targets that are gone',
    ...overrides,
  });

  it("renders a finding at the file alone — the finding is positionless by construction", () => {
    const text = formatTsconfigPaths({
      tsConfig: "tsconfig.base.json",
      findings: [deadAlias()],
      aliases: 3,
      unjudged: 0,
    });
    expect(text).toContain("tsconfig.base.json  tsconfigDeadPathAlias");
    expect(text).not.toContain("tsconfig.base.json:");
    expect(text).toContain('    tsconfig.base.json maps "@acme/engine-domain"');
    expect(text).toContain("✖ dead tsconfig path aliases: 1 finding (3 aliases judged");
    expect(text).toContain("the run fails");
  });

  it("claims cleanliness out loud when the check ran, stating how many aliases that covers", () => {
    // A clean table saying nothing would be indistinguishable from a run that
    // never looked at it — the same reason the summary line counts files.
    expect(
      formatTsconfigPaths({
        tsConfig: "tsconfig.base.json",
        findings: [],
        aliases: 4,
        unjudged: 0,
      }),
    ).toBe("✔ no dead tsconfig path aliases (4 aliases judged in tsconfig.base.json)");
  });

  it("counts the aliases its rule could not judge beside the verdict, never inside it", () => {
    const text = formatTsconfigPaths({
      tsConfig: "tsconfig.base.json",
      findings: [],
      aliases: 2,
      unjudged: 1,
    });
    expect(text).toContain("2 aliases judged in tsconfig.base.json");
    expect(text).toContain("1 outside this check's rule and not judged");
  });

  it("uses the plural forms when several dead aliases share the verdict", () => {
    const text = formatTsconfigPaths({
      tsConfig: "tsconfig.base.json",
      findings: [deadAlias(), deadAlias({ alias: "@acme/other" })],
      aliases: 2,
      unjudged: 0,
    });
    expect(text).toContain("✖ dead tsconfig path aliases: 2 findings");
    expect(text).toContain("these aliases can resolve");
  });

  it("keeps a blank line inside a dead-alias message, indented like the rest", () => {
    const text = formatTsconfigPaths({
      tsConfig: "tsconfig.base.json",
      findings: [deadAlias({ message: "line one\n\nline three" })],
      aliases: 1,
      unjudged: 0,
    });
    expect(text).toContain("    line one\n\n    line three");
  });

  it("says nothing at all when the workspace declares no paths, which is the one silent case allowed", () => {
    expect(formatTsconfigPaths(null)).toBe("");
    expect(formatTsconfigPaths(undefined)).toBe("");
  });
});

describe("the policy identity line", () => {
  // P1-01: a verdict never named the law that produced it, so a violating
  // tree under a weak policy and a clean tree under a strict one printed the
  // exact same "no boundary violations" sentence — nothing anywhere said
  // which law had run.
  it("names the file and fingerprint when no profile is active", () => {
    expect(
      formatPolicy({
        profile: null,
        source: "module-boundaries.config.mjs",
        fingerprint: "abc123",
      }),
    ).toBe("policy  module-boundaries.config.mjs — fingerprint abc123");
  });

  it("names the profile and its registry when a profile is active", () => {
    expect(
      formatPolicy({ profile: "strict", source: "law-profiles.json", fingerprint: "abc123" }),
    ).toBe('policy  profile "strict" from law-profiles.json — fingerprint abc123');
  });

  it("says nothing at all when no caller supplied a policy — the silent case a unit test exercising some other section is allowed", () => {
    expect(formatPolicy(null)).toBe("");
    expect(formatPolicy(undefined)).toBe("");
  });
});

describe("the report as a whole", () => {
  const run = (overrides) => ({
    violations: [],
    failures: [],
    analyzed: 405,
    projects: 19,
    imports: 1246,
    ...overrides,
  });

  it("states what it inspected when clean, because 'no violations' is a claim about coverage too", () => {
    // A run that analyzed nothing and a clean tree would otherwise print the
    // same sentence — the exact indistinguishability this tool exists to end.
    expect(formatReport(run())).toBe(
      "✔ no boundary violations (1246 imports in 405 files across 19 projects)",
    );
  });

  it("carries the policy identity line first, ahead of the verdict, when a caller supplies one (P1-01)", () => {
    // The silent-direction pair: two runs whose only difference is which
    // policy governed must no longer be able to print the identical verdict
    // line with nothing distinguishing them — the policy line is the fact
    // that tells them apart, and it comes first because a reader has to know
    // which law produced a verdict before the verdict itself means anything.
    const strict = formatReport(
      run({ policy: { profile: null, source: "strict.config.mjs", fingerprint: "111" } }),
    );
    const weak = formatReport(
      run({ policy: { profile: null, source: "weak.config.mjs", fingerprint: "222" } }),
    );
    expect(strict).not.toBe(weak);
    expect(strict.split("\n\n")[0]).toBe("policy  strict.config.mjs — fingerprint 111");
    expect(weak.split("\n\n")[0]).toBe("policy  weak.config.mjs — fingerprint 222");
    // Everything after the policy line is unaffected — same verdict, same
    // coverage counts, because the fixture tree and the violation count are
    // identical; only the law that produced them differs.
    expect(
      strict.endsWith("✔ no boundary violations (1246 imports in 405 files across 19 projects)"),
    ).toBe(true);
  });

  it("counts the offending files as well as the violations, so one bad file cannot look like many", () => {
    const twice = [violation(), violation({ line: 40 })];
    expect(formatReport(run({ violations: twice }))).toContain("✖ 2 boundary violations in 1 file");
  });

  it("keeps the failure list on a red run too, so a blind spot is not hidden behind a finding", () => {
    const text = formatReport(
      run({
        violations: [violation()],
        failures: [
          { sourceFile: "a/b.ts", line: 9, column: 1, reason: "not statically knowable" },
          { sourceFile: "a/c.ts", line: null, column: null, reason: "unreadable" },
        ],
      }),
    );
    expect(text).toContain("✖ 1 boundary violation");
    expect(text).toContain("blind spots inside files that were analyzed");
    expect(text).toContain("could not be analyzed at all");
  });

  it("forwards unresolvedDecisionRefs through to a live violation's constraint line (P1-02)", () => {
    const text = formatReport(
      run({
        violations: [
          violation({
            constraint: {
              sourceTag: "scope:app",
              onlyDependOnLibsWithTags: ["scope:allowed"],
              decisionRef: "9999-does-not-exist",
            },
          }),
        ],
        unresolvedDecisionRefs: new Set(["9999-does-not-exist"]),
      }),
    );
    expect(text).toContain("✖ 1 boundary violation");
    expect(text).toContain("decisionRef [9999-does-not-exist]");
    expect(text).toContain("UNRESOLVED");
  });

  it("forwards unresolvedDecisionRefs through to a waived violation's constraint line too", () => {
    const text = formatReport(
      run({
        violations: [
          violation({
            constraint: {
              sourceTag: "scope:app",
              onlyDependOnLibsWithTags: ["scope:allowed"],
              decisionRef: "9999-does-not-exist",
            },
            waivedBy: {
              path: "acme/libs/engine-domain/doc.go",
              reason: "waiting on the ADR",
              expiresAt: "2026-09-01T00:00:00.000Z",
            },
          }),
        ],
        unresolvedDecisionRefs: new Set(["9999-does-not-exist"]),
      }),
    );
    expect(text).toContain("UNRESOLVED");
  });

  it("splits actively-waived violations into an accepted-violations section, with the waiver's term and reason", () => {
    const text = formatReport(
      run({
        violations: [
          violation({
            waivedBy: {
              path: "acme/libs/engine-domain/doc.go",
              reason: "bundler resolves no alias for this file",
              expiresAt: "2026-09-01T00:00:00.000Z",
              origin: "ticket-1234",
            },
          }),
        ],
      }),
    );
    // An all-waived run is NOT clean: the boundary is still breached, so the
    // summary must not say "✔ no boundary violations".
    expect(text).not.toContain("✔ no boundary violations");
    expect(text).toContain("accepted violations: 1 boundary violation waived");
    expect(text).toContain("accepted until 2026-09-01T00:00:00.000Z");
    expect(text).toContain("origin: ticket-1234");
    expect(text).toContain("✖ 1 boundary violation accepted");
  });

  it("keeps a re-asserted violation (expired waiver) in the main findings list, with the evidence", () => {
    const text = formatReport(
      run({
        violations: [violation({ evidence: "expired waiver" })],
      }),
    );
    expect(text).toContain("✖ 1 boundary violation");
    expect(text).toContain("evidence   expired waiver");
    expect(text).not.toContain("accepted violations");
  });

  it("renders a waived violation alongside a live one without losing either count", () => {
    const text = formatReport(
      run({
        violations: [
          violation(),
          violation({
            sourceFile: "acme/libs/other/x.ts",
            waivedBy: {
              path: "acme/libs/other/x.ts",
              reason: "waiting for the migration",
              expiresAt: "2026-10-01T00:00:00.000Z",
            },
          }),
        ],
      }),
    );
    expect(text).toContain("✖ 1 boundary violation in 1 file");
    expect(text).toContain("accepted violations: 1 boundary violation waived");
  });

  it("carries the go.work section between the verdict and the failures when the check ran", () => {
    const text = formatReport(
      run({
        goWork: {
          findings: [
            {
              messageId: "goWorkMissingUse",
              file: "go.work",
              line: null,
              column: null,
              directory: "libs/beta",
              project: "beta",
              message: "go.work does not use libs/beta",
            },
          ],
          moduleProjects: 2,
        },
      }),
    );
    expect(text).toContain("✔ no boundary violations");
    expect(text).toContain("go.work  goWorkMissingUse");
    expect(text).toContain("✖ go.work drifts from the project graph");
  });

  it("never mentions go.work on a run whose workspace has none — no manifest, no claim", () => {
    expect(formatReport(run())).not.toContain("go.work");
    expect(formatReport(run({ goWork: null }))).not.toContain("go.work");
  });

  it("carries the tsconfig paths section when the check ran, findings or not", () => {
    const clean = formatReport(
      run({
        tsconfigPaths: { tsConfig: "tsconfig.base.json", findings: [], aliases: 2, unjudged: 0 },
      }),
    );
    expect(clean).toContain("✔ no boundary violations");
    expect(clean).toContain("✔ no dead tsconfig path aliases");
    const dirty = formatReport(
      run({
        tsconfigPaths: {
          tsConfig: "tsconfig.base.json",
          findings: [
            {
              messageId: "tsconfigDeadPathAlias",
              file: "tsconfig.base.json",
              line: null,
              column: null,
              alias: "@acme/gone",
              targets: ["libs/gone/index.ts"],
              message: "the dead alias, spelled out",
            },
          ],
          aliases: 2,
          unjudged: 0,
        },
      }),
    );
    expect(dirty).toContain("tsconfig.base.json  tsconfigDeadPathAlias");
    expect(dirty).toContain("✖ dead tsconfig path aliases");
  });

  it("never mentions the paths table on a run whose workspace declares none — no table, no claim", () => {
    expect(formatReport(run())).not.toContain("tsconfig");
    expect(formatReport(run({ tsconfigPaths: null }))).not.toContain("tsconfig");
  });

  it("carries the coverage gap section when polyglot manifests exist but the plugin is unregistered", () => {
    // Silent direction: a clean exit with no mention of the gap is exactly the
    // under-coverage this note exists to name (AGENTS.md: an empty result is a
    // claim). The report must name the manifests and say what is missing.
    const text = formatReport(
      run({
        coverageGaps: [
          {
            kind: "unregistered-plugin",
            manifests: ["libs/domain/go.mod", "libs/adapters/Cargo.toml"],
          },
        ],
      }),
    );
    expect(text).toContain("✔ no boundary violations");
    expect(text).toContain("nx.json does not register this plugin");
    expect(text).toContain("libs/domain/go.mod");
    expect(text).toContain("libs/adapters/Cargo.toml");
    expect(text).toContain("nx affected");
    expect(text).toContain("@ecoma-io/lattice/nx");
  });

  it("never mentions a coverage gap on a run with no gap — no gap, no claim", () => {
    expect(formatReport(run())).not.toContain("coverage gap");
    expect(formatReport(run({ coverageGaps: [] }))).not.toContain("coverage gap");
  });
});

describe("formatCoverageGaps", () => {
  it("returns empty when there are no coverage gaps", () => {
    expect(formatCoverageGaps([])).toBe("");
  });

  it("names the manifests and explains what is missing", () => {
    const text = formatCoverageGaps([
      { kind: "unregistered-plugin", manifests: ["libs/a/go.mod", "libs/b/Cargo.toml"] },
    ]);
    expect(text).toContain("2 polyglot manifests");
    expect(text).toContain("libs/a/go.mod");
    expect(text).toContain("libs/b/Cargo.toml");
    expect(text).toContain("nx affected");
    expect(text).toContain("register the plugin");
  });

  it("uses singular when there is exactly one manifest", () => {
    const text = formatCoverageGaps([
      { kind: "unregistered-plugin", manifests: ["libs/a/go.mod"] },
    ]);
    expect(text).toContain("1 polyglot manifest");
    expect(text).not.toContain("1 polyglot manifests");
  });
});
