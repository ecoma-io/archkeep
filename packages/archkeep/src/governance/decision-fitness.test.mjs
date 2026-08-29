import { describe, expect, it } from "vitest";

import { fitnessVerdict } from "./verdict.mjs";
import {
  DECISION_FITNESS_LEVELS,
  computeDecisionFitness,
  isRedDirection,
} from "./decision-fitness.mjs";

/**
 * Build a verdict record in the shape `fitness-registry` rows carry.
 *
 * @param {string} name The fitness/constraint id.
 * @param {string} verdict `pass|fail|unknown|not_applicable`.
 * @returns {object}
 */
function verdict(name, verdict) {
  return fitnessVerdict({
    verdict,
    name,
    evidence: { [name]: verdict },
    message: `${name} → ${verdict}`,
    ...(verdict === "not_applicable" ? { notApplicableReason: "no projects match" } : {}),
  });
}

/**
 * A `decisionRefLookup` that resolves a bound id to its verdict, or `undefined`
 * when a caller supplied none — an unresolved binding.
 *
 * @param {Record<string, object>} byName
 * @returns {(id: string) => (object | undefined)}
 */
function lookup(byName) {
  return (id) => byName[id];
}

/** A resolver that resolves nothing — every binding is unverified. */
function none() {
  return undefined;
}

/** An ADR record carrying authority. */
function record(id, status, bindings = []) {
  return { id, status, bindings };
}

describe("decision fitness — vocabulary and red directions", () => {
  it("exposes the closed vocabulary and names the two red directions", () => {
    expect(DECISION_FITNESS_LEVELS).toEqual([
      "enforced",
      "partially-enforced",
      "violated",
      "unverifiable",
      "not_applicable",
    ]);
    expect(isRedDirection("violated")).toBe(true);
    expect(isRedDirection("unverifiable")).toBe(true);
    expect(isRedDirection("enforced")).toBe(false);
    expect(isRedDirection("partially-enforced")).toBe(false);
    expect(isRedDirection("not_applicable")).toBe(false);
  });
});

describe("enforced — green, and its silent direction", () => {
  it("active decision with one bound constraint verified true → enforced", () => {
    const records = [record("001-layout", "active", ["hotspot"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ hotspot: verdict("hotspot", "pass") }),
    );
    expect(result[0].level).toBe("enforced");
    expect(result[0].verified).toBe(true);
    expect(result[0].reason).toBeUndefined();
  });

  it("active decision with every bound constraint passing → enforced (complete coverage)", () => {
    const records = [record("001-layout", "active", ["hotspot", "cycle-free"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ hotspot: verdict("hotspot", "pass"), "cycle-free": verdict("cycle-free", "pass") }),
    );
    expect(result[0].level).toBe("enforced");
    expect(result[0].verified).toBe(true);
  });

  it("SILENT DIRECTION: a bound constraint that evaluates to unknown is never enforced", () => {
    // "no violation" must not read as healthy when the constraint could not be
    // verified true — this is the enforced-direction's silent case.
    const records = [record("001-layout", "active", ["hotspot"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ hotspot: verdict("hotspot", "unknown") }),
    );
    expect(result[0].level).toBe("unverifiable");
    expect(result[0].verified).toBe(false);
  });
});

