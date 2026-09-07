/**
 * `compare` capability facade — the word's verb roster as explicit named
 * re-exports: `diff`, `delta` (both modes), `change`, `drift`, `reconcile`,
 * `history`, `trajectory`, `evolution`, plus the output guards the two
 * verbs that write reports declare (`change`, `history`, `trajectory`).
 *
 * Pure surface module: no judgment, no defaults, no logic — every export is
 * a re-export of a command module. `cli.mjs` routes its verb imports through
 * the facade so the vocabulary's code referent is visible to the import
 * graph, not just to a comment (PD-18,
 * ../../../../docs/architecture/refactor/DECISIONS.md).
 */
export { diff } from "./diff.mjs";
export { captureBaseline, delta } from "./delta.mjs";
export { change, changeOutputRefusal } from "./change.mjs";
export { drift } from "./drift.mjs";
export { reconcileCommand } from "./reconcile.mjs";
export { history, historyOutputRefusal } from "./history.mjs";
export { trajectoryCommand, trajectoryOutputRefusal } from "./trajectory.mjs";
export { evolutionCommand } from "./evolution.mjs";
