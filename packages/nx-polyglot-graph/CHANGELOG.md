# Changelog

## [0.2.0](https://github.com/ecoma-io/lattice/compare/v0.1.0...v0.2.0) (2026-08-11)


### ⚠ BREAKING CHANGES

* **graph:** a workspace with a dead tsconfig paths alias now exits 1 where it exited 0, and a workspace whose tsconfig will not load or whose `paths` value is not an array of strings now exits 3 where it may have exited 0 — including a pure-Go tree with a broken tracked tsconfig. The usage text and report output also changed to name the new finding.
* **graph:** on an unchanged workspace whose root go.work has drifted from its go.mod projects, `check` now reports goWork* findings and exits 1 where it previously exited 0, and exits 3 on a go.work it cannot parse. A green CI can turn red on a tree with existing drift — that is the point. A workspace with no root go.work sees no change.
* **graph:** a workspace whose pyproject.toml files declare Poetry or PDM path dependencies gains project-to-project edges without changing any file, which changes what `nx affected` selects; and a declared workspace path this resolver cannot attribute to any project's root now fails graph computation instead of being silently ignored.

### Features

* **ci:** run the conformance differential against real Nx workspaces at pinned commits ([#22](https://github.com/ecoma-io/lattice/issues/22)) ([b47f845](https://github.com/ecoma-io/lattice/commit/b47f8450f5583bd7a098cc5679f69a0a54ef2675))
* **graph:** add a checkJs typecheck gate and fix the JSDoc errors it surfaces ([#24](https://github.com/ecoma-io/lattice/issues/24)) ([2f4950e](https://github.com/ecoma-io/lattice/commit/2f4950e1f87f35c4834b6c42a57f7ea489bda6b6))
* **graph:** draw Python edges from Poetry and PDM path dependencies ([#18](https://github.com/ecoma-io/lattice/issues/18)) ([5a60895](https://github.com/ecoma-io/lattice/commit/5a6089506d00ec484033230c35cb1846824c46dd))
* **graph:** honour Module Federation remotes in the app-import exemption ([#14](https://github.com/ecoma-io/lattice/issues/14)) ([16e1776](https://github.com/ecoma-io/lattice/commit/16e177623c1928c4557ed65e545608ec58033dff))
* **graph:** judge tsconfig paths aliases for life and fail check on dead ones ([#21](https://github.com/ecoma-io/lattice/issues/21)) ([9ae3eb0](https://github.com/ecoma-io/lattice/commit/9ae3eb0ff8137ef6bdc1ae655426da42eba31bb5))
* **graph:** report go.work drift instead of letting dev and CI build different module sets ([#19](https://github.com/ecoma-io/lattice/issues/19)) ([f10a8fa](https://github.com/ecoma-io/lattice/commit/f10a8fa3073cf3c24759c2ee07ea52a7f8f04f67))
* **graph:** supply entryPoints and declaredPackages from disk the way upstream reads them ([#20](https://github.com/ecoma-io/lattice/issues/20)) ([5752858](https://github.com/ecoma-io/lattice/commit/57528586272fb46b2f20804f9ec85a98bd713aa2))
* **vscode:** ship the VS Code client and the documentation tree ([#13](https://github.com/ecoma-io/lattice/issues/13)) ([20ec194](https://github.com/ecoma-io/lattice/commit/20ec19444049006ddd75f28b4fdf97bc6b93d8e5))


### Documentation

* **docs:** keep every document in English and drop the translated READMEs ([#8](https://github.com/ecoma-io/lattice/issues/8)) ([ed2a5e9](https://github.com/ecoma-io/lattice/commit/ed2a5e9bb873bc4198930610d5b6a20e9de052b9))
* **docs:** true up every document to the four checks that just shipped ([#23](https://github.com/ecoma-io/lattice/issues/23)) ([9245c0c](https://github.com/ecoma-io/lattice/commit/9245c0c6de0630492d2cdafb54132fa9720ab20c))
* **graph:** cite only documents this repository has, and fixtures only it invented ([#10](https://github.com/ecoma-io/lattice/issues/10)) ([02399d9](https://github.com/ecoma-io/lattice/commit/02399d97d34e11e6701bdc44092044e31d5a44e1))

## 0.1.0 (2026-08-07)


### Features

* **ci:** release the package, and prove it installs before publishing it ([#3](https://github.com/ecoma-io/lattice/issues/3)) ([3a519c9](https://github.com/ecoma-io/lattice/commit/3a519c9d6fe7486c3c946e149cb07836af17b3cc))
* **graph:** enforce module boundaries in the languages ESLint cannot read ([#1](https://github.com/ecoma-io/lattice/issues/1)) ([1ae4d8f](https://github.com/ecoma-io/lattice/commit/1ae4d8f83c09d8f67f2ad7f028a684143b99ab87))
