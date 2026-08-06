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
 * It sits INSIDE this project rather than at the workspace root, which is Rule
 * 14 rung 3 and passes its rubric today for one reason only: this is the sole
 * project in the workspace that runs property tests, so there is nothing to
 * synchronise with. The moment a second one arrives, this file and the seed it
 * pins hoist to the root — a per-project copy of a value two projects share is
 * an unsynced config, not a hardcode. The seed value itself is arbitrary: any
 * constant yields a valid fixed sample, and there is nothing to derive it from
 * without reintroducing the run-varying randomness the pin exists to remove.
 */
import { fc } from "@fast-check/vitest";

if (process.env.CI) {
  fc.configureGlobal({ seed: 42 });
}
