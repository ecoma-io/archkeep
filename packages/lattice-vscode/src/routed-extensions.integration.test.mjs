/**
 * The extension's routed file types, checked against the server's own manifest.
 *
 * `ROUTED_EXTENSIONS` is the third copy of one fact. `LANGUAGE_BY_EXTENSION` in
 * `@ecoma-io/nx-polyglot-graph` owns it, the Claude Code plugin manifest repeats
 * it because JSON cannot import, and this package repeats it because a client
 * has to name what it routes before any server is running. Rule 14 allows a copy
 * only when something keeps it honest; for the second copy that is
 * `src/lsp/editor-config.integration.test.mjs`, and for this one it is this file.
 *
 * The manifest is read rather than imported, and the distinction is not
 * cosmetic: an import would be a cross-project module edge, which this package's
 * `type:extension` tag forbids and the repository's own boundary check would
 * fail on. Reading a sibling's data file in a test is not a dependency — nothing
 * in the shipped extension reaches across.
 *
 * What breaks without this test is the failure this whole project exists to
 * prevent, one layer out: a language the CLI checks and the editor never asks
 * about. The buffer stays clean, and clean is what a missed violation looks
 * like.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ROUTED_EXTENSIONS } from "./languages.mjs";

const MANIFEST_PATH = new URL(
  "../../nx-polyglot-graph/.claude-plugin/plugin.json",
  import.meta.url,
);

describe("the file types this extension routes", () => {
  it("are exactly the ones the server package's own editor manifest routes", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const [server] = Object.values(manifest.lspServers);
    const routed = Object.keys(server.extensionToLanguage);

    // Sorted on both sides: the two lists are the same set, and the order they
    // happen to be written in is not a contract either file owes the other.
    expect([...ROUTED_EXTENSIONS].sort()).toStrictEqual(routed.sort());
  });

  it("reads a manifest that is actually there", () => {
    // The silent-direction case for the assertion above. A moved or renamed
    // manifest would otherwise make `JSON.parse` throw with a filesystem message
    // that reads like an environment problem rather than a broken invariant —
    // and a version of this test written with a try/catch would have passed.
    expect(() => readFileSync(MANIFEST_PATH, "utf8")).not.toThrow();
  });
});
