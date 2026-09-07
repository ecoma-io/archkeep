/**
 * `analyze` capability facade — the word's verb roster as explicit named
 * re-exports: `discover`.
 *
 * Pure surface module: no judgment, no defaults, no logic — every export is
 * a re-export of a command module. `cli.mjs` routes its verb imports through
 * the facade so the vocabulary's code referent is visible to the import
 * graph, not just to a comment (PD-18,
 * ../../../../docs/architecture/refactor/DECISIONS.md).
 */
export { discoverCommand, proposalToIntent } from "./discover.mjs";
