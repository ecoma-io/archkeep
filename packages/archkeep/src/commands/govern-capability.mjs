/**
 * `govern` capability facade — the word's verb roster as explicit named
 * re-exports: `waivers`, `report`, `debt`, `provenance`, `decisions`, `adr`.
 *
 * Pure surface module: no judgment, no defaults, no logic — every export is
 * a re-export of a command module. `cli.mjs` routes its verb imports through
 * the facade so the vocabulary's code referent is visible to the import
 * graph, not just to a comment (PD-18,
 * ../../../../docs/architecture/refactor/DECISIONS.md).
 */
export { waivers } from "./waivers.mjs";
export { report } from "./report.mjs";
export { debt } from "./debt.mjs";
export { provenanceCommand } from "./provenance-command.mjs";
export { decisions } from "./decisions.mjs";
export { adrCommand } from "./adr.mjs";
