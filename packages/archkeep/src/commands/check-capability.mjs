/**
 * `check` capability facade — the word's verb roster as explicit named
 * re-exports: `check`, `fitness`, `scenario`.
 *
 * Pure surface module: no judgment, no defaults, no logic — every export is
 * a re-export of a command module. `cli.mjs` routes its verb imports through
 * the facade so the vocabulary's code referent is visible to the import
 * graph, not just to a comment — the vocabulary's roster lives in
 * ../../../../docs/concepts/architecture.md's "The 24 commands".
 */
export { check, sortViolations } from "./check.mjs";
export { fitness } from "./fitness.mjs";
export { scenario } from "./scenario.mjs";
