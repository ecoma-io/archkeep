# Changelog

## 0.1.0 (2026-08-14)


### ⚠ BREAKING CHANGES

* **lattice:** tags must use dash separators (type-lib, not type:lib) when using the Moon provider, because Moon tag validation rejects colons. Existing constraint tables in Moon workspaces need to switch from colon to dash format.
* **lattice:** normalise Nx root-project root '.' to '' in createWorkspace ([#56](https://github.com/ecoma-io/lattice/issues/56))
* **lattice:** TypeScript import-type queries now participate in boundary analysis and can produce new findings on unchanged workspaces.
* **lattice:** reported results change on unchanged workspaces, in both directions. A tree declaring a complete non-default workspaceLayout can gain noRelativeOrAbsoluteImportsAcrossLibraries findings that were previously missed; a tree declaring a partial workspaceLayout now exits 3 with no verdict instead of silently running half the rule.
* **workspace:** the npm package name, both bin names, the Nx plugin specifier in nx.json, and the SARIF tool.driver.name all change; existing code-scanning alerts re-key, and consumers must reinstall under the new name and update their nx.json plugins entry.

### Features

* **ci:** prove the native provider against this tree and the real-tree differential ([#37](https://github.com/ecoma-io/lattice/issues/37)) ([9abd440](https://github.com/ecoma-io/lattice/commit/9abd440e285284b01d6528b2761403041bdec347))
* **lattice:** add command foundation and honest JSON envelopes ([#43](https://github.com/ecoma-io/lattice/issues/43)) ([736e20b](https://github.com/ecoma-io/lattice/commit/736e20b0058252f7339017cc262d7de761db19ee))
* **lattice:** add explain command ([#48](https://github.com/ecoma-io/lattice/issues/48)) ([594f7a9](https://github.com/ecoma-io/lattice/commit/594f7a9e32fce358a18db1c3b49b5e488957a150))
* **lattice:** add graph and diff commands ([#45](https://github.com/ecoma-io/lattice/issues/45)) ([02013a1](https://github.com/ecoma-io/lattice/commit/02013a1c5b49c87d9ebb0ec33daf036fcb2f76a3))
* **lattice:** add impact command ([b357a5d](https://github.com/ecoma-io/lattice/commit/b357a5d1384578e1a26f7d5e4b93d5928279f714))
* **lattice:** add layout-bearing conformance case ([#40](https://github.com/ecoma-io/lattice/issues/40)) ([52e0043](https://github.com/ecoma-io/lattice/commit/52e00432b9d2fc91fb0a9d33f94df1c11871dc8a))
* **lattice:** add layout-bearing conformance case ([#58](https://github.com/ecoma-io/lattice/issues/58)) ([52e0043](https://github.com/ecoma-io/lattice/commit/52e00432b9d2fc91fb0a9d33f94df1c11871dc8a))
* **lattice:** add Moon provider, migrate repository from Nx to Moonrepo ([#60](https://github.com/ecoma-io/lattice/issues/60)) ([3a514b2](https://github.com/ecoma-io/lattice/commit/3a514b29fc4edbd64b46826776b83a2617770374))
* **lattice:** add multi-language E2E coverage for all six first-class languages ([#53](https://github.com/ecoma-io/lattice/issues/53)) ([d7f234d](https://github.com/ecoma-io/lattice/commit/d7f234da29fe4e6589589529e1c2d7c60d67b802))
* **lattice:** add multi-language E2E coverage for all six first-class languages ([#54](https://github.com/ecoma-io/lattice/issues/54)) ([d7f234d](https://github.com/ecoma-io/lattice/commit/d7f234da29fe4e6589589529e1c2d7c60d67b802))
* **lattice:** add the command foundation and honest JSON envelopes ([736e20b](https://github.com/ecoma-io/lattice/commit/736e20b0058252f7339017cc262d7de761db19ee))
* **lattice:** add the JSON policy dialect and the inline lattice.json policy ([#34](https://github.com/ecoma-io/lattice/issues/34)) ([b3ca5aa](https://github.com/ecoma-io/lattice/commit/b3ca5aa78dc0d8e66b2fdb8d6dedf560cb163feb))
* **lattice:** add the native lattice.json project-model provider ([#30](https://github.com/ecoma-io/lattice/issues/30)) ([13788d4](https://github.com/ecoma-io/lattice/commit/13788d40cfab5cbaaa918d1d83ae7cb864cd158b))
* **lattice:** add Vitest E2E compatibility suite ([#53](https://github.com/ecoma-io/lattice/issues/53)) ([92aee70](https://github.com/ecoma-io/lattice/commit/92aee706769fa861aebde4ce951c7879a21b3d5d))
* **lattice:** analyze TypeScript import types ([#44](https://github.com/ecoma-io/lattice/issues/44)) ([1b2725b](https://github.com/ecoma-io/lattice/commit/1b2725b0df566c153ee46a22eb34a7dd61757d73))
* **lattice:** honor nx.json workspaceLayout and refuse partial layouts ([#42](https://github.com/ecoma-io/lattice/issues/42)) ([f5023fb](https://github.com/ecoma-io/lattice/commit/f5023fb048753b9842c81e14e686232094993d6d))
* **lattice:** normalise Nx root-project root '.' to '' in createWorkspace ([#56](https://github.com/ecoma-io/lattice/issues/56)) ([cff1e89](https://github.com/ecoma-io/lattice/commit/cff1e89a8f99e346c9b2fb0c8e74657850ec44ed)), closes [#32](https://github.com/ecoma-io/lattice/issues/32)
* **lattice:** read the boundary policy from ESLint flat config ([#36](https://github.com/ecoma-io/lattice/issues/36)) ([8b18bde](https://github.com/ecoma-io/lattice/commit/8b18bdece13cbc7d38e6ca16f1bee64c6c0d5af4))
* **lattice:** surface polyglot coverage gap when Nx plugin is unregistered ([#57](https://github.com/ecoma-io/lattice/issues/57)) ([ab9023f](https://github.com/ecoma-io/lattice/commit/ab9023f4d796f44a6e658e17bd35237f770848db))
* **workspace:** rename the engine to @ecoma-io/lattice and make nx an optional peer ([#25](https://github.com/ecoma-io/lattice/issues/25)) ([7dc30f6](https://github.com/ecoma-io/lattice/commit/7dc30f60911e64def4168f0a2d5c60cbbee10a34))


### Bug Fixes

* **lattice:** bound spawnSync calls in the exit-contract test with a 30s timeout ([#55](https://github.com/ecoma-io/lattice/issues/55)) ([55d5fa7](https://github.com/ecoma-io/lattice/commit/55d5fa7787feeddc90722e8953115a345a935300)), closes [#41](https://github.com/ecoma-io/lattice/issues/41)


### Documentation

* **workspace:** reposition Lattice as independent engine, Nx as first-class integration ([#51](https://github.com/ecoma-io/lattice/issues/51)) ([c79b62f](https://github.com/ecoma-io/lattice/commit/c79b62f3fee17697718ab1c0baa33fb0fa02a0ac))
* **workspace:** restructure documentation IA into eight sections ([#49](https://github.com/ecoma-io/lattice/issues/49)) ([513da7e](https://github.com/ecoma-io/lattice/commit/513da7e8c52b8acd3eaacec3117605ffaeb1717e))
