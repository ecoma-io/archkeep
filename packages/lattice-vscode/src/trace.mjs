/**
 * The trace wiring, as a pure decision so a test can pin it without an editor.
 *
 * `lattice.trace.server` is a declared setting, and a declared setting that
 * nothing reads is a promise (`audit B-F12`). The language client makes the
 * setting live only when its `traceOutputChannel` option is set — and the
 * `traceOutputChannel` getter falls back to `outputChannel` when it is not,
 * so a client that never passes it still works while the setting silently
 * does nothing. Passing the SAME channel for both is what binds the setting
 * to a mechanism, which is the whole point of the wiring.
 *
 * The channel's `logLevel` is readonly (`LogOutputChannel` in the VS Code
 * API): the user sets it with the "Lattice" channel's log-level dropdown in
 * the Output panel, and the client gates all tracing on it. The setting
 * selects `messages`/`verbose`; the dropdown is the master switch. That
 * split is standard LSP behaviour and is stated in the README.
 *
 * @param {import("vscode").LogOutputChannel | null} output
 * @returns {{ outputChannel: import("vscode").LogOutputChannel | undefined,
 *             traceOutputChannel: import("vscode").LogOutputChannel | undefined }}
 */
export function traceOptions(output) {
  return {
    // `?? undefined` rather than `|| undefined`: a created-but-null channel
    // must read as "no channel", and `??` is the null-preserving spelling.
    outputChannel: output ?? undefined,
    traceOutputChannel: output ?? undefined,
  };
}
