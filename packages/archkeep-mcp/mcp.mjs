#!/usr/bin/env node
/**
 * The MCP server's stdio entry — the transport wiring, and nothing else.
 *
 * Every decision lives in `src/` (`src/server.mjs` builds the tool surface,
 * `src/engine.mjs` composes the engine's commands); this file only connects
 * that server to the process's stdio through the SDK's transport, the same
 * split `../../archkeep/lsp.mjs` makes with `src/lsp/`. The split is what
 * lets the protocol conversation be driven in-process by a test
 * (`src/server.test.mjs`, over an in-memory transport pair) while
 * `src/mcp.integration.test.mjs` still drives this executable over real
 * pipes — framing, stream wiring and process lifecycle only hold together in
 * a real process.
 *
 * **stdout carries the protocol and nothing else.** The SDK writes each
 * response as one newline-delimited JSON message on stdout; every diagnostic
 * this package could emit goes to stderr, and the engine's command functions
 * print nothing (the CLI owns printing). One stray `console.log` here would
 * be read by the client as a malformed message and desynchronise the
 * conversation for the rest of the session.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./index.mjs";

const server = createServer();
await server.connect(new StdioServerTransport());
