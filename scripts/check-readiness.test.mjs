import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONDITIONS,
  QUIET_STRETCH_COMMITS,
  RELEASES_IN_A_ROW,
  evaluate,
  parseArgs,
  parseDifferential,
} from "./check-readiness.mjs";

/** Facts with nothing supplied — every optional source absent. */
const nothing = {
  commits: [],
  taggedVersions: [],
  publishedVersions: null,
  differential: null,
  externalAdopters: null,
};

/** `count` ordinary commits, newest first. */
const quiet = (count) =>
  Array.from({ length: count }, (_, index) => ({
    subject: `fix(archkeep): something harmless ${index}`,
    body: "",
  }));

const stateOf = (rows, condition) => rows.find((row) => row.condition === condition)?.state;

test("every condition gets a row, and no condition is silently dropped", () => {
  const rows = evaluate(nothing);
  assert.deepEqual(
    rows.map((row) => row.condition),
    [...CONDITIONS],
  );
});

test("an unsupplied source is unmeasured, never met and never failed", () => {
  // The whole point of the third state. Reading "no evidence" as met would be
  // the silent direction; reading it as not met would make the report cry
  // wolf about conditions nobody asked it to judge.
  const rows = evaluate(nothing);
  assert.equal(stateOf(rows, CONDITIONS[0]), "unmeasured");
  assert.equal(stateOf(rows, CONDITIONS[1]), "unmeasured");
  assert.equal(stateOf(rows, CONDITIONS[3]), "unmeasured");
});

test("every unmeasured row names the source that would measure it", () => {
  // An `unmeasured` row that said only "unmeasured" would be the shrug this
  // state exists to avoid: the reader has to learn what to go and read.
  for (const row of evaluate(nothing).filter((row) => row.state === "unmeasured")) {
    assert.match(
      row.evidence,
      /pass --|git log/u,
      `${row.condition} does not name a source: "${row.evidence}"`,
    );
  }
});

test("a red differential is not met, however many runs it has", () => {
  const rows = evaluate({ ...nothing, differential: { red: true, runs: 99 } });
  assert.equal(stateOf(rows, CONDITIONS[0]), "not met");
});

test("one green differential run is not a run of them", () => {
  // "Not one green run — a run of them" is the condition's own wording, and a
  // check that accepted the first green would certify the state the roadmap
  // explicitly excludes.
  assert.equal(
    stateOf(evaluate({ ...nothing, differential: { red: false, runs: 1 } }), CONDITIONS[0]),
    "not met",
  );
  assert.equal(
    stateOf(
      evaluate({ ...nothing, differential: { red: false, runs: RELEASES_IN_A_ROW } }),
      CONDITIONS[0],
    ),
    "met",
  );
});

test("an empty adopter list is not met — supplying nothing is not the same as unmeasured", () => {
  assert.equal(stateOf(evaluate({ ...nothing, externalAdopters: [] }), CONDITIONS[1]), "not met");
  // The entries are `verifiedAdopters`' output — an owner/name@version pair
  // that only a validated attestation (`./verify-gate-attestation.mjs`) can
  // produce, never a bare name typed on a command line.
  assert.equal(
    stateOf(evaluate({ ...nothing, externalAdopters: ["acme/tree@0.15.0"] }), CONDITIONS[1]),
    "met",
  );
});

test("the quiet stretch counts commits since the last breaking change", () => {
  const commits = [
    ...quiet(3),
    { subject: "fix(archkeep)!: change a verdict", body: "" },
    ...quiet(9),
  ];
  const row = evaluate({ ...nothing, commits }).find((entry) => entry.condition === CONDITIONS[2]);
  assert.equal(row.state, "not met");
  assert.match(row.evidence, /^3 of /u);
});

test("a BREAKING CHANGE footer breaks the stretch even when the subject does not", () => {
  // The footer form is the one a commit written by release-please or by a
  // contributor following the spec's second spelling uses; missing it would
  // report a stretch that never happened.
  const commits = [
    ...quiet(2),
    { subject: "feat(archkeep): add a kind", body: "BREAKING CHANGE: the bundle renamed a field" },
    ...quiet(60),
  ];
  const row = evaluate({ ...nothing, commits }).find((entry) => entry.condition === CONDITIONS[2]);
  assert.equal(row.state, "not met");
  assert.match(row.evidence, /^2 of /u);
});

test("a long enough stretch of ordinary commits is met", () => {
  const row = evaluate({ ...nothing, commits: quiet(QUIET_STRETCH_COMMITS) }).find(
    (entry) => entry.condition === CONDITIONS[2],
  );
  assert.equal(row.state, "met");
});

test("no commits read at all is unmeasured, not a quiet stretch", () => {
  // The silent direction for this condition: an empty log means git answered
  // nothing, and reading that as "no breaking changes" would report perfect
  // stability over a repository nobody looked at.
  assert.equal(stateOf(evaluate({ ...nothing, commits: [] }), CONDITIONS[2]), "unmeasured");
});

test("releases are a run of tags the registry received, broken by the first it did not", () => {
  const row = evaluate({
    ...nothing,
    taggedVersions: ["0.4.0", "0.5.0", "0.6.0", "0.7.0"],
    publishedVersions: ["0.4.0", "0.6.0", "0.7.0"],
  }).find((entry) => entry.condition === CONDITIONS[3]);
  assert.equal(row.state, "met");
  assert.match(row.evidence, /2 tag\(s\) in a row/u);
  assert.match(row.evidence, /then 0\.5\.0 did not/u);
});

test("a newest tag the registry never received is not met, whatever came before it", () => {
  // The 0.5.0 failure, in the position that matters: the lane is broken NOW,
  // and a check that counted agreeing releases anywhere in history would call
  // that met.
  const row = evaluate({
    ...nothing,
    taggedVersions: ["0.4.0", "0.5.0", "0.6.0"],
    publishedVersions: ["0.4.0", "0.5.0"],
  }).find((entry) => entry.condition === CONDITIONS[3]);
  assert.equal(row.state, "not met");
  assert.match(row.evidence, /^0 tag\(s\) in a row/u);
});

test("the release row never claims to have read the vsix half", () => {
  const row = evaluate({
    ...nothing,
    taggedVersions: ["0.6.0", "0.7.0"],
    publishedVersions: ["0.6.0", "0.7.0"],
  }).find((entry) => entry.condition === CONDITIONS[3]);
  assert.match(row.evidence, /\.vsix is not read here/u);
});

test("parseArgs takes --flag value pairs and refuses anything else", () => {
  assert.deepEqual(parseArgs(["--attestations", "a.json", "--differential", "3,green"]), {
    attestations: "a.json",
    differential: "3,green",
  });
  assert.throws(() => parseArgs(["positional"]), /unexpected argument/u);
  assert.throws(() => parseArgs(["--attestations"]), /needs a value/u);
  assert.throws(() => parseArgs(["--attestations", "--differential"]), /needs a value/u);
});

test("parseDifferential refuses a shape it cannot read rather than rounding it", () => {
  assert.deepEqual(parseDifferential("4,green"), { runs: 4, red: false });
  assert.deepEqual(parseDifferential("1,red"), { runs: 1, red: true });
  assert.equal(parseDifferential(undefined), null);
  assert.throws(() => parseDifferential("green"), /expects/u);
  assert.throws(() => parseDifferential("4,amber"), /expects/u);
  assert.throws(() => parseDifferential("many,green"), /expects/u);
});
