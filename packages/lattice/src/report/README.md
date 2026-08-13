# `src/report/` — rendering violations and descriptive payloads

The formatters that turn command output into text or protocol payloads, one per
surface, sharing one input. Each is a pure function from records to output:

- `text.mjs` — the terminal report for `../../cli.mjs`'s `check`, in the
  `file:line:column` shape an editor and a terminal both make clickable — which
  is why the analysis record carries 1-based positions
  (`../analysis/contract.md`);
- `sarif.mjs` — SARIF 2.1.0 for CI, so a failing job can be read without
  scraping a human report, and so GitHub can annotate the diff. The failure it
  guards against is a file GitHub silently rejects: the job stays green, no
  annotation appears, and nothing says why. Nothing here validates against the
  published schema — there is no schema validator in this workspace at all.
  What `sarif.integration.test.mjs` pins instead is the subset of the 2.1.0
  schema a rejected upload turns on, checked against the real message table:
  `version`, `tool.driver.name`, a `ruleId` that resolves in the catalogue, a
  non-empty `message.text`, and a repository-relative `uri` with a 1-based
  `startLine`/`startColumn`.
- `graph-text.mjs` — the terminal report for `../../cli.mjs`'s `graph` command:
  projects with their outgoing edges listed beneath each one, `(no
dependencies)` for projects with no edges, and a coverage claim above the
  listing. Renders the same payload `json.mjs` wraps; decides nothing.
- `diff-text.mjs` — the terminal report for `../../cli.mjs`'s `diff` command:
  baseline/head summaries, added/removed sections, and a change count. Empty
  sections are omitted so "no changes" and "0 added, 0 removed" never look
  identical. Renders the same payload `json.mjs` wraps; decides nothing.

`json.mjs` is not a formatter in that sense — it does not turn violations into
output. `jsonEnvelope` wraps whatever result object a command already computed
(`../../cli.mjs`'s `check` builds its own `result.violations`/`result.goWork`/
`result.tsconfigPaths`) in one versioned envelope every `--format json`
consumer shares, and enforces in code the three consistency rules
`docs/usage/json-output.md` documents in prose: `status: "ok"` never rides
incomplete coverage, `status` and `exitCode` never disagree, and
`coverage.complete` never disagrees with whether `coverage.notAnalyzed` is
empty. It throws rather than degrade on any of the three, because a mismatch
there is a bug in the command that built the envelope, not a fact about the
workspace being judged.

## Where the LSP conversion lives, and why not here

Not here. Language Server Protocol positions are 0-based and the analysis
record's are 1-based, and the subtraction is in `../lsp/diagnostics.mjs` beside
the rest of the protocol shaping — because a diagnostic is more than a
converted position, and splitting it across two directories would put half a
format in each. `../../CLAUDE.md` records the same division: everything with a
decision in it lives under `src/lsp/`, and `lsp.mjs` holds only the wiring.

## The two formats say the same thing in different places

The terminal report puts the constraint row that fired on its own line; SARIF
appends it to `message.text`, because GitHub renders that field and nothing
else. Both carry the upstream `messageId` unchanged — SARIF as `ruleId`, text
as the first line — since that id, not the prose, is what makes a verdict
comparable to ESLint's.

## What must not land here

- **Any decision about whether something is a violation.** A formatter that
  filters is a rule wearing a formatter's name, and it will disagree with the
  rule engine the first time one of them changes.
- **A process exit code.** The exit-code table is `../../cli.mjs`'s contract
  and is documented in its header.
