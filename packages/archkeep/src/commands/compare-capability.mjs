/**
 * `compare` capability facade — the word's verb roster as explicit named
 * re-exports: `diff`, `delta`, `change`, `drift`, `reconcile`, `history`,
 * `trajectory`, `evolution`.
 *
 * Pure surface module: no judgment, no defaults, no logic — every export is
 * a re-export of a command module. `cli.mjs` routes its verb imports through
 * the facade so the vocabulary's code referent is visible to the import
 * graph, not just to a comment (PD-18,
 * ../../../../docs/architecture/refactor/DECISIONS.md).
 */
export { diffCommand } from "./diff.mjs";
export { captureDelta, deltaCommand } from "./delta.mjs";
export { changeCommand } from "./change.mjs";
export { driftCommand } from "./drift.mjs";
export { reconcileCommand } from "./reconcile.mjs";
export { historyCommand } from "./history.mjs";
export { trajectoryCommand } from "./trajectory.mjs";
export { evolutionCommand } from "./evolution.mjs";
