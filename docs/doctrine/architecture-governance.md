# Architecture governance

How the architecture stays enforced, who decides what changes, and why a rule
that nobody can bypass is the only kind worth having.

## The constraint table is the architecture

The constraint table — the file the workspace names as its boundary law — is the
single place where architectural intent is stated in a form a machine can check.
Everything else is mechanism. A document describing the intended layering is
valuable; a constraint table that _computes_ whether the layering holds is what
makes it architecture rather than aspiration.

The table lives in the consumer's repository, reviewed like the code it governs,
and nothing in this project holds a copy. That is deliberate: a second copy
would drift, and the two would disagree the day one changed.

## One table, three surfaces

The same constraint table is read by every surface: the CLI, the language server,
and — where the workspace wires it — the ESLint rule. One file, one answer.
The CLI's exit code, the editor's diagnostic, and the lint target's verdict all
come from the same constraint rows applied to the same records. A finding that
appears in one and not the others is a bug, not a feature.

## The exit code is the gate

In a pipeline, the architecture's gate is the exit code. Exit 0 is clean, 1 is
findings, 3 is "could not look" — and collapsing 3 into 0 converts an outage
into a green build. [ci.md](../usage/ci.md) owns the full recipe; what belongs
here is why that distinction is architectural rather than operational.

A gate that can silently stop checking is a gate that has already failed. The
exit-code contract makes that failure loud, and every consumer of the verdict —
a CI step, a pre-commit hook, a script that branches on the JSON envelope —
gets the same contract.

## Who decides what changes

The constraint table is code. It is reviewed in a pull request like any other
code change, and it lands through the same merge process. That is the governance
model: the architecture changes when someone writes the change, opens the PR,
and the change is reviewed and merged — exactly like a change to source.

There is no dashboard, no hosted service, and no rule-authoring UI. A tool that
edits the constraint table from outside the repository breaks the property that
makes it trustworthy: that the architecture and the code are in the same place,
reviewed at the same time, by the same people.

## Suppressions are part of the architecture

When a violation is real and the workspace is going to live with it, the
suppression goes in the table with a mandatory reason — not in a comment, not
in a meeting note, and never silently. An unexplained suppression is
indistinguishable from a boundary that quietly stopped being enforced.

Suppressions are visible in every report. A CI run that lists suppressions is a
run that makes the accepted drift legible; a run that hides them is one where
the reader has to trust that someone, somewhere, made a decision.

## When to widen, when to extract, when to re-tag

The constraint table is an allowlist over projects and edges. Adding a row can
only ever make the workspace stricter (rows compose with AND), so the three
ways to resolve a violation are, in order of preference:

1. **Re-tag** one of the two projects, so the existing row allows what was
   always intended.
2. **Restructure** the dependency, so the edge no longer exists.
3. **Widen** the row, so it permits a dependency that the current tags forbid.

Widening is the last resort because it applies to every project carrying the
source tag, not just the one that needed it. A widened row is a weaker rule, and
weakness compounds: the next project with the same tag assumes the wider
permission is intentional.

## What "architecture as code" costs

Three things that are easy to underestimate:

- **The table must be complete.** A project matching no row is a violation, not
  an unrestricted project. Adding a project without tags fails on its first
  dependency, which is the rule most often reported as a bug and the one doing
  the most work.
- **The tags must be chosen before they are needed.** An axis invented after
  three projects already depend across it is an axis that gets a blanket row
  to make the build pass, and that row enforces nothing.
- **The table must be reviewed.** A constraint whose `sourceTag` no project
  carries proves nothing while reading as protection. It is indistinguishable,
  in every report, from a rule that works.

---

- The principles this governance rests on → [principles.md](principles.md)
- What the constraint table actually contains → [../concepts/boundaries.md](../concepts/boundaries.md)
- The exit codes and CI recipe → [../usage/ci.md](../usage/ci.md)
- How the architecture stays honest across surfaces → [../concepts/architecture.md](../concepts/architecture.md)
