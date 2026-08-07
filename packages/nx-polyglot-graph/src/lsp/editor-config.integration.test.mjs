/**
 * The editor configuration checked against the server it configures.
 *
 * A `.lsp.json`-style manifest cannot import anything — it is data an editor
 * reads before any of this code runs — so the list of extensions it routes here
 * is a second copy of a fact `../analysis/analyze.mjs` already owns. A second
 * copy is allowed only when something keeps it honest, which is this file:
 * the same arrangement `../rules/messages.mjs` has with
 * `../rules/upstream.integration.test.mjs`.
 *
 * What goes wrong without it is quiet. A language arrives, registers in
 * `LANGUAGE_BY_EXTENSION`, gets an analyzer and a rule pass — and the editor
 * never sends it a file, so every project written in it keeps showing no
 * boundary problems. That reads exactly like a clean tree.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LANGUAGE_BY_EXTENSION } from "../analysis/analyze.mjs";

/**
 * The package root, and the manifest inside it.
 *
 * Both are counted from this file rather than searched for, and the manifest
 * living IN the package is the point: it is what a consumer receives when they
 * install the plugin, so the entry point it names has to be resolvable from the
 * package alone. A manifest at the workspace root — where this one used to be —
 * describes a server only the repository that contains it can start.
 */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST = join(PACKAGE_ROOT, ".claude-plugin/plugin.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const [server] = Object.values(manifest.lspServers);

describe("the Claude Code plugin that routes files to this server", () => {
  it("launches the server that exists, at a path resolved inside the installed plugin", () => {
    // A renamed entry point is otherwise found by a developer, not by CI: the
    // plugin loads, the process fails to start, and Claude Code reports it in a
    // tab nobody opens.
    //
    // `${CLAUDE_PLUGIN_ROOT}` and not `${CLAUDE_PROJECT_DIR}`, and the assertion
    // is on that too, because the difference is the whole difference between a
    // plugin and a local script. The first is wherever this package was
    // installed; the second is the workspace being judged. A manifest pointing
    // `args` at the project directory would start only in the one repository
    // that happens to contain the server — every consumer would install it and
    // get a server that never launches.
    const entry = server.args.at(-1);

    expect(server.command).toBe("node");
    expect(entry.startsWith("${CLAUDE_PLUGIN_ROOT}/")).toBe(true);
    expect(existsSync(join(PACKAGE_ROOT, entry.replace("${CLAUDE_PLUGIN_ROOT}/", "")))).toBe(true);
  });

  it("judges the tree the editor opened, not the tree it was installed into", () => {
    // The other side of the same pair. The server takes the workspace root as a
    // parameter for the reason `../config.mjs` gives at length, and this is where
    // the editor supplies it: a `workspaceFolder` resolved to the plugin's own
    // install location would make it read whatever config sat above
    // `node_modules` and report green on rules nobody wrote.
    expect(server.workspaceFolder).toBe("${CLAUDE_PROJECT_DIR}");
  });

  it("routes every language the analyzers handle except the JS/TS family", () => {
    // ESLint runs wherever it has a parser, and in a workspace that configures
    // one that is JS, TS AND Vue — `vue-eslint-parser` reads a single-file
    // component and `@nx/enforce-module-boundaries` judges it. Go, Rust and
    // Python are the half it cannot reach at all, so for those three this server
    // is the only enforcement a `layer:`/`scope:`/`license:` tag has. `.vue` is
    // routed anyway, as a second opinion `../conformance/` holds to the same
    // verdict. What must not happen either way is a language landing in the
    // analyzer registry and not here: it would be checked by the CLI and never
    // by an editor.
    const routed = Object.entries(LANGUAGE_BY_EXTENSION)
      .filter(([, language]) => language !== "typescript")
      .map(([extension]) => extension);

    expect(Object.keys(server.extensionToLanguage).sort()).toEqual(routed.sort());
  });

  it("leaves JS and TS to the enforcer that already covers them", () => {
    // Claude Code gives ONE server per extension — the first registered wins
    // and the rest never start. Claiming `.ts` would displace whichever
    // TypeScript server the developer actually needs, to re-answer a question
    // `@nx/enforce-module-boundaries` already answers through ESLint.
    const typescriptExtensions = Object.entries(LANGUAGE_BY_EXTENSION)
      .filter(([, language]) => language === "typescript")
      .map(([extension]) => extension);

    for (const extension of typescriptExtensions) {
      expect(server.extensionToLanguage).not.toHaveProperty(extension);
    }
  });

  it("names an analyzer-backed extension for every route it declares", () => {
    // The other direction: a route for an extension nothing can analyze would
    // send the editor a file this server answers nothing useful about.
    for (const extension of Object.keys(server.extensionToLanguage)) {
      expect(LANGUAGE_BY_EXTENSION).toHaveProperty(extension);
    }
  });
});
