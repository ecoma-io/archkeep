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

import {
  goModulePath,
  goModuleTag,
  goModuleTagPrefix,
  readCreatedRef,
  readBackDelay,
} from "./tag-go-module.mjs";

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

describe("readCreatedRef", () => {
  const ref = { object: { sha: "5fa9735" } };

  it("returns the ref the first time it reads back", async () => {
    const sleeps = [];
    const read = await readCreatedRef(() => ref, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(read, ref);
    assert.deepEqual(sleeps, []);
  });

  it("retries across a propagation window instead of obeying the first 404", async () => {
    // The 0.21.0 shape: the POST created the tag; the immediate read-back
    // lost the race and the lane went red on a ref `git ls-remote` showed
    // present at the released SHA.
    let attempts = 0;
    const sleeps = [];
    const read = await readCreatedRef(
      () => {
        attempts += 1;
        if (attempts < 3) throw new Error("gh: Not Found (HTTP 404)");
        return ref;
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(attempts, 3);
    assert.equal(read, ref);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  it("returns null after the final attempt, never a verdict it cannot back", async () => {
    let attempts = 0;
    const read = await readCreatedRef(
      () => {
        attempts += 1;
        throw new Error("gh: Not Found (HTTP 404)");
      },
      { attempts: 3, sleep: async () => {} },
    );
    assert.equal(attempts, 3);
    assert.equal(read, null);
  });

  it("treats a read that answers nothing as not-yet-readable, not as success", async () => {
    // A 2xx shape with no ref in it is the "created nothing" failure the
    // read-back exists to catch; it must burn attempts, not satisfy them.
    let attempts = 0;
    const read = await readCreatedRef(
      () => {
        attempts += 1;
        return attempts < 2 ? null : ref;
      },
      { sleep: async () => {} },
    );
    assert.equal(attempts, 2);
    assert.equal(read, ref);
  });
});

describe("readBackDelay", () => {
  it("doubles per attempt from one second", () => {
    assert.deepEqual([0, 1, 2, 3].map(readBackDelay), [1000, 2000, 4000, 8000]);
  });
});
