/**
 * The one owner of this package's two spawn budgets, so the numbers a test
 * helper states and the number vitest enforces cannot drift apart again.
 *
 * `SPAWN_BUDGET_MS` bounds ONE spawned child process — the value handed to
 * `spawnSync`. A bounded spawn is what keeps a wedged or contended child from
 * blocking the worker thread indefinitely, a state no vitest timeout can
 * interrupt because the thread is stuck inside the syscall (#41). The CLI
 * exits well under a second when healthy, so this is generosity, not a target.
 *
 * `SPAWN_TEST_BUDGET_MS` is the vitest-side ceiling every test or fixture hook
 * that spawns must run under. Vitest's untouched default is 5000 ms — six
 * times tighter than the single-spawn budget above — so a test making
 * back-to-back cold starts went red under full-suite parallel load while its
 * helper still believed it had 30 s (#249): two bounds, unaware of each other,
 * and the tighter one was the one nobody chose. It derives as twice the
 * single-spawn budget, enough for the heaviest spawn test's two sequential
 * cold starts, and stays strictly above it by construction. The global
 * default is deliberately left alone: raising 5000 ms package-wide would let
 * a genuinely hung test idle for a minute instead of failing fast.
 *
 * A test or hook that spawns takes both numbers from here — describe-level
 * `{ timeout: SPAWN_TEST_BUDGET_MS }` for suites whose tests spawn, the same
 * value as `beforeAll`'s hook-timeout argument where fixture setup spawns, and
 * `timeout: SPAWN_BUDGET_MS` beside every `spawnSync`. Never write a fresh
 * literal beside these.
 *
 * `src/spawn-budget.test.mjs` pins both halves of that rule: the ordering
 * fails loudly if the derivation is ever broken, and a walk over every
 * `*.test.mjs` under `src/` fails if any file calls `spawnSync` without
 * importing these constants — the same parse-the-source move
 * `../../../scripts/check-packages.mjs` applies to ci.yml.
 *
 * Test infrastructure only: nothing shipped may import this module.
 */

/** The ceiling for one spawned child process, in milliseconds. */
export const SPAWN_BUDGET_MS = 30_000;

/**
 * The ceiling for one vitest test or fixture hook that spawns processes, in
 * milliseconds — derived, never stated independently.
 */
export const SPAWN_TEST_BUDGET_MS = 2 * SPAWN_BUDGET_MS;
