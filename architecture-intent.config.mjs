/**
 * Lattice's own declared intended architecture — the drift the `check` command
 * folds into its verdict when this file is present at the `intentConfig` name.
 *
 * This is the tool run on itself, the same argument the root
 * `module-boundaries.config.mjs` makes: a repository that ships an architecture
 * enforcer should state the architecture it intends, or it is asking consumers
 * to trust a claim it never tested on itself. Two assertions, each chosen to
 * be meaningful on this tree:
 *
 *   - Both projects must exist. `lattice` (the engine) and `lattice-vscode`
 *     (the editor client) are the two things this repository ships; either one
 *     vanishing is drift worth failing on.
 *   - `lattice` must not depend on `lattice-vscode`. The root boundary law
 *     states that direction as the one case with teeth (`type-package` may
 *     only depend on another `type-package`; the extension depends on the
 *     package, never the reverse). The observed graph has ~zero edges today,
 *     so this row is a stated law with no case to judge yet, the same bargain
 *     `module-boundaries.config.mjs` makes for its rows that do not fire.
 *
 * Tags use dash separators (`type-package`, `scope-nx`) because the Moon
 * provider emits Moon's tags verbatim, and Moon tags cannot contain colons —
 * see `module-boundaries.config.mjs`'s header for the full argument.
 */
export default {
  projects: {
    required: [
      { name: "lattice", tags: ["type-package", "scope-nx"] },
      { name: "lattice-vscode", tags: ["type-extension", "scope-nx"] },
    ],
  },
  dependencies: {
    forbidden: [{ source: "lattice", target: "lattice-vscode" }],
  },
};
