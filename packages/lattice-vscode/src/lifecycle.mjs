/**
 * The two decisions a client makes about its server's process, as predicates.
 *
 * A language client's lifecycle has exactly two moments where the honest answer
 * is "nothing is being checked" — the server died after starting, and the
 * server never started. Both used to live inline in `../extension.mjs`, which
 * made that file the one place in the package holding untested decisions
 * despite claiming to be wiring only; they are here so each gate is a pure
 * function over described inputs, testable without an editor.
 *
 * The stakes are the project invariant on the client side: an editor shows
 * nothing for an empty diagnostic list, so a workspace whose server is dead
 * must be told apart from a workspace whose code is clean — by the status item,
 * which means the predicate deciding "this is a death" cannot quietly miss one.
 */

/**
 * Whether a state transition is a server dying after it had started running.
 *
 * Only Running → Stopped qualifies. A failed start arrives as Starting →
 * Stopped and belongs to the `start()` rejection, not to a listener firing
 * after a healthy period; anything else (a restart cycle, a stop this client
 * asked for) is either owned elsewhere or deliberate. The identity check is
 * part of the same question: a folder removed while a start was pending has
 * its session replaced or deleted, and the old listener must not report a
 * death over the new session's head — a deliberate stop would otherwise paint
 * the failure state onto a workspace someone just reopened.
 *
 * The editor's state constants are arguments rather than imports, so this file
 * stays free of `vscode` and the numbers are whatever the runtime says they
 * are — the values are not sequential, and nothing here may assume they are.
 *
 * @param {object} event
 * @param {number} event.oldState the state before the change
 * @param {number} event.newState the state after the change
 * @param {{running: number, stopped: number}} states the client library's constants
 * @param {unknown} currentSession what the session map holds for this folder now
 * @param {unknown} session the session this listener was created for
 * @returns {boolean}
 */
export function serverDiedAfterStarting(event, states, currentSession, session) {
  return (
    event.oldState === states.running &&
    event.newState === states.stopped &&
    currentSession === session
  );
}

/**
 * Whether a rejected `start()` still belongs to the session the map holds.
 *
 * The recovery for a failed start clears the session's client slot so a later
 * close/restart does not try to stop a client that never came up. Clearing
 * unconditionally would reach into whichever session occupies the key NOW —
 * possibly a fresh one, opened for the same folder while the first start was
 * pending — and null out ITS live client instead, leaking the real process.
 * Only the session whose `start()` actually rejected may be touched.
 *
 * @param {{client: unknown} | undefined} currentSession what the map holds now
 * @param {unknown} client the client whose `start()` rejected
 * @returns {boolean}
 */
export function failedStartBelongsTo(currentSession, client) {
  return currentSession?.client === client;
}
