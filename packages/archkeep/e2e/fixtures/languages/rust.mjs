// Rust language fixture: three Cargo crates with `use` paths.
// Proves Rust `use` discovery, crate-identifier matching (package name
// normalised to underscores), and Cargo manifest `path` dependency edges.
//
// Architecture:
//   domain (layer:domain)     — no imports from other crates
//   application (layer:application) — use domain::NAME
//   api (layer:api)          — use application::NAME
//
// No Cargo build required — Archkeep statically parses `.rs` files and
// `Cargo.toml` manifests.

import { LAYERED_BOUNDARY_CONFIG } from "./boundary-law.mjs";

/**
 * @param {string} packageName The installed package name.
 * @param {Record<string, string>} peers The package's declared peer ranges.
 * @param {string} packageManager This repository's pnpm pin.
 * @returns {Record<string, string>} Relative path → contents.
 */
export function rustLanguageFiles(packageName, peers, packageManager) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "consumer-lang-rust",
        private: true,
        type: "module",
        packageManager,
        devDependencies: {
          [packageName]: "*",
          typescript: peers.typescript,
        },
      },
      null,
      2,
    )}\n`,
    "archkeep.json": `${JSON.stringify(
      {
        boundaryConfig: "module-boundaries.config.mjs",
        projects: {
          declared: [
            { root: "libs/domain", name: "domain", tags: ["layer:domain"] },
            { root: "libs/application", name: "application", tags: ["layer:application"] },
            { root: "libs/api", name: "api", tags: ["layer:api"] },
          ],
        },
        coverage: {
          exempt: [
            {
              path: "module-boundaries.config.mjs",
              reason: "workspace tooling config at the root, not itself a project",
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "module-boundaries.config.mjs": LAYERED_BOUNDARY_CONFIG,
    ".gitignore": "node_modules/\n.nx/\n",

    // Domain — leaf crate, no dependencies.
    "libs/domain/Cargo.toml": '[package]\nname = "domain"\nversion = "0.1.0"\nedition = "2021"\n',
    "libs/domain/src/lib.rs": 'pub const NAME: &str = "domain";\n',

    // Application — depends on domain via path.
    "libs/application/Cargo.toml":
      '[package]\nname = "application"\nversion = "0.1.0"\nedition = "2021"\n\n' +
      '[dependencies]\ndomain = { path = "../domain" }\n',
    "libs/application/src/lib.rs": "use domain::NAME;\n\npub const APP: &str = NAME;\n",

    // Api — depends on application via path.
    "libs/api/Cargo.toml":
      '[package]\nname = "api"\nversion = "0.1.0"\nedition = "2021"\n\n' +
      '[dependencies]\napplication = { path = "../application" }\n',
    "libs/api/src/lib.rs": "use application::APP;\n\npub const API: &str = APP;\n",
  };
}
