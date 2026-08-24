import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { findBoundaryConfigViolations } from "../config.mjs";
import { MESSAGES } from "./messages.mjs";

/**
 * The tripwire for the one thing this engine copies rather than derives.
 *
 * `messages.mjs` holds a hand-copy of `@nx/enforce-module-boundaries`'
 * `meta.messages`, and `config.mjs` holds the list of its options, because this
 * project may import Node built-ins and `typescript` only — loading the plugin
 * would drag `@nx/devkit` and a project-graph read into a layer whose value is
 * being pure. A copy with no check is a copy that drifts, and the drift is
 * invisible: an id this engine spells one way and ESLint spells another makes a
 * differential comparison silently pass on ids neither tool emits.
 *
 * So this reads the INSTALLED plugin's source as text and compares. It is an
 * integration test by its filename because it reaches out of the project into
 * `node_modules`, and it is the test that should fail — loudly, naming the
 * message — the first time an Nx upgrade rewords a rule.
 */

const require_ = createRequire(import.meta.url);
const pluginSource = () => {
  // The plugin's `exports` map does not expose `dist/`, so the path is built
  // from its manifest rather than resolved directly.
  const manifest = require_.resolve("@nx/eslint-plugin/package.json");
  return readFileSync(
    join(dirname(manifest), "dist/src/rules/enforce-module-boundaries.js"),
    "utf8",
  );
};

/** The balanced `open`…`close` run starting at or after `from`. */
function balanced(text, from, open, close) {
  const start = text.indexOf(open, from);
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`archkeep: unbalanced ${open}${close} in the upstream rule source`);
}

/** Evaluates one object/array literal out of the plugin's compiled source. */
const literalAt = (source, marker, open, close) =>
  new Function(`return (${balanced(source, source.indexOf(marker), open, close)})`)();

describe("the copied halves of @nx/enforce-module-boundaries", () => {
  it("carries every violation message upstream defines, worded identically", () => {
    const upstream = literalAt(pluginSource(), "messages: {", "{", "}");

    expect(Object.keys(MESSAGES).sort()).toEqual(Object.keys(upstream).sort());
    for (const [messageId, template] of Object.entries(upstream)) {
      expect(MESSAGES[messageId], `message '${messageId}' has drifted from upstream`).toBe(
        template,
      );
    }
  });

  it("requires exactly the options upstream defines, none guessed and none missing", () => {
    const [upstreamDefaults] = literalAt(pluginSource(), "defaultOptions:", "[", "]");
    // `depConstraints` is the table itself, exported separately by the
    // workspace config; the other eight are the options this engine reads.
    const optionNames = Object.keys(upstreamDefaults).filter((key) => key !== "depConstraints");

    // An option the validator does not know about would be rejected as unknown;
    // one it knows about but upstream dropped would be demanded for no reason.
    const violations = findBoundaryConfigViolations({
      depConstraints: [],
      moduleBoundaryOptions: Object.fromEntries(
        optionNames.map((name) => [name, upstreamDefaults[name]]),
      ),
    });
    expect(violations).toEqual([]);

    for (const name of optionNames) {
      const withoutOne = Object.fromEntries(
        optionNames.filter((key) => key !== name).map((key) => [key, upstreamDefaults[key]]),
      );
      expect(
        findBoundaryConfigViolations({ depConstraints: [], moduleBoundaryOptions: withoutOne }),
        `option '${name}' is not required by the loader`,
      ).toEqual([`moduleBoundaryOptions.${name}: missing — every option is stated explicitly`]);
    }
  });

  it("pins the DEFAULT VALUES upstream states for each option — a failure here means upstream changed a default, which is a breaking change for every ESLint-dialect consumer and must ship as one, not be silently absorbed", () => {
    // The test above pins the option NAMES upstream requires; it says nothing
    // about what upstream defaults each one TO. `../config-spelling.integration.test.mjs`'s
    // A5 axis reads that default LIVE off the installed plugin on both sides of
    // its comparison, so a real upstream default change moves both sides
    // together there, silently — this is the one place a changed default is
    // compared against a literal instead, so that change is loud.
    const [upstreamDefaults] = literalAt(pluginSource(), "defaultOptions:", "[", "]");
    const { depConstraints: _depConstraintsDefault, ...values } = upstreamDefaults;
    expect(values).toEqual({
      allow: [],
      buildTargets: ["build"],
      enforceBuildableLibDependency: false,
      allowCircularSelfDependency: false,
      checkDynamicDependenciesExceptions: [],
      ignoredCircularDependencies: [],
      banTransitiveDependencies: false,
      checkNestedExternalImports: false,
    });
  });
});
