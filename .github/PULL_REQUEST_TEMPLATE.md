## Description

<!-- What changes, and why. Link the issue this closes. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] A language's manifests read into the graph
- [ ] A boundary rule, or a change to how one is judged
- [ ] Editor / language-server behaviour
- [ ] Breaking change (a consumer must edit configuration or code to upgrade)
- [ ] Documentation
- [ ] Build, CI, or repository tooling

## Consumer impact

<!-- Say what a consumer sees after upgrading — in their graph, in their CI
output, in their editor. Write "none" if nothing changes for them, and say so
explicitly rather than leaving it out. -->

- [ ] No change to what is reported on an unchanged workspace
- [ ] What is reported changes, and the change is described above

## Could this fail silently?

<!-- The question this project is judged on. An empty result and a clean
workspace look identical, so a defect here does not announce itself. -->

- [ ] This change cannot cause a violation to go unreported
- [ ] It could, and a test pins the case where it would

<!-- If a rule or a graph reader changed: name the test that goes red when the
verdict is wrong in the SILENT direction, not just the loud one. -->

## How this was verified

<!-- What you actually ran and saw, not what should happen. -->

**Steps:**

1.
2.

- [ ] Tests added or updated, and I watched the new one fail before it passed
- [ ] Ran against a real workspace, not only fixtures

## Checklist

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm test` and `pnpm check-packages` all pass locally
- [ ] I have self-reviewed this diff
- [ ] Documentation is updated in the same pass as the behaviour it describes
- [ ] No unrelated changes are included
- [ ] I have the right to contribute this work under the Apache License 2.0

## AI-assisted development

- [ ] This pull request is AI-assisted (drafted or substantially written by an AI coding agent)
- [ ] Each such commit carries its disclosure trailer: `Assisted-by: <tool>`, or `Generated-by: <tool>` where the tool produced substantially the whole commit

<!-- Name the tool and model, e.g. "Claude Code, opus". A description can be
edited later and no clone carries it — the commit trailer travels with the code. -->
