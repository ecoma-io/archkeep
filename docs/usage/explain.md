# `lattice explain`

Explain the judgment for one import site.

```shell
lattice explain libs/alpha/main.go:10:5
lattice explain libs/alpha/main.go:10:5 --format json
lattice explain libs/alpha/main.go:10:5 --format json --output explanation.json
```

`explain` takes a `file:line:column` site, finds the matching import record,
and explains the judgment: which constraint row matched, which tags applied,
whether it is a violation and why. It is descriptive: it never exits 1, because
an explanation of what the rules decided is never a finding (only `check` ever
exits 1).

## What the explanation contains

- **The position** — the `file:line:column` of the import site, same shape the
  terminal and the editor both make clickable.
- **The import** — the specifier as written and its kind (`static` or `dynamic`).
- **The source project** — the project that owns the file, with its tags.
- **The target project** — the project the import reaches, with its tags.
  `(unresolved)` when the target could not be resolved to a project.
- **The constraint rows that matched** — which `depConstraints` rows applied to
  the source project's tags. `(none)` when no row matched. When a constraint
  row carries `description` or `remediation`, those appear indented below it.
- **The verdict** — `allowed` when no constraint was violated; `VIOLATION` with
  the `messageId`, the message, the rule description (when present), and the
  remediation guidance (when present) when one was.
- **Coverage** — whether this explanation is complete, same shape as every other
  command's footer.

When the import site could not be resolved statically (e.g. a dynamic `import()`
with a non-literal argument), the verdict is `UNRESOLVABLE` and the reason is
given instead of a project or constraint answer.

## Exit codes

| code | meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | The explanation was produced, and coverage is complete.                 |
| 2    | Usage error: wrong argument count, unknown flag, malformed site string. |
| 3    | The explanation was produced, but coverage is incomplete.               |

`explain` never exits 1. An explanation is descriptive — only `check` exits 1.

## The unregistered-plugin refusal

Same as `graph` and `diff`: on an Nx workspace whose `nx.json` does not
register the Nx integration but whose tracked files include polyglot manifests under
project roots, `explain` refuses loudly rather than explaining a judgment from
a graph whose edges silently under-represent the real architecture.

## When the site does not exist

`explain` throws when the given position does not correspond to any import the
tool found — because explaining a position that was never reached would be a
claim about a judgment that never happened. Two cases are distinguished:

- **Whole-file failure** — the file could not be analyzed at all (unreadable,
  no analyzer, a config it depends on that would not load). The error names the
  file and the reason.
- **No import at that position** — the file was analyzed, but that line and
  column do not hold an import. The error names the position and reminds that
  line and column are 1-based.

A site-level failure (the file was analyzed but this one import could not be
resolved) is not an error — it is an `UNRESOLVABLE` verdict, because the
judgment was reached and the answer is that the site has no statically knowable
target. The one exception is a literal import that names a DECLARED project and
cannot be resolved: that is a missing workspace edge, a whole-file failure the
run refuses a verdict over, not a site blind spot.

## Why `explain` runs the full evaluation

`explain` runs `evaluate()` over every import site, then filters to the one
the caller asked about. A single-site evaluation would miss rules that depend
on the whole file graph — circular dependencies and lazy-load constraints are
computed across all sites at once, not one site at a time. The full evaluation
is pure and costs nothing to run; a partial one would give a wrong answer for
those rules.
