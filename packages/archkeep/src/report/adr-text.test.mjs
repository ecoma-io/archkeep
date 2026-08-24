import { describe, expect, it } from "vitest";

import { formatAdrDump, formatAdrMissing, formatAdrRecord, formatAdrReverse } from "./adr-text.mjs";

/**
 * One record carrying both halves of the question these tests exist for: a
 * binding the registry itself mentions, and one nothing here corroborates.
 * Asserting on both is what stops a renderer from passing by marking
 * everything — a report that marked every binding `(unknown)` would satisfy
 * "the dangling one is named" and tell a reader nothing.
 */
const RECORD = {
  id: "0002-bind-logs",
  status: "accepted",
  supersedes: ["0001-bind-collaboration"],
  bindings: ["sticky-logs", "fitness:no-such-function"],
};

/** The set `../commands/adr.mjs` derives from the records' own bindings. */
const KNOWN = new Set(["sticky-logs"]);

describe("formatAdrDump", () => {
  it("marks a binding nothing corroborates and leaves a known one bare", () => {
    const text = formatAdrDump({ records: [RECORD], knownFitness: KNOWN });
    expect(text).toContain("bindings:   sticky-logs, fitness:no-such-function (unknown)");
    // The half that keeps the marker meaningful: a known binding is NOT marked.
    expect(text).not.toContain("sticky-logs (unknown)");
  });

  it("names an ADR with no bindings as not yet enforceable, never an empty line", () => {
    const text = formatAdrDump({
      records: [{ ...RECORD, bindings: [] }],
      knownFitness: KNOWN,
    });
    expect(text).toContain("bindings:   (none — not yet enforceable)");
  });

  it("states an empty registry as a sentence, never an empty-looking table", () => {
    expect(formatAdrDump({ records: [] })).toBe(
      "no ADRs in docs/adr/ — nothing is recorded, and nothing is enforceable through it",
    );
  });
});

describe("formatAdrRecord", () => {
  // The silent direction, and the reason this file exists at all: this
  // renderer took no known-fitness parameter, so `adr <NNN-slug>` printed
  // `bindings:   fitness:no-such-function` — byte-identical to a binding the
  // registry corroborates — while `formatAdrDump` marked the very same record
  // `(unknown)` one code path away, and the JSON envelope carried the fact to
  // a machine reader the terminal reader never saw. A reader who narrowed to
  // one record saw strictly less than one who dumped the registry, and what
  // they stopped seeing was the marker.
  it("marks a binding nothing corroborates, exactly as the dump does", () => {
    const text = formatAdrRecord(RECORD, KNOWN);
    expect(text).toContain("fitness:no-such-function (unknown)");
    expect(text).not.toContain("sticky-logs (unknown)");
  });

  it("renders the same bindings line the dump renders for the same record", () => {
    // The two faces are one function now; this is what says so, so a future
    // edit to either cannot reintroduce the divergence above.
    const line = (text) => text.split("\n").find((l) => l.startsWith("bindings:"));
    expect(line(formatAdrRecord(RECORD, KNOWN))).toBe(
      line(formatAdrDump({ records: [RECORD], knownFitness: KNOWN })),
    );
  });

  it("marks every binding when no known set is supplied, rather than none", () => {
    // An absent set means nothing corroborates anything. Marking none would be
    // the quiet answer; marking all is the honest one.
    const text = formatAdrRecord(RECORD);
    expect(text).toContain("sticky-logs (unknown)");
    expect(text).toContain("fitness:no-such-function (unknown)");
  });

  it("states the record's identity, status and supersession chain", () => {
    const text = formatAdrRecord(RECORD, KNOWN);
    expect(text).toContain("0002-bind-logs  (accepted)");
    expect(text).toContain("supersedes: 0001-bind-collaboration");
  });

  it("names an ADR with no bindings as not yet enforceable", () => {
    expect(formatAdrRecord({ ...RECORD, bindings: [] }, KNOWN)).toContain(
      "bindings:   (none — not yet enforceable)",
    );
  });
});

describe("formatAdrReverse and formatAdrMissing", () => {
  it("names an unenforced id in a sentence, never an empty answer", () => {
    expect(formatAdrReverse({ fitnessId: "rule:x", adrIds: [] })).toBe(
      "no ADR in docs/adr/ binds rule:x — it is not enforced by any recorded decision",
    );
  });

  it("lists the binding ADRs when there are some", () => {
    expect(formatAdrReverse({ fitnessId: "rule:x", adrIds: ["0001-a", "0002-b"] })).toBe(
      "rule:x is bound by: 0001-a, 0002-b",
    );
  });

  it("says a requested id resolves to nothing, and that a decisionRef naming it cannot resolve", () => {
    const text = formatAdrMissing({ adrId: "0999-ghost" });
    expect(text).toContain("no ADR 0999-ghost in docs/adr/");
    expect(text).toContain("cannot resolve");
  });
});
