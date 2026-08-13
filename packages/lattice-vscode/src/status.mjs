/**
 * The one thing in the window that says whether anything is being checked.
 *
 * A language status item is the whole user interface of this extension, and it
 * exists because of the invariant the rest of the project is built on: an empty
 * diagnostic list is a claim, not a shrug. In an editor there is nothing to
 * print an exit code onto, so a workspace where the server never started looks
 * pixel-for-pixel like a workspace with no violations. This module is what makes
 * those two look different.
 *
 * It maps a plan to a description and stops there — severity is a string, not a
 * `vscode.LanguageStatusSeverity`, so that this file imports nothing from the
 * editor and can be tested as a function. `extension.mjs` does the mapping, in
 * the one place that is allowed to know what an editor is.
 */

/**
 * @typedef {object} StatusDescription
 * @property {string} text the short label, always visible
 * @property {string} detail the sentence behind it
 * @property {"information" | "warning" | "error"} severity
 */

/**
 * @param {import("./session.mjs").SessionPlan} plan
 * @returns {StatusDescription}
 */
export function describeStatus(plan) {
  switch (plan.state) {
    case "start":
      return {
        text: "Lattice",
        detail: `Module boundaries checked against ${plan.root}`,
        severity: "information",
      };

    case "idle":
      return {
        text: "Lattice: no workspace",
        detail: plan.reason,
        severity: "information",
      };

    case "blocked":
      // Error, not warning, and it is worth being explicit about why: this is
      // the state where the Problems panel is empty because nothing looked. A
      // warning here would be a tool describing its own blindness in the tone of
      // a minor inconvenience.
      return {
        text: "Lattice: not checking",
        detail: plan.reason,
        severity: "error",
      };

    default:
      // Unreachable while `SessionPlan` has three members, and it throws rather
      // than returning a neutral status for the same reason: a fourth state that
      // rendered as "information" would be a new way to be silent.
      throw new Error(`Unknown session state: ${JSON.stringify(plan)}`);
  }
}
