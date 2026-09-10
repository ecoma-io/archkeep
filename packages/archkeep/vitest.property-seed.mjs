/**
 * Pins fast-check's seed when `CI` is set, loaded through this project's
 * `setupFiles` so it runs once per test process before any test file.
 *
 * Property tests run a bounded search whose seed varies per run — that is the
 * point on a dev machine (every executed run explores new input space), and
 * exactly wrong on CI: a CI red must be attributable to the change that caused
 * it, never to an unlucky seed landing on an unrelated PR, and Nx task caching
 * assumes same inputs → same result. So CI pins the seed; dev runs keep
 * exploring. A failing dev run prints its seed in the test title
 * (`with seed=…`) for replay.
 *
 * ## Seed selection
 *
 * - `ARCHKEEP_PROPERTY_SEED=<n>`: single explicit seed (backward-compatible;
 *   default 42 on CI when no env var is set).
 * - `ARCHKEEP_PROPERTY_SEEDS=a,b,c`: comma-separated list; the CI leg
 *   exercises at least three fast seeds (one per vitest worker), and a nightly
 *   sweep passes a longer list via this env var. Each worker deterministically
 *   picks `seeds[worker % seeds.length]`, so exactly `min(workers, seeds)`
 *   distinct seeds are exercised per invocation.
 * - `ARCHKEEP_PROPERTY_NUM_RUNS=<n>`: overrides the fast-check `numRuns`
 *   default (100). The CI leg uses a lower value for speed; nightly uses the
 *   full default.
 *
 * When `ARCHKEEP_PROPERTY_SEED` is set it takes precedence over the list.
 * When neither env var is set, `ARCHKEEP_PROPERTY_SEEDS` defaults to "42".
 *
 * It sits INSIDE this project rather than at the workspace root, and that is
 * sound today for one reason only: this is the sole
 * project in the workspace that runs property tests, so there is nothing to
 * synchronise with. The moment a second one arrives, this file and the seed it
 * pins hoist to the root — a per-project copy of a value two projects share is
 * an unsynced config, not a hardcode. The seed value itself is arbitrary: any
 * constant yields a valid fixed sample, and there is nothing to derive it from
 * without reintroducing the run-varying randomness the pin exists to remove.
 */
import { fc } from "@fast-check/vitest";

if (process.env.CI) {
  const singleSeed = process.env.ARCHKEEP_PROPERTY_SEED;
  if (singleSeed !== undefined) {
    // Explicit single seed — backward-compatible CI pin or per-invocation override.
    fc.configureGlobal({ seed: Number(singleSeed) });
  } else {
    // Multi-seed leg: each vitest worker deterministically picks a seed from
    // the comma-separated list so the invocation exercises several distinct
    // seeds. The CI leg sets at least three (fast); nightly passes a longer
    // list behind ARCHKEEP_PROPERTY_SEEDS.
    const seeds = (process.env.ARCHKEEP_PROPERTY_SEEDS ?? "42").split(",").map(Number);
    const workerId = Number(process.env.VITEST_WORKER_ID ?? "0");
    const seed = seeds[((workerId % seeds.length) + seeds.length) % seeds.length];
    fc.configureGlobal({ seed });
  }
  const numRuns = process.env.ARCHKEEP_PROPERTY_NUM_RUNS;
  if (numRuns !== undefined) {
    fc.configureGlobal({ numRuns: Number(numRuns) });
  }
}
