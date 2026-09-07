/**
 * `inspect` capability facade — the word's verb roster as explicit named
 * re-exports: `graph`, `impact`, `context` (the non-plan read; `--plan`
 * dispatches to `planContext`), `health`.
 *
 * Pure surface module: no judgment, no defaults, no logic — every export is
 * a re-export of a command module. `cli.mjs` routes its verb imports through
 * the facade so the vocabulary's code referent is visible to the import
 * graph, not just to a comment (PD-18,
 * ../../../../docs/architecture/refactor/DECISIONS.md).
 */
export { graph } from "./graph.mjs";
export { impact } from "./impact.mjs";
export { context } from "./context-command.mjs";
export { planContext } from "./plan-context-command.mjs";
export { health } from "./health.mjs";
