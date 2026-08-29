import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventDedupeKey, eventId } from "./evolution-event.mjs";
import { readEvents, writeEvent } from "./evolution-store.mjs";

let tmp;
let root;
let eventsDir;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "archkeep-events-"));
  root = join(tmp, "root");
  mkdirSync(root);
  eventsDir = join(root, "events");
  mkdirSync(eventsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A distinct transition event per label — different tuple ⇒ different id/key. */
const makeEvent = (label) => {
  const event = {
    schemaVersion: 1,
    kind: "transition",
    source: "delta",
    base: { revision: `base-${label}` },
    head: { revision: `head-${label}` },
    observed: {},
    findings: { introduced: [], resolved: [], unknown: [] },
    fitness: { verdictDeltas: [] },
    debt: { introduced: [], resolved: [] },
    classifications: [],
    disposition: "accepted",
    notes: [],
    affected: { projects: [], boundaries: [], constraints: [], decisions: [] },
    // TypeScript placeholders: derived from the canonical tuple below.
    id: "",
    dedupeKey: "",
  };
  event.dedupeKey = eventDedupeKey(event);
  event.id = eventId(event);
  return event;
};

const eventFiles = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".json.tmp"))
    .sort();

describe("writeEvent", () => {
  it("writes the first event atomically as 0000-<id8>.json with no .tmp left", () => {
    const event = makeEvent("a");
    const result = writeEvent(eventsDir, event, { root });

    expect(result).toEqual({ id: event.id, duplicate: false });
    const names = eventFiles(eventsDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^0000-[0-9a-f]{8}\.json$/);
    // The atomic-write contract: the intermediate .tmp is gone after the rename.
    expect(readdirSync(eventsDir).filter((name) => name.endsWith(".json.tmp"))).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(eventsDir, names[0]), "utf8"))).toEqual(event);
  });

  it("sequences events 0000, 0001, … in append order", () => {
    const first = writeEvent(eventsDir, makeEvent("a"), { root });
    const second = writeEvent(eventsDir, makeEvent("b"), { root });

    expect(first.id).not.toBe(second.id);
    expect(eventFiles(eventsDir)).toEqual([
      `0000-${first.id.slice(0, 8)}.json`,
      `0001-${second.id.slice(0, 8)}.json`,
    ]);
  });

  it("dedupes by dedupeKey — a rerun returns duplicate:true and writes nothing", () => {
    const event = makeEvent("a");
    const first = writeEvent(eventsDir, event, { root });
    const second = writeEvent(eventsDir, event, { root });

    expect(first).toEqual({ id: event.id, duplicate: false });
    expect(second).toEqual({ id: event.id, duplicate: true });
    expect(eventFiles(eventsDir)).toHaveLength(1);
    // The id the duplicate reports is the canonical one, identical to the write.
    expect(second.id).toBe(event.id);
  });

  it("creates a missing store directory for the first event", () => {
    const fresh = join(root, "never-seen");
    const result = writeEvent(fresh, makeEvent("a"), { root });
    expect(result.duplicate).toBe(false);
    expect(eventFiles(fresh)).toHaveLength(1);
  });

  it("refuses an event whose id does not match the canonical tuple", () => {
    const event = makeEvent("a");
    const lyingId = { ...event, id: "0".repeat(64) };
    expect(() => writeEvent(eventsDir, lyingId, { root })).toThrow(/does not match/);
    expect(eventFiles(eventsDir)).toHaveLength(0);
  });

  it("refuses an event whose dedupeKey does not match the canonical tuple", () => {
    const event = makeEvent("a");
    const lyingKey = { ...event, dedupeKey: "forged-key" };
    expect(() => writeEvent(eventsDir, lyingKey, { root })).toThrow(/does not match/);
    expect(eventFiles(eventsDir)).toHaveLength(0);
  });

  it("requires io.root so a write can be proven contained", () => {
    expect(() => writeEvent(eventsDir, makeEvent("a"), {})).toThrow(/io\.root/);
  });

  it("refuses a planted .tmp symlink instead of following it (wx)", () => {
    // The silent direction: a symlink at the predictable .tmp path would hand
    // the event bytes to wherever it points. `{flag: "wx"}` refuses an
    // existing path — symlink included — so the write throws and nothing lands.
    const event = makeEvent("a");
    const tmpName = `0000-${event.id.slice(0, 8)}.json.tmp`;
    symlinkSync(join(root, "decoy"), join(eventsDir, tmpName));
    expect(() => writeEvent(eventsDir, event, { root })).toThrow();
    expect(eventFiles(eventsDir)).toHaveLength(0);
  });

  it("refuses a store directory whose intermediate component escapes the workspace", () => {
    // The containment half of the same escape: a workspace-controlled symlink
    // in an intermediate component would redirect the write outside the tree.
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escaped"));
    expect(() => writeEvent(join(root, "escaped"), makeEvent("a"), { root })).toThrow(
      /symlink|resolves to/,
    );
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it("throws on a stored file it cannot parse instead of silently duplicating it", () => {
    // The malformed file may BE the duplicate — writing over it would
    // manufacture a second event for a record the store could not read.
    writeFileSync(join(eventsDir, "0000-ffffffff.json"), "not json at all", "utf8");
    expect(() => writeEvent(eventsDir, makeEvent("a"), { root })).toThrow(/malformed/);
    expect(eventFiles(eventsDir)).toHaveLength(1);
  });
});

