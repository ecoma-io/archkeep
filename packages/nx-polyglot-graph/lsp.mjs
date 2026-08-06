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
 * this tool stays on Node built-ins (project CLAUDE.md, Rule 2).
 *
 * **stdout carries the protocol and nothing else.** Every log line goes to
 * stderr: one stray `console.log` here would be read by the client as a
 * malformed frame and desynchronise the stream for the rest of the session.
 */
import { pathToFileURL } from "node:url";

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
  const server = createServer({
    send: (message) => output.write(encodeMessage(message)),
    exit: onExit ?? ((code) => exitAfterFlush(output, code)),
    log: (text) => process.stderr.write(`${text}\n`),
  });

  let pending = Buffer.alloc(0);
  input.on("data", (chunk) => {
    const { messages, rest } = frameMessages(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const message of messages) server.handle(message);
  });
  // A client that closed the pipe without saying `exit` did not shut the server
  // down; reporting that as a clean stop would hide a crashed editor.
  input.on("end", () => server.handle({ jsonrpc: "2.0", method: "exit" }));
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  serve();
}
