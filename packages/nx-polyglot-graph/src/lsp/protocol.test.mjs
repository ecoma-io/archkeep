import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_SEVERITY,
  encodeMessage,
  ERROR_CODES,
  frameMessages,
  pathToUri,
  SERVER_INFO,
  TEXT_DOCUMENT_SYNC_KIND,
  uriToPath,
} from "./protocol.mjs";

const frame = (json) => Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);

describe("base-protocol framing", () => {
  it("measures Content-Length in bytes, so a non-ASCII path does not split a message early", () => {
    // The failure this pins: measuring the DECODED string would count 'ù' as
    // one unit where the header counts two, cutting the body short and leaving
    // the stream permanently one byte out of step for the rest of the session.
    const body = JSON.stringify({ jsonrpc: "2.0", method: "x", params: { path: "café/naïve.ts" } });
    const { messages, rest } = frameMessages(frame(body));

    expect(messages).toEqual([JSON.parse(body)]);
    expect(rest).toHaveLength(0);
  });

  it("keeps a partial body buffered instead of parsing half a message", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const whole = frame(body);
    const first = frameMessages(whole.subarray(0, whole.length - 5));

    expect(first.messages).toEqual([]);

    const second = frameMessages(Buffer.concat([first.rest, whole.subarray(whole.length - 5)]));
    expect(second.messages).toEqual([JSON.parse(body)]);
  });

  it("stays in sync after an unparsable body, because the frame was still well formed", () => {
    // Nothing is owed in reply — the id is unknown — but the NEXT message must
    // still arrive. A resync that dropped the rest of the stream would silently
    // end the session while both sides believed it was open.
    const good = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown" });
    const { messages } = frameMessages(Buffer.concat([frame("{not json"), frame(good)]));

    expect(messages).toEqual([JSON.parse(good)]);
  });

  it("resynchronises on the next boundary when a header carries no usable length", () => {
    const good = JSON.stringify({ jsonrpc: "2.0", method: "exit" });
    const { messages } = frameMessages(
      Buffer.concat([Buffer.from("Content-Type: nonsense\r\n\r\n"), frame(good)]),
    );

    expect(messages).toEqual([JSON.parse(good)]);
  });

  it("round-trips an encoded message back through the framer", () => {
    const message = { jsonrpc: "2.0", id: 9, result: { note: "còntent-lëngth" } };
    const { messages, rest } = frameMessages(encodeMessage(message));

    expect(messages).toEqual([message]);
    expect(rest).toHaveLength(0);
  });

  it("frames several messages arriving in one chunk, in order", () => {
    const a = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const b = JSON.stringify({ jsonrpc: "2.0", method: "initialized" });
    const { messages } = frameMessages(Buffer.concat([frame(a), frame(b)]));

    expect(messages.map((m) => m.method)).toEqual(["initialize", "initialized"]);
  });
});

describe("document URIs", () => {
  it("round-trips a path whose characters the protocol requires to be escaped", () => {
    const path = "/tmp/a project/héllo world.go";

    expect(pathToUri(path)).toContain("%20");
    expect(uriToPath(pathToUri(path))).toBe(path);
  });

  it("refuses a URI that names no file rather than inventing a path for it", () => {
    // An editor can open an untitled buffer or a virtual document from another
    // extension. Treating `untitled:Untitled-1` as a relative path would put a
    // verdict on a file that does not exist.
    expect(uriToPath("untitled:Untitled-1")).toBeNull();
    expect(uriToPath("https://example.test/a.ts")).toBeNull();
    expect(uriToPath(undefined)).toBeNull();
    expect(uriToPath("file://remote-host/share/a.ts")).toBeNull();
  });
});

describe("protocol constants", () => {
  it("names itself from the package manifest rather than from a second copy", () => {
    // Two versions of this server installed side by side must be tellable
    // apart by what they say in `initialize`. The npm scope is
    // stripped because it names a registry namespace rather than a server, and
    // pinning that here is what would fail if the strip were dropped and every
    // editor's output channel silently gained a `@ecoma-io/` prefix.
    expect(SERVER_INFO.name).toBe("nx-polyglot-graph");
    expect(SERVER_INFO.version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("carries the numeric values the specifications fix", () => {
    expect(ERROR_CODES.methodNotFound).toBe(-32601);
    expect(ERROR_CODES.serverNotInitialized).toBe(-32002);
    expect(ERROR_CODES.invalidRequest).toBe(-32600);
    expect(TEXT_DOCUMENT_SYNC_KIND.full).toBe(1);
    expect(DIAGNOSTIC_SEVERITY.error).toBe(1);
    expect(DIAGNOSTIC_SEVERITY.warning).toBe(2);
  });
});