describe("readEvents", () => {
  it("reads a missing directory as an empty store — never an error", () => {
    expect(readEvents(join(root, "no-events"))).toEqual([]);
  });

  it("returns validated events in append (filename) order", () => {
    const a = makeEvent("a");
    const b = makeEvent("b");
    writeEvent(eventsDir, a, { root });
    writeEvent(eventsDir, b, { root });

    expect(readEvents(eventsDir)).toEqual([a, b]);
  });

  it("ignores a leftover .tmp from an interrupted write", () => {
    writeEvent(eventsDir, makeEvent("a"), { root });
    writeFileSync(join(eventsDir, "0001-deadbeef.json.tmp"), "partial", "utf8");

    expect(readEvents(eventsDir)).toHaveLength(1);
  });

  it("throws on a malformed JSON file — the store is not 'empty' because it is broken", () => {
    writeFileSync(join(eventsDir, "0000-ffffffff.json"), "{ not json", "utf8");
    expect(() => readEvents(eventsDir)).toThrow(/malformed/);
  });

  it("throws on a non-object record", () => {
    writeFileSync(
      join(eventsDir, "0000-ffffffff.json"),
      JSON.stringify(["not", "an", "event"]),
      "utf8",
    );
    expect(() => readEvents(eventsDir)).toThrow(/not a JSON object/);
  });

  it("throws on a wrong schemaVersion — a future record must never read as valid", () => {
    const event = { ...makeEvent("a"), schemaVersion: 2 };
    writeFileSync(join(eventsDir, "0000-ffffffff.json"), JSON.stringify(event), "utf8");
    expect(() => readEvents(eventsDir)).toThrow(/schemaVersion/);
  });

  it("throws on a classification outside the vocabulary", () => {
    const event = { ...makeEvent("a"), classifications: ["CHANGE", "MAGIC"] };
    writeFileSync(join(eventsDir, "0000-ffffffff.json"), JSON.stringify(event), "utf8");
    expect(() => readEvents(eventsDir)).toThrow(/classifications/);
  });

  it("throws on a disposition outside the vocabulary", () => {
    const event = { ...makeEvent("a"), disposition: "maybe" };
    writeFileSync(join(eventsDir, "0000-ffffffff.json"), JSON.stringify(event), "utf8");
    expect(() => readEvents(eventsDir)).toThrow(/disposition/);
  });
});
