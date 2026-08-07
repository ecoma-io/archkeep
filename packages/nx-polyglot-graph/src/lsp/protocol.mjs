/**
 * The Language Server Protocol's base layer: framing, the numeric constants the
 * protocol fixes, and the `file:` URI conversion every other module here needs.
 *
 * Implemented directly rather than pulled from `vscode-languageserver`, for the
 * reason the project `../../CLAUDE.md` gives for the whole directory: this tool reaches
 * outside Node's built-ins only where something it must AGREE with already
 * lives there — TypeScript's own resolver, Vue's own SFC parser, Nx's own JSON
 * reader (`./workspace-index.mjs`). The base protocol is nothing of the kind:
 * it is a fixed external contract of about forty lines, written down in a
 * specification, and a third-party package for it would put a dependency
 * decision in this project that the root manifest owns.
 *
 * Every constant below is a value the SPECIFICATION fixes, not a workspace
 * choice — the one class of literal that is allowed inline, and it is written in
 * exactly one place so no consumer restates it.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Name and version, read from the manifest rather than repeated here. A server
 * whose `serverInfo` disagrees with its own package is a debugging trap the
 * first time two versions are installed side by side.
 *
 * The npm scope is stripped, and that is a derivation rather than a second
 * name: `serverInfo.name` is what an editor prints in its LSP output channel
 * and what a user greps for, while the scope is a registry namespace that says
 * who publishes the package, not which server is running. Both binaries in
 * `bin` are unscoped for the same reason. Deriving it keeps the version honest
 * and the version is the half that actually matters when two are installed.
 */
const manifest = createRequire(import.meta.url)("../../package.json");

/** What `initialize` answers when a client asks who it is talking to. */
export const SERVER_INFO = Object.freeze({
  name: manifest.name.replace(/^@[^/]+\//u, ""),
  version: manifest.version,
});

/**
 * JSON-RPC 2.0 and LSP error codes, at the values both specifications fix.
 *
 * `serverNotInitialized` and `requestFailed` are LSP's own additions in the
 * reserved JSON-RPC range; the rest are JSON-RPC's.
 */
export const ERROR_CODES = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverNotInitialized: -32002,
  requestFailed: -32803,
});

/**
 * `TextDocumentSyncKind`. This server advertises `full`: the client re-sends
 * the whole document on every change, and the server re-analyzes it from
 * scratch. Incremental sync would mean maintaining a rope and applying ranged
 * edits, and a single mis-applied edit makes every position in every subsequent
 * diagnostic point at the wrong line — which is the failure this tool is least
 * allowed to have. It stays `full` until incremental can be proven correct.
 */
export const TEXT_DOCUMENT_SYNC_KIND = Object.freeze({
  none: 0,
  full: 1,
  incremental: 2,
});

/** LSP `DiagnosticSeverity`. */
export const DIAGNOSTIC_SEVERITY = Object.freeze({
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
});

/** LSP `FileChangeType`, as `workspace/didChangeWatchedFiles` reports it. */
export const FILE_CHANGE_TYPE = Object.freeze({
  created: 1,
  changed: 2,
  deleted: 3,
});

/**
 * Splits a byte stream into LSP messages. Returns the messages it could frame
 * plus whatever tail is not yet a whole message, which the caller feeds back
 * in with the next chunk.
 *
 * `Content-Length` counts BYTES, not characters, so the buffer is sliced
 * before it is decoded — measuring a decoded string would mis-split any
 * message containing a non-ASCII path.
 *
 * @param {Buffer} buffer
 * @returns {{ messages: object[], rest: Buffer }}
 */
export function frameMessages(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headers = rest.subarray(0, headerEnd).toString("ascii");
    const length = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1]);
    if (!Number.isInteger(length)) {
      // A frame with no usable Content-Length cannot be skipped safely — the
      // stream position of the next one is unknowable. Drop the header and
      // resynchronise on the next boundary rather than guess a length.
      rest = rest.subarray(headerEnd + 4);
      continue;
    }
    const bodyStart = headerEnd + 4;
    if (rest.length < bodyStart + length) break; // body still arriving
    const body = rest.subarray(bodyStart, bodyStart + length).toString("utf8");
    rest = rest.subarray(bodyStart + length);
    try {
      messages.push(JSON.parse(body));
    } catch {
      // Unparsable body, correctly framed: the stream stays in sync, so the
      // session continues. Nothing is owed in reply — the id is unknown.
    }
  }
  return { messages, rest };
}

/**
 * Encodes a message with its base-protocol header.
 *
 * @param {object} message
 * @returns {Buffer}
 */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * The filesystem path a `file:` URI names, or `null` for anything else.
 *
 * `null` rather than a throw, and rather than treating the URI as a path: an
 * editor can open an untitled buffer (`untitled:Untitled-1`) or a virtual
 * document from another extension, and the server has no file to analyze for
 * either. The caller decides what to say about it — this function's job is to
 * refuse to invent a path.
 *
 * @param {string} uri
 * @returns {string|null}
 */
export function uriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * The `file:` URI for an absolute path, percent-encoded as the protocol
 * requires. Round-trips with `uriToPath`.
 *
 * @param {string} path
 * @returns {string}
 */
export function pathToUri(path) {
  return pathToFileURL(path).href;
}
