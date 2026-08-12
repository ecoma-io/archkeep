# `src/commands/` — one module per CLI command

One module per CLI command, holding the computation and nothing about argv,
exit codes or where output goes. `../../cli.mjs` owns those three. A module
here may read the graph, the workspace and the policy; it may not print, and
it may not decide the process's exit code — it returns a status and `cli.mjs`
maps it.

`context.mjs` is the exception in kind, not in rule: it is the preamble the
commands share rather than a command. It composes `../workspace.mjs`,
`../providers/` and `../options.mjs`; it does not reimplement any of them.
