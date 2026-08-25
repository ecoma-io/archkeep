/**
 * The package entry — what a programmatic consumer gets from
 * `import "@ecoma-io/archkeep-mcp"`.
 *
 * One export, deliberately: `createServer` builds the server with its eight
 * tools registered and nothing connected, because how a server is reached
 * (stdio today, an in-memory pair in a test, something else tomorrow) is the
 * caller's decision, not the package's. The stdio wiring an installed `bin`
 * runs lives in `./mcp.mjs`.
 */
export { createServer, SERVER_NAME, SERVER_VERSION } from "./src/server.mjs";