describe("violated — red when a bound constraint fails", () => {
  it("a failing bound constraint → violated, red, naming what failed", () => {
    const records = [record("001-layout", "active", ["hotspot"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ hotspot: verdict("hotspot", "fail") }),
    );
    expect(result[0].level).toBe("violated");
    expect(result[0].verified).toBe(false);
    expect(result[0].reason).toContain("hotspot");
    expect(result[0].reason).toContain("FAILED");
  });

  it("a fail wins over a pass present on the same decision", () => {
    const records = [record("001-layout", "active", ["hotspot", "cycle-free"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({
        hotspot: verdict("hotspot", "fail"),
        "cycle-free": verdict("cycle-free", "pass"),
      }),
    );
    expect(result[0].level).toBe("violated");
    expect(result[0].verified).toBe(false);
  });
});

describe("unverifiable — the SILENT-direction case for this wave", () => {
  it("active decision with NO bound constraints is unverifiable, never healthy", () => {
    // The load-bearing silent-direction test: a decision with authority but no
    // executable constraint must be detected, never reported as enforced or
    // healthy — a "no violation" reading would hide that nothing is enforced.
    const records = [record("001-layout", "active", [])];
    const result = computeDecisionFitness(records, undefined, none);
    expect(result[0].level).toBe("unverifiable");
    expect(result[0].verified).toBe(false);
    expect(result[0].reason).toContain("no executable constraint");
  });

  it("accepted decision whose bindings do not resolve → unverifiable", () => {
    const records = [record("002-runtime", "accepted", ["missing-fitness"])];
    const result = computeDecisionFitness(records, [], lookup({}));
    expect(result[0].level).toBe("unverifiable");
    expect(result[0].verified).toBe(false);
  });

  it("SILENT DIRECTION: a bound constraint that evaluates to unknown → unverifiable", () => {
    // evaluated but could not tell — coverage incomplete, still never a pass.
    const records = [record("003-identity", "active", ["coverage-min"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ "coverage-min": verdict("coverage-min", "unknown") }),
    );
    expect(result[0].level).toBe("unverifiable");
    expect(result[0].reason).toContain("none verified true");
  });

  it("unverifiable is elected red (isRedDirection)", () => {
    expect(isRedDirection("unverifiable")).toBe(true);
  });
});

describe("partially-enforced — some verified, others not", () => {
  it("one binding passes, another is unknown → partially-enforced", () => {
    const records = [record("004-serving", "active", ["hotspot", "cycle-free"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({
        hotspot: verdict("hotspot", "pass"),
        "cycle-free": verdict("cycle-free", "unknown"),
      }),
    );
    expect(result[0].level).toBe("partially-enforced");
    expect(result[0].verified).toBe(false);
    expect(result[0].reason).toContain("1 of 2");
  });

  it("one binding passes, another does not resolve → partially-enforced", () => {
    const records = [record("004-serving", "active", ["hotspot", "cycle-free"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ hotspot: verdict("hotspot", "pass") }),
    );
    expect(result[0].level).toBe("partially-enforced");
    expect(result[0].verified).toBe(false);
  });
});

describe("not_applicable — decisions without authority are not measured", () => {
  const noAuthorityStatuses = ["proposed", "superseded", "retired"];

  for (const status of noAuthorityStatuses) {
    it(`a ${status} decision is not_applicable, never measured`, () => {
      const records = [record("005-x", status, ["hotspot"])];
      const result = computeDecisionFitness(
        records,
        [],
        lookup({ hotspot: verdict("hotspot", "fail") }),
      );
      expect(result[0].level).toBe("not_applicable");
      expect(result[0].verified).toBe(false);
      expect(result[0].reason).toContain(status);
      // A failing bound constraint on a no-authority decision must NOT read as
      // violated — the decision does not govern, so nothing is enforced or
      // violated on its behalf.
      expect(result[0].level).not.toBe("violated");
    });
  }
});

describe("authority — both active and accepted are measured", () => {
  it("an accepted decision with a passing binding is enforced", () => {
    const records = [record("006-tooling", "accepted", ["tag-conformance"])];
    const result = computeDecisionFitness(
      records,
      [],
      lookup({ "tag-conformance": verdict("tag-conformance", "pass") }),
    );
    expect(result[0].level).toBe("enforced");
    expect(result[0].verified).toBe(true);
  });
});

describe("determinism — no clock, identical inputs → identical output", () => {
  it("computing twice yields byte-identical results and needs no io/clock", () => {
    const records = [
      record("001-layout", "active", ["hotspot"]),
      record("002-runtime", "accepted", []),
      record("003-x", "proposed", ["hotspot"]),
    ];
    const dict = { hotspot: verdict("hotspot", "pass") };
    const once = computeDecisionFitness(records, [], lookup(dict));
    const twice = computeDecisionFitness(records, [], lookup(dict));
    expect(twice).toEqual(once);
    // Deterministic regardless of any injected io seam being absent.
    const noIo = computeDecisionFitness(records, [], lookup(dict));
    expect(noIo).toEqual(once);
  });
});
