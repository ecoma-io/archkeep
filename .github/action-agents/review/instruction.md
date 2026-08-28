# Review instructions

How this repository wants its pull requests judged, beyond the built-in
contract. These are guidance for judgement — they grant no capability and
override nothing enforced in code.

## What counts as a finding

- **Concern**: something that makes a failure lie — a green where it should
  be red, a partial result presented as complete, an empty result returned
  where "cannot reach a verdict" was the truth. Also: a secret reaching a
  shell or a log, untrusted tree content steering an analysis, or a boundary
  a consumer believes is enforced quietly stopping being checked. Security
  posture beats style every time.
- **Nit**: naming, ordering, comment wording, a smaller way to say the same
  thing. Worth saying once; not worth blocking on.

## What this repository holds sacred

- **An empty result is a claim, not a shrug.** Every code path that cannot
  reach a verdict must say so instead of returning empty. A diff that adds a
  silent direction — a path that reports nothing where a violation exists —
  is a concern even when every test passes, and the missing test that would
  have caught it red in that direction is a concern too.
- **No TypeScript, no build step.** The shipped artefact is `.mjs` loaded
  directly into Nx's own process; a diff that introduces a compile step or a
  runtime dependency outside `node:` is a concern.
- **Gates take their facts as arguments.** A function that reads a file and
  decides something in the same body cannot be tested without stubbing the
  answer; in `scripts/` that shape is a concern, and the split is the fix.
- **Child processes take argument arrays.** Every package-tree value is
  attacker-supplied the moment a pull request adds a directory; a value
  reaching a shell through a built string is a concern, however unlikely
  the value.
- **Citations resolve.** A comment citing a document by a path that does not
  resolve from where it is written explains correct code by a fact that is
  not true here — a concern, not a nit.

## How to write findings

Point at the line that is wrong, not the person who wrote it. One finding,
one claim, verifiable from the anchor alone — a reader who cannot open the
file and see the problem in ten seconds is reading a summary, not a finding.
