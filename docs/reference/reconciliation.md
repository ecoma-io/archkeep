# Reconciliation reference

The scored element and candidate shapes behind `archkeep reconcile` — the
catalogue the report and the JSON envelope both draw from. See
[usage/reconcile.md](../usage/reconcile.md) for how to run it and
[concepts/reconciliation.md](../concepts/reconciliation.md) for what the
comparison means.

## Scored elements

Every element reconcile judges has one state and one classification:

| state        | severity   | means                                                                                                  |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| `match`      | 0          | The element agrees with the model, or is not governed by it.                                           |
| `absent`     | 3          | The model claims something the observed architecture does not build.                                   |
| `unexpected` | 4          | The observed architecture carries something the model does not admit.                                  |
| `unknown`    | `Infinity` | The element could not be verified — only ever produced by a whole-file failure the command refuses on. |

A score of `unknown` is marked as such, never silently read as a match. The
severity ordering — `unexpected` before `absent` — is what the ranked candidate
list sorts by: a forbidden thing being built ranks above a required thing
missing.

### Project classifications

| classification         | state        | means                                                                                 |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------- |
| `match`                | `match`      | Required and present (or the intent has no existence model).                          |
| `projectPresent`       | `unexpected` | The intent forbids this project, and it is observed.                                  |
| `intentUnknownProject` | `unexpected` | The observed architecture carries a project the declared model does not admit.        |
| `projectMissing`       | `absent`     | An intent row requires a project the architecture does not build (scored on the row). |
| `projectTagMissing`    | `absent`     | An intent row requires a tag the project does not carry (scored on the tag plane).    |

### Edge classifications

| classification           | state        | means                                                               |
| ------------------------ | ------------ | ------------------------------------------------------------------- |
| `match`                  | `match`      | Ungoverned, or explicitly allowed.                                  |
| `dependencyForbidden`    | `unexpected` | The intent forbids this `source → target` by name.                  |
| `dependencyNotAllowed`   | `unexpected` | Outside an explicit `dependencies.allowed` allowlist.               |
| `intentForbiddenEdge`    | `unexpected` | A forbidden boundary row is being built (the judge's witness edge). |
| `tagDependencyForbidden` | `unexpected` | A `forbiddenTags` row is being built.                               |

### Intent rows

Every row of the intent file is scored once, in file order, and carries an
`intentRow` identity — `{plane, index, kind, key}` — so a candidate names the
exact row an operator would edit. `dependencies.allowed` rows always score
`match`: an allowlist is a permission, not an existence claim.

## The envelope

`reconcile --format json` uses the same versioned envelope every descriptive
command does ([json-output.md](json-output.md)). In `result`:

| field              | type                        | meaning                                                                                                                                                              |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent`           | object                      | `{file, fingerprint, rows}` — the resolved file name, the SHA-256 fingerprint of the canonicalized intent, and the number of intent rows scored.                     |
| `observed`         | object                      | `{projects, edges, implicitEdges}` — the project count, the code-dependency edge count, and how many `implicit` edges were excluded.                                 |
| `scores`           | object                      | `{projects, edges, tags, boundaries, intentRows}` — the scored element arrays, each element `{plane, name, state, severity, classification, confidence, intentRow}`. |
| `unknownFiles`     | `{file, reason}[]`          | Whole-file failures, when any — the command refuses on them, so always empty on a completed run.                                                                     |
| `candidates`       | absent \| `CandidateEdit[]` | The ranked candidate list. Present only with `--propose`.                                                                                                            |
| `proposed`         | absent \| `true`            | Present only with `--propose`.                                                                                                                                       |
| `notAuthoritative` | absent \| `true`            | Present only with `--propose`.                                                                                                                                       |

## Candidates

With `--propose`, the ranked candidate list. Each candidate is one of four
kinds:

| kind              | edit                                                                                              | evidence behind it                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `add`             | `add in projects` / `add in dependencies`                                                         | `intentUnknownProject`, `dependencyNotAllowed`                                      |
| `removal`         | `remove in projects.required` / `projects.forbidden` / `dependencies.forbidden` / `forbiddenTags` | `projectMissing`, `projectPresent`, `dependencyForbidden`, `tagDependencyForbidden` |
| `tag-change`      | `update required tags in projects.required`                                                       | `projectTagMissing`                                                                 |
| `boundary-change` | `change boundary row`, carrying `{from, to}`                                                      | `intentForbiddenEdge`, `intentAllowedMissing`                                       |

Each candidate carries `{kind, plane, name, state, severity, evidence,
intentRow, edit, proposed: true, notAuthoritative: true}`. The list is sorted by
severity (unexpected before absent), then plane, then name — plain string
comparison throughout, so two runs over an unchanged tree and intent produce
byte-identical output. A candidate is never emitted for a `match` or `unknown`
element, and a divergence that appears on both the edge plane and the intent-row
plane (a forbidden boundary's witness) yields exactly one candidate, on the
intent-row side.

## The text report

```
intent    7768377ec47cb96206c55451864d5776ba01a330cc9d4536b559480f1f009e5d — 5 rows
observed  2 projects, 1 edge
⚠ 1 element: intent rows whose statement is not observed
  + packages → apps  (intentForbiddenEdge)
1 divergence (2 projects and 1 edge)
proposal  1 candidate, ranked — proposed, not authoritative, never written
  boundary-change  packages → apps  (change boundary row in boundaries — …)
           — apply none of these without review; architecture-intent.json is untouched
```

`+` marks an `unexpected` element, `-` an `absent` one, `?` an `unknown` one.
Names and values are control-character-sanitized before printing.
