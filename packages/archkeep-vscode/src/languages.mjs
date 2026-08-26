/**
 * Which files this extension asks the server about.
 *
 * The list is the extension's copy of `LANGUAGE_BY_EXTENSION` in
 * `@ecoma-io/archkeep`, and it is a copy for the same reason the Claude
 * Code plugin manifest is one: a client has to name the file types it routes
 * before any server is running, so it cannot ask the server what they are.
 * `routed-extensions.integration.test.mjs` holds this list to that manifest and
 * fails the day the two disagree — which is the only thing that makes a second
 * copy allowed here.
 *
 * A file type missing from this list is the project's own worst failure mode
 * wearing a different hat: the language is checked by the CLI, never in the
 * buffer, and a clean-looking editor is exactly what a missed violation looks
 * like.
 */

/**
 * File extensions routed to the boundary server, leading dot included.
 *
 * TypeScript and JavaScript are deliberately absent. `@nx/enforce-module-boundaries`
 * already reports those through ESLint in any workspace that has it configured,
 * and two enforcers publishing diagnostics at the same site would double every
 * violation a reader sees. What is here is what ESLint cannot read.
 *
 * @type {readonly string[]}
 */
export const ROUTED_EXTENSIONS = Object.freeze([".go", ".rs", ".py", ".vue", ".java"]);

/**
 * Build the document selector the language client matches documents against.
 *
 * Matching is by **glob pattern rather than by language id**, and the difference
 * is load-bearing. A selector of `{ language: "go" }` only matches once some
 * other extension has claimed `.go` files and told VS Code their language id; on
 * a machine without the Go extension installed, every `.go` file is `plaintext`
 * and the client would sit there matching nothing. Nothing would be reported,
 * and nothing would say why.
 *
 * @param {readonly string[]} [extensions] the extensions to route
 * @returns {{ scheme: string, pattern: string }[]} one selector per extension
 */
export function documentSelector(extensions = ROUTED_EXTENSIONS) {
  return extensions.map((extension) => ({
    // `file` only: the server reads from disk to resolve a specifier against the
    // project graph, so an untitled or virtual document has no workspace to be
    // judged against.
    scheme: "file",
    pattern: `**/*${extension}`,
  }));
}
