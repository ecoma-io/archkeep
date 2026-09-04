/**
 * The `coverage.unowned` acceptance channel's withdrawal half, pinned at unit
 * level.
 *
 * The matching half (`partitionUnownedCoverage`) is exercised end to end
 * through `../cli.integration.test.mjs`'s acceptance-channel suite, the one
 * place the whole `check` pipeline runs over a tree that declares rows. The
 * withdrawal's refusal state — an accepted file carrying more than one failure
 * — is reachable through no producer that exists today, which is exactly why
 * it is pinned here, where the failure list is a plain argument instead of
 * something only an analysis pass can build.
 */

import { describe, expect, it } from "vitest";

import { fileFailure } from "../analysis/source-util.mjs";
import { withdrawAcceptedUnclaimedFailures } from "./coverage-acceptance.mjs";

describe("withdrawAcceptedUnclaimedFailures", () => {
  it("withdraws the accepted file's failure and leaves every other failure in place", () => {
    const failures = [
      fileFailure("libs/broken.go", "could not be read"),
      fileFailure("orphans/legacy.go", "is not owned by any project in the Nx project graph"),
      fileFailure("orphans/other.go", "is not owned by any project in the Nx project graph"),
    ];

    const withdrawn = withdrawAcceptedUnclaimedFailures(failures, new Set(["orphans/legacy.go"]));

    expect(withdrawn.map(({ sourceFile }) => sourceFile)).toEqual([
      "libs/broken.go",
      "orphans/other.go",
    ]);
  });

  it("refuses an accepted file that carries two failures — withdrawing both would understate coverage", () => {
    const failures = [
      fileFailure("orphans/legacy.go", "is not owned by any project in the Nx project graph"),
      // The shape a future producer could add: a second failure for the same
      // file. A splice that removes every failure matching an accepted file's
      // `sourceFile` drops BOTH rows — the failure count falls, and a
      // could-not-look run tips toward a clean one with no word anywhere.
      fileFailure("orphans/legacy.go", "go.mod could not be parsed"),
    ];

    expect(() =>
      withdrawAcceptedUnclaimedFailures(failures, new Set(["orphans/legacy.go"])),
    ).toThrow(/orphans\/legacy\.go/u);
    expect(() =>
      withdrawAcceptedUnclaimedFailures(failures, new Set(["orphans/legacy.go"])),
    ).toThrow(/carries 2 failures/u);
  });
});
