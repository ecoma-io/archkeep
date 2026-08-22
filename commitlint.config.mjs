// Conventional Commits, enforced by lefthook's commit-msg hook and — for the
// pull request title, which becomes the squash commit's subject — by CI.
//
// This repository is a workspace, so a scope carries real routing information:
// it names which package a change lands in. It stays optional because a change
// to the toolchain itself belongs to no package. Rules and examples:
// CONTRIBUTING.md.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        // One entry per package under `packages/`, plus the three that name a
        // change owning no package. `vscode` is listed before its directory
        // exists so the commit that creates it is not also the commit that
        // has to edit this file to describe itself.
        "lattice",
        "vscode",
        // The rule SDKs — the language, not the directory, because the SDK
        // per language is what a reader routes on and every registry name is
        // `lattice-rule-sdk` with the language implied.
        "rust-sdk",
        "go-sdk",
        "ts-sdk",
        "python-sdk",
        "workspace",
        "docs",
        "deps",
        "ci",
      ],
    ],
    "body-max-line-length": [0],
  },
};
