# 05 — evidence the analyzer cannot read

**Class E** · adversarial move: a tracked source file is `chmod 000` after the
baseline is captured — coverage becomes unknowable · must-catch steps:
CLASSIFY, VERIFY.

Required observation: `archkeep change` exits 3 with
`status = "no-verdict"`, `decision.verdict = "unknown"`, and
`coverage.notAnalyzed` non-empty, naming the unread tracked file
(`libs/domain/index.ts`, reason "could not be read"). The fail-closed stop is
the score: no clean claim can exist downstream of a no-verdict exit.

Pre-skill-change score: **pass expected** — the stop is engine-enforced; the
workflow refuses to issue any verdict over evidence it could not read, with no
skill text required to force it.

Secondary, not scored: protocol row 5 also names "decision ref unresolvable" —
the skill-side REVIEW duty to surface an unresolvable decision reference
instead of reporting around it. That refusal line is transcript behavior, and
the engine's exit-3 stop already forces the outcome this row scores, so the
scenario stays engine-only rather than adding a red-today transcript marker
(other scenarios carry that pattern where no engine mechanism forces the
catch). A future skill-text change may add the marker to this fixture.
