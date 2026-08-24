import { describe, expect, it } from "vitest";

import { traceOptions } from "./trace.mjs";

describe("traceOptions", () => {
  it("passes the channel to BOTH options, binding archkeep.trace.server to a mechanism", () => {
    // The language client's `traceOutputChannel` getter falls back to
    // `outputChannel` when it is not set, so a client that omits it still
    // works while the `trace.server` setting silently does nothing. The whole
    // point of the wiring is that the option is explicit — this is the
    // assertion that would fail if the spread were dropped from the client
    // constructor.
    //
    // The cast is deliberate: `traceOptions` takes a real `LogOutputChannel`,
    // and no test can construct one without an editor host, so the identity
    // of the returned references is what is pinned here, not channel
    // behaviour.
    const channel = /** @type {import("vscode").LogOutputChannel} */ ({ name: "Archkeep" });
    expect(traceOptions(channel)).toStrictEqual({
      outputChannel: channel,
      traceOutputChannel: channel,
    });
  });

  it("reads an absent channel as undefined, never as a null that the client would accept", () => {
    // `output ?? undefined` rather than `output || undefined`: a null channel
    // must mean "no channel", and the `??` spelling is what carries that.
    expect(traceOptions(null)).toStrictEqual({
      outputChannel: undefined,
      traceOutputChannel: undefined,
    });
    expect(traceOptions(undefined)).toStrictEqual({
      outputChannel: undefined,
      traceOutputChannel: undefined,
    });
  });
});
