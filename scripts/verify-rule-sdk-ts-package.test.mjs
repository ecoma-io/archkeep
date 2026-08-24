// The one decision in the SDK verifier that is a pure function over text, and
// therefore the one that can be tested without packing, installing and
// compiling: which source the verifier compiles.
//
// It matters more than its size suggests. Everything else in that script fails
// loudly by construction — a failed install, a failed compile, a missing
// export. This function is the only place that could go WRONG QUIETLY: an
// extractor that silently returned a stale or hand-written rule would keep the
// whole run green while proving nothing about what an author actually reads.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { documentedRuleSource } from "./verify-rule-sdk-ts-package.mjs";

const header = (body) =>
  `// The SDK.\n//\n// \`\`\`ts\n${body}\n// \`\`\`\n//\n// After.\nexport {};\n`;

describe("documentedRuleSource", () => {
  it("extracts the fenced block and strips the comment prefix", () => {
    const text = header(
      '// import { Verdict } from "@ecoma-io/archkeep-rule-sdk/assembly";\n//\n// const x = 1;',
    );
    assert.equal(
      documentedRuleSource(text),
      'import { Verdict } from "@ecoma-io/archkeep-rule-sdk/assembly";\n\nconst x = 1;\n',
    );
  });

  it("throws when the header carries no documented block", () => {
    // The silent direction. Returning "" here would write an empty rule.ts,
    // which asc compiles happily into a module with none of the ABI exports —
    // and the export checks would then be the only thing that noticed, one
    // layer too late to say why.
    assert.throws(
      () => documentedRuleSource("// just prose, no fence\nexport {};\n"),
      /carries no ```ts block/u,
    );
  });

  it("throws when the block is opened but never closed", () => {
    assert.throws(
      () => documentedRuleSource('// ```ts\n// import { Verdict } from "x/assembly";\n'),
      /never closed/u,
    );
  });

  it("throws when the documented rule does not import through /assembly", () => {
    // Compiling a rule that imports by relative path would prove the package's
    // internal shape and NOT the thing this check exists for: that the bare
    // specifier the docs promise resolves out of node_modules. A header edited
    // to a relative import must break the verifier, not quietly narrow it.
    assert.throws(
      () => documentedRuleSource(header('// import { Verdict } from "../assembly/index";')),
      /does not import through a bare `…\/assembly` specifier/u,
    );
  });
});
