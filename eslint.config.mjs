// Flat ESLint config. Prettier owns formatting — `eslint-config-prettier` is
// last so it switches off every stylistic rule the two would otherwise fight
// over, leaving ESLint to judge correctness only.
//
// There is no TypeScript configuration here, and its absence is a decision
// rather than an omission: what this repository will hold is an Nx plugin, and
// Nx loads a plugin's entry point directly in the process that runs every `nx`
// invocation. A plugin written in plain ESM is loaded as-is; one written in
// TypeScript needs a transpiler resolved and run before the graph can be
// computed at all. So the source here is `.mjs`, and `typescript-eslint` would
// have no program to consult. JSDoc carries the types instead.
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

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
    ],
  },

  js.configs.recommended,

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
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
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

  prettier,
];
