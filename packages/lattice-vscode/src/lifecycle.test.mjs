import { describe, expect, it } from "vitest";

import { failedStartBelongsTo, serverDiedAfterStarting } from "./lifecycle.mjs";

// Stand-ins for the client library's constants, which live behind an import of
// `vscode` this package's tests cannot make. The predicates take them as
// arguments precisely so their values stay the runtime's business — and these
// are the runtime's actual numbers, not adjacent ones, so a future reader does
// not mistake them for arbitrary fixtures.
const STATE = { running: 2, stopped: 1 };

describe("serverDiedAfterStarting", () => {
  const session = { client: {} };

  it("sees a server that stopped after running as a death", () => {
    expect(
      serverDiedAfterStarting(
        { oldState: STATE.running, newState: STATE.stopped },
        STATE,
        session,
        session,
      ),
    ).toBe(true);
  });

  it("leaves a failed start to the start() rejection", () => {
    // The catch around `start()` already owns this transition and writes its
    // own reason; reporting it here too would be noise, but the dangerous
    // direction is subtler: treating ANY arrival at stopped as death would
    // fire on the deliberate stop below as well.
    expect(
      serverDiedAfterStarting({ oldState: 3, newState: STATE.stopped }, STATE, session, session),
    ).toBe(false);
  });

  it("ignores transitions that never reach stopped", () => {
    expect(
      serverDiedAfterStarting({ oldState: STATE.running, newState: 3 }, STATE, session, session),
    ).toBe(false);
    expect(
      serverDiedAfterStarting(
        { oldState: STATE.stopped, newState: STATE.running },
        STATE,
        session,
        session,
      ),
    ).toBe(false);
  });

  it("does not let a stale listener report over a replaced or removed session", () => {
    // A deliberate stop removes the session from the map before stopping its
    // client, so by the time the event fires the map holds either nothing or a
    // different session. Either way the healthy/failure label belongs to
    // whoever holds the key now, not to the listener being torn down.
    const replacement = { client: {} };
    expect(
      serverDiedAfterStarting(
        { oldState: STATE.running, newState: STATE.stopped },
        STATE,
        replacement,
        session,
      ),
    ).toBe(false);
    expect(
      serverDiedAfterStarting(
        { oldState: STATE.running, newState: STATE.stopped },
        STATE,
        undefined,
        session,
      ),
    ).toBe(false);
  });

  it("works with whatever state values the runtime uses", () => {
    // The values are not sequential across the real enum, and the predicate
    // compares rather than assumes — pinned here with numbers no enum ships.
    const odd = { running: 41, stopped: 17 };
    expect(serverDiedAfterStarting({ oldState: 41, newState: 17 }, odd, session, session)).toBe(
      true,
    );
  });
});

describe("failedStartBelongsTo", () => {
  it("clears the slot only when the rejected client is still the mapped one", () => {
    const client = {};
    expect(failedStartBelongsTo({ client }, client)).toBe(true);
    expect(failedStartBelongsTo({ client: {} }, client)).toBe(false);
  });

  it("refuses to touch a folder whose session is gone or not started yet", () => {
    // Both are the silent direction of an unconditional clear: nulling the
    // client slot of a session that opened after the rejection would strand
    // its live process outside every later stop.
    const client = {};
    expect(failedStartBelongsTo(undefined, client)).toBe(false);
    expect(failedStartBelongsTo({ client: null }, client)).toBe(false);
  });
});
