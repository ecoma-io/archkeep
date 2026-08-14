# Changelog

## 0.1.0 (2026-08-14)


### ⚠ BREAKING CHANGES

* **lattice:** tags must use dash separators (type-lib, not type:lib) when using the Moon provider, because Moon tag validation rejects colons. Existing constraint tables in Moon workspaces need to switch from colon to dash format.
* **workspace:** the npm package name, both bin names, the Nx plugin specifier in nx.json, and the SARIF tool.driver.name all change; existing code-scanning alerts re-key, and consumers must reinstall under the new name and update their nx.json plugins entry.

### Features

* **lattice:** add Moon provider, migrate repository from Nx to Moonrepo ([#60](https://github.com/ecoma-io/lattice/issues/60)) ([3a514b2](https://github.com/ecoma-io/lattice/commit/3a514b29fc4edbd64b46826776b83a2617770374))
* **vscode:** dogfood architecture constraints and support native provider ([#52](https://github.com/ecoma-io/lattice/issues/52)) ([6864974](https://github.com/ecoma-io/lattice/commit/68649749b9d9aa78e93eab32336ce6fb8095a121))
* **workspace:** rename the engine to @ecoma-io/lattice and make nx an optional peer ([#25](https://github.com/ecoma-io/lattice/issues/25)) ([7dc30f6](https://github.com/ecoma-io/lattice/commit/7dc30f60911e64def4168f0a2d5c60cbbee10a34))
