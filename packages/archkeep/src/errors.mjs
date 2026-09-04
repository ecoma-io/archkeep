/**
 * The typed error `cli.mjs`'s exit-code classification keys on.
 *
 * Which caught errors mean "the caller's argument is wrong" (exit 2) and
 * which mean "the run could not look" (exit 3) used to be decided by testing
 * `error.message` against a regex at every catch site in `../cli.mjs`. Prose
 * is not a contract: rewording a message flipped an exit code with nothing
 * failing anywhere — the stderr text still named the mistake, so only the
 * verdict moved, and no gate watched that line. The throw sites now carry
 * the decision as a class and the catch sites test `instanceof`, so a
 * message can be reworded without moving an exit code.
 *
 * `UsageError` covers exactly the refusals those regexes matched: a path
 * outside the workspace or matching no tracked file (`./workspace.mjs`'s
 * `selectFiles`), an unknown project name (`./commands/impact-reachability.mjs`'s
 * `computeImpact`, `./commands/context-command.mjs`'s
 * `collectProjectContext`), and a malformed `file:line:column` site string
 * (`./commands/explain.mjs`'s `parseSite`). They are one mistake in four
 * spellings — retyping the argument is the fix, which is what separates
 * them from every other failure a run can hit; a run that never reached a
 * verdict throws a plain `Error` and stays exit 3, so "could not look" is
 * never mistaken for "looked and found the caller at fault"
 * (`../AGENTS.md`, check's four exit codes).
 *
 * One class, nothing else exported: a second class needs a catch site that
 * treats two of these mistakes differently, and none does. Beside it sits the
 * one error-SHAPE predicate the engine shares (`isEnoent` below) — a test of
 * what a caught value looks like, not a decision about what one means, which
 * is why it lives with the error primitives rather than at any catch site.
 */
export class UsageError extends Error {
  /**
   * @param {string} message Printed verbatim on stderr; tests pin it.
   */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Is this caught value the filesystem's "no such file or directory"?
 *
 * Node's `fs` throws the raw error with `code: "ENOENT"` set directly;
 * `./process.mjs`'s `runProcess` wraps its child's failure and carries the
 * original on `cause` — so the shape arrives both ways, and every site that
 * distinguishes "absent" from "could not read" was spelling the test by hand
 * (`#652`). The two legs together are the one definition; a catch site adds
 * its own meaning on top (absent store, absent registry, install Moon), which
 * is exactly the logic this predicate does not own.
 *
 * @param {unknown} error The caught value, of any shape.
 * @returns {boolean}
 */
export function isEnoent(error) {
  const thrown = /** @type {{code?: unknown, cause?: {code?: unknown}}|null|undefined} */ (error);
  return thrown?.code === "ENOENT" || thrown?.cause?.code === "ENOENT";
}
