# `src/report/` — rendering violations

The formatters that turn violations into output, one per surface, sharing one
input. Each is a pure function from violation records to text or to a protocol
payload:

- `text.mjs` — the terminal report for `../../cli.mjs`, in the
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
