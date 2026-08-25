/**
 * The package entry — what a programmatic consumer gets from
 * `import "@ecoma-io/archkeep-mcp"`.
 *
 * Three exports, and one decision: `createServer` builds the server with its
 * eight tools registered and nothing connected, because how a server is
 * reached (stdio today, an in-memory pair in a test, something else
 * tomorrow) is the caller's decision, not the package's — `SERVER_NAME` and
 * `SERVER_VERSION` ride beside it so an embedder can announce the identity a
 * client sees without reading the manifest. The stdio wiring an installed
 * `bin` runs lives in `./mcp.mjs`.
 */
export { createServer, SERVER_NAME, SERVER_VERSION } from "./src/server.mjs";
