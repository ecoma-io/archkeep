// Flat ESLint config. Prettier owns formatting — `eslint-config-prettier` is
// last so it switches off every stylistic rule the two would otherwise fight
// over, leaving ESLint to judge correctness only.
//
// The repository is `.mjs` with JSDoc — no TypeScript is compiled (root
// `AGENTS.md`, "No TypeScript here, and why") — but `typescript-eslint` is
// still the right ruleset, because its non-type-checked recommended set is a
// strict superset of `eslint-js.recommended` that carries the
// correctness-and-safety rules a gate script and a shipped plugin both need
// (`no-require-imports`, `no-unsafe-function-type`, `no-unused-expressions`,
// prefer-namespace-free spelling) without demanding type information the
// JSDoc program only gets from `tsc`. The type-aware rules live in the block
// below with `projectService`, which hands every file to the nearest
// `tsconfig.json` — the same programs `moon run ...:typecheck` already
// builds, so nothing here invents a second TypeScript view of the tree.
//
// What is deliberately absent: a `**/*.ts` block. The only tracked `.ts`
// files are AssemblyScript sources in `packages/archkeep-rule-sdk-ts/assembly/`
// and its example — TypeScript SYNTAX, a different language — and they are
// compiled and type-checked by `asc` in that package's `typecheck` target
// (`packages/archkeep-rule-sdk-ts/moon.yml` argues it). ESLint touching them
// would be a second, weaker compiler pretending to be a linter.
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".nx/**",
      // Semgrep rule fixtures are deliberately unsafe code whose whole purpose
      // is to be reported by Semgrep. `semgrep --test` is what checks them.
      ".github/semgrep/**",
      // Claude Code worktrees — full clones of this repository, some of them
      // carrying leftover test fixtures whose eslint configs reference the
      // `@nx/enforce-module-boundaries` dialect without a resolvable plugin.
      // Prettier ignores them through `.gitignore`; ESLint reads only its own
      // `ignores`, so the same exclusion is stated here for its own reader.
      ".claude/worktrees/**",
      // Archkeep test fixtures — temporary directories created inside
      // packages/archkeep/ to test boundary config loading and differential
      // analysis. These fixtures contain deliberately incomplete eslint.config.mjs
      // files that reference the @nx/enforce-module-boundaries rule without
      // registering the @nx plugin (they are input to loadEslintBoundaryConfig,
      // not real eslint configs). Without these ignores, eslint . (the lint
      // target) fails when it walks the tree while tests are running or when
      // interrupted runs leave fixtures behind. The three fixture families are:
      // - .eslint-config-fixture-* (eslint-config.integration.test.mjs)
      // - .cli-eslint-config-fixture-* (cli.integration.test.mjs)
      // - .oracle-simple-* (providers/native/differential.integration.test.mjs)
      "**/.eslint-config-fixture-*/**",
      "**/.cli-eslint-config-fixture-*/**",
      // The oracle fixtures share the same lifecycle as the two families
      // above (created under the package root by integration tests, left
      // behind only by an interrupted run); `.oracle-*` covers every
      // spelling, the simple and the composite ones alike.
      "**/.oracle-*/**",
      // Cargo build output — a parallel cargo task mutates this directory mid-walk
      // during `moon run`, causing ESLint to hit ENOENT when a temp rmeta dir
      // vanishes mid-scan. Measured in merge-queue run of #377 for the first
      // package combining eslint and cargo (archkeep-rules).
      "**/target/**",
      // Vitest coverage output: third-party instrumentation runtime
      // (block-navigation.js and friends), regenerated per run, gitignored —
      // never source.
      "**/coverage/**",
    ],
  },

  js.configs.recommended,
  // The non-type-checked recommended set: every `js.configs.recommended`
  // rule with TypeScript-aware spelling and correctness, on plain syntax.
  ...tseslint.configs.recommended,

  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Everything in this repository runs in Node: the gate scripts, the agent
      // hooks, this config, and — once it lands — the plugin itself, inside the
      // `nx` process. Nothing here ever reaches a browser.
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // This repository is ESM-only, and the one spelling of `require` it
      // carries is the documented lazy-import seam —
      // `createRequire(import.meta.url)` reached for optional peers and
      // fixtures (`packages/archkeep/AGENTS.md`, "No sibling package may be
      // imported from here"). The rule cannot tell that seam from CommonJS,
      // so it fires only on architecture.
      "@typescript-eslint/no-require-imports": "off",
      // A gate script's whole output is what it prints, so `console.log` is its
      // interface rather than a leftover debug line. The rule that matters for
      // library code returns with the first package that has any.
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
      // A promise nobody waits for turns a failed check into a green exit code,
      // which is the one defect a gate script must not have.
      "require-atomic-updates": "error",
      "no-return-await": "off",
    },
  },

  {
    // Type-aware rules, on the same programs `moon run ...:typecheck`
    // builds. `projectService` hands each file to its nearest tsconfig
    // program; a file outside every program is a hard error here rather
    // than a silent untyped pass, which is why the four root-level configs
    // sit in this block's `ignores`: `scripts/tsconfig.json` now includes
    // them (they were a verification-free zone before), so `tsc` judges
    // their types, but they belong to no project directory the service can
    // map — and no test file gets the typed rules, because the typed
    // programs exist for shipped code and the tests already answer to
    // `tsc` through the same configs.
    files: ["**/*.mjs", "**/*.js"],
    ignores: [
      "**/*.test.mjs",
      "eslint.config.mjs",
      "commitlint.config.mjs",
      "module-boundaries.config.mjs",
      ".opencode/**/*.js",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // The two promises rules are this repository's whole threat model in
      // rule form: a gate that does not await its check reports green over a
      // violation, and a handler that passes a promise where a boolean is
      // read turns every result true.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },

  prettier,
];
