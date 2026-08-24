# Upgrading from Lattice

Archkeep is the same tool under a different name. The analysis did not change,
the verdicts did not change, and no rule means anything different than it did
before. What changed is every name the tool is reached by — and three of those
changes break a workspace that does not follow them, which is why this page
exists rather than a line in a changelog.

If you have never installed Lattice, you do not need this page.
[installation.md](installation.md) is the way in.

## What breaks, and what does not

Three things stop working until you change them, and each fails loudly rather
than quietly — an unfound config file, an unresolved binary, a rule that will
not load. None of them can silently pass a workspace that should fail, which is
the property that decided the cutover
([the decision record](../adr/0003-rename-lattice-to-archkeep.md) argues why
each is a clean break rather than a dual-support window).

Everything else is a rename you can do at your own pace: the old packages stay
installable at the versions you already have. Nothing was unpublished.

## 1. The packages

| was                                                        | is                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `@ecoma-io/lattice`                                        | `@ecoma-io/archkeep`                                         |
| `@ecoma-io/lattice-rule-sdk`                               | `@ecoma-io/archkeep-rule-sdk`                                |
| `lattice-rule-sdk` (crates.io)                             | `archkeep-rule-sdk`                                          |
| `lattice-rule-sdk` (PyPI)                                  | `archkeep-rule-sdk`                                          |
| `github.com/ecoma-io/lattice/packages/lattice-rule-sdk-go` | `github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go` |

```bash
npm uninstall @ecoma-io/lattice && npm install -D @ecoma-io/archkeep
```

The Go module path is the module's identity, so an import rewrite is the whole
change — there is no `/v2` suffix, because the major version has not moved.

## 2. The commands

The binaries are `archkeep` and `archkeep-lsp`. Anywhere a script, a CI job or
a git hook says `lattice`, it now says `archkeep`; the subcommands, the flags
and the [exit codes](../reference/exit-codes.md) are untouched.

```diff
-  - run: npx lattice check
+  - run: npx archkeep check
```

## 3. The workspace file — **breaking**

`lattice.json` is now `archkeep.json`. The contents do not change; only the
name does.

```bash
git mv lattice.json archkeep.json
```

A workspace still carrying `lattice.json` is not found — the run fails, it does
not fall back and it does not report a clean tree. If you register the
workspace through `nx.json` or Moon instead, there is nothing to rename here;
[configuration.md](../reference/configuration.md) owns which surface holds what.

## 4. Custom rules — **breaking**

The wasm ABI's export names moved from `lattice_alloc` / `lattice_describe` /
`lattice_evaluate` to their `archkeep_` spellings. **Every compiled `.wasm`
rule must be rebuilt against the new SDK**, whichever language wrote it. A rule
built against the old SDK does not load, and a rule that does not load is a
load error rather than a rule that quietly judges nothing.

1. Update the SDK dependency to its new name (the table above).
2. Rebuild the artifact — your SDK's README owns its build story.
3. Re-record the `sha256` in the `customRules` row that pins it, because the
   bytes changed.

[usage/custom-rules.md](../usage/custom-rules.md) walks the whole loop;
[reference/custom-rules.md](../reference/custom-rules.md) is the contract
itself.

## 5. The Nx plugin

The string in your `nx.json` names the package, so it moves with it:

```diff
-    { "plugin": "@ecoma-io/lattice/nx", "options": { ... } }
+    { "plugin": "@ecoma-io/archkeep/nx", "options": { ... } }
```

[integrations/nx.md](../integrations/nx.md) owns the options; none of them
changed. Moon workspaces have no equivalent string to edit
([integrations/moon.md](../integrations/moon.md)).

## 6. The VS Code extension

The extension is `ecoma-io.archkeep`. It was never published to the
Marketplace under the old name, so there is no installed listing to upgrade —
if you side-loaded a `.vsix` from a GitHub release, uninstall it and install
the new one.

Its two settings and two commands carry the new prefix, and VS Code does not
migrate setting keys on its own:

```diff
-  "lattice.server.path": "…",
-  "lattice.trace.server": "verbose"
+  "archkeep.server.path": "…",
+  "archkeep.trace.server": "verbose"
```

`lattice.restart` and `lattice.showLog` are `archkeep.restart` and
`archkeep.showLog`; a keybinding naming the old ids does nothing.
[integrations/vscode.md](../integrations/vscode.md) owns the rest.

## 7. The agent plugin

The Claude Code and Codex plugin is `archkeep`, from the `archkeep`
marketplace. Re-add it rather than editing the cached copy —
[skills/installation.md](../skills/installation.md) owns the steps for each
host. The five `arch-*` skills kept their names.

## What is still called Lattice, on purpose

- **The versions already published.** `@ecoma-io/lattice`, the old SDK names on
  every registry, and the Go module's existing tags stay resolvable exactly as
  they are. They carry a deprecation notice pointing here; they were not
  unpublished, and a build pinned to one of them keeps working.
- **This repository's changelog and its first two decision records.** They
  describe what was true when they were written.

## If something still says Lattice after you finish

That is a bug, and the issue tracker is the place for it — with one exception:
a `node_modules` directory or a lockfile that still names the old package
because the install has not been re-run. `rm -rf node_modules` and install
again before filing.
