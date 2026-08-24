// The Go tag, decided as pure functions over text so the decisions can be
// tested without a repository, a network or a mocking library — the shape every
// gate script here takes.
//
// What these pin is the direction that has no observable: a Go version tag that
// is wrong does not error anywhere. `go get` falls back to a pseudo-version off
// the default branch, which installs, builds and passes tests, so a consumer
// cannot tell a released version from one that was never cut. Every throw below
// is a case that would otherwise have produced exactly that silence.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { goModulePath, goModuleTag, goModuleTagPrefix } from "./tag-go-module.mjs";

describe("goModulePath", () => {
  it("reads the module directive past the header comments", () => {
    const text =
      "// The Go binding for the custom-rule contract.\n" +
      "//\n" +
      "// A Go module carries no version field.\n" +
      "module github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go\n" +
      "\n" +
      "go 1.24\n";
    assert.equal(goModulePath(text), "github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go");
  });

  it("throws when there is no module directive", () => {
    assert.throws(() => goModulePath("go 1.24\n"), /carries no `module` directive/u);
  });
});

describe("goModuleTagPrefix", () => {
  it("returns the module's directory relative to the repository root", () => {
    assert.equal(
      goModuleTagPrefix(
        "github.com/ecoma-io/archkeep/packages/archkeep-rule-sdk-go",
        "ecoma-io/archkeep",
      ),
      "packages/archkeep-rule-sdk-go",
    );
  });

  it("returns an empty prefix for a module at the repository root", () => {
    assert.equal(goModuleTagPrefix("github.com/ecoma-io/archkeep", "ecoma-io/archkeep"), "");
  });

  it("throws when the module path names a different repository", () => {
    // The silent direction. A tag cut here for a module path pointing
    // elsewhere is resolvable by nobody: `go get` derives the fetch URL from
    // the path, so it would never look at this repository at all — and the
    // release lane would report the version published.
    assert.throws(
      () => goModuleTagPrefix("github.com/someone-else/other/pkg", "ecoma-io/archkeep"),
      /is not under "github\.com\/ecoma-io\/archkeep"/u,
    );
  });

  it("does not treat a repository whose name is a prefix of ours as ours", () => {
    // `github.com/ecoma-io/archkeep-extras` starts with `github.com/ecoma-io/archkeep`
    // as a STRING, and a naive startsWith would slice it into the nonsense
    // prefix `-extras/pkg` and cut a tag under it.
    assert.throws(
      () => goModuleTagPrefix("github.com/ecoma-io/archkeep-extras/pkg", "ecoma-io/archkeep"),
      /is not under/u,
    );
  });
});

describe("goModuleTag", () => {
  it("prefixes the version with the module's directory", () => {
    assert.equal(
      goModuleTag("packages/archkeep-rule-sdk-go", "0.11.0"),
      "packages/archkeep-rule-sdk-go/v0.11.0",
    );
  });

  it("accepts a version that already carries its v", () => {
    assert.equal(
      goModuleTag("packages/archkeep-rule-sdk-go", "v0.11.0"),
      "packages/archkeep-rule-sdk-go/v0.11.0",
    );
  });

  it("leaves a root module's tag bare", () => {
    assert.equal(goModuleTag("", "0.11.0"), "v0.11.0");
  });
});
