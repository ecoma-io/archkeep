#!/usr/bin/env node
/**
 * Language-server entry — the stdio wiring, and nothing else.
 *
 * Everything the server decides lives in `src/lsp/`; this file only turns a
 * byte stream into messages and back. The split is what lets the protocol
 * conversation be driven in-process by a test (`src/lsp/server.test.mjs`) while
 * `src/lsp.integration.test.mjs` still drives this executable over real pipes,
 * because framing, stream wiring and the exit contract only hold together in a
 * real process.
 *
 * Framing is the LSP base protocol: `Content-Length: <n>\r\n\r\n<utf8 json>`.
 * Implemented in `src/lsp/protocol.mjs` rather than pulled from a dependency
 * because it is a fixed external contract of about forty lines, and because
 * this tool stays on Node built-ins (AGENTS.md).
 *
 * **stdout carries the protocol and nothing else.** Every log line goes to
 * stderr: one stray `console.log` here would be read by the client as a
 * malformed frame and desynchronise the stream for the rest of the session.
 */
import { isProgramEntry } from "./src/entry-point.mjs";
import { encodeMessage, frameMessages } from "./src/lsp/protocol.mjs";
import { createServer } from "./src/lsp/server.mjs";

/**
 * Ends the process, but not before the client has the bytes.
 *
 * `process.exit()` discards whatever is still queued on a pipe, and the thing
 * most often still queued is the reply to `shutdown` — the message that tells
 * the client the session ended cleanly. An empty write is ordered behind every
 * earlier one, so its callback runs only once they have all reached the OS.
 * `exitCode` is set first so that a stream which never drains still ends the
 * process with the right code instead of a silent 0.
 */
function exitAfterFlush(output, code) {
  process.exitCode = code;
  output.write("", () => process.exit(code));
}

/** Wires a server to a pair of streams and returns it. */
export function serve(input = process.stdin, output = process.stdout, onExit = null) {
  const send = (message) => output.write(encodeMessage(message));
  const exit = onExit ?? ((code) => exitAfterFlush(output, code));
  const log = (text) => process.stderr.write(`${text}\n`);
  const server = createServer({ send, exit, log });

  /** @type {Buffer} */
  let pending = Buffer.alloc(0);
  // No encoding is ever set on `input`, so a data chunk is always a Buffer.
  input.on("data", (/** @type {Buffer} */ chunk) => {
    const framed = frameMessages(Buffer.concat([pending, chunk]));
    // An implausible `Content-Length` is a poisoned stream, not a client that
    // will send more bytes — see `MAX_CONTENT_LENGTH` in `./src/lsp/protocol.mjs`.
    // The session is closed loudly (a log line naming the length, and a
    // non-zero exit) rather than held open forever on a body that will never
    // arrive: a frame that cannot be framed must never look like a clean,
    // empty conversation.
    if (framed.protocolError !== undefined) {
      pending = Buffer.alloc(0);
      log(framed.protocolError);
      // Exit 2 is deliberate, and not the CLI's usage-error 2 — that is a
      // different process (`docs/reference/exit-codes.md`). The server's own
      // contract (`./src/lsp/server.mjs`) ends a session 0 after a clean
      // `shutdown` and 1 when the pipe closed without one; a poisoned protocol
      // stream is neither, and sharing either code would read as a clean or
      // merely-dirty shutdown to whatever supervised the process.
      exit(2);
      return;
    }
    pending = framed.rest;
    for (const message of framed.messages) server.handle(message);
  });
  // A client that closed the pipe without saying `exit` did not shut the server
  // down; reporting that as a clean stop would hide a crashed editor.
  input.on("end", () => server.handle({ jsonrpc: "2.0", method: "exit" }));
  return server;
}

if (isProgramEntry(import.meta.url)) {
  serve();
}
