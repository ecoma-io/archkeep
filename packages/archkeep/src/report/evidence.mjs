/**
 * Re-export only. `buildDecision` lives in `../governance/verdict.mjs`,
 * beside the four-state vocabulary it enforces (#650) — this file used to
 * hold it, which made the core verdict module (`../verdict.mjs`) import the
 * presentation layer, the one import direction the report layer must never
 * own. The path stays for the render-side callers — `src/commands/*` build a
 * decision while composing the payload they render — and importing the
 * governance module directly is equivalent and welcome. What must never
 * reappear here is a second implementation: `evidence.test.mjs` asserts the
 * re-export by identity, so a copy that drifts from the vocabulary's
 * enforcer fails loudly instead of silently disagreeing with it.
 */
export { buildDecision } from "../governance/verdict.mjs";
