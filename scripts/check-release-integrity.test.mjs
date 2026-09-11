// Tests for check-release-integrity.mjs.
//
// Everything here drives the REAL installed parser — the same
// `parseConventionalCommits` call the release lane makes — because the gate's
// subject is precisely how that call fails, and a stubbed parse would only
// pin our theory of the failure. What is deliberately NOT tested is `main()`
// and its filesystem/git/network seams: a test that stubbed git's answer
// would pin the stub, and the real seams are exercised every CI run against
// this tree.
//
// Each case is named by the state it pins. The silent direction is the
// load-bearing one for this gate: release-please 17.x drops unparseable
// commits behind a debug log, so the tests must prove that the shapes issue
// #903 reported are flagged, and that the commits the parser drops BY DESIGN
// (non-conventional messages, malformed headers) are not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConventionalCommits } from "release-please/build/src/commit.js";
import {
  detectParseFailures,
  isConventionalSubject,
  yieldsLaneEntry,
  parseActionPin,
  laneEntryCount,
  pickRange,
  rangeAdmits,
  readLock,
  remoteActionAdmits,
  renderReport,
  verifyVersionLock,
} from "./check-release-integrity.mjs";

const SHA = (c) => c.repeat(40);
const commit = (sha, message) => ({ sha, message });

const detect = (commits) => detectParseFailures({ commits, parse: parseConventionalCommits });

test("a body line with word(word(word)) is dropped and flagged with the parser's own error", () => {
  // The minimal shape of the #903 defect: a well-formed conventional commit
  // whose body the parser's scope rule cannot tokenize.
  const commits = [commit(SHA("a"), "fix(x): subject\n\n`foo(bar(baz))`.\n")];
  const { failures, parsedCount } = detect(commits);
  assert.equal(parsedCount, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].sha, SHA("a"));
  assert.equal(failures[0].kind, "dropped");
  assert.match(failures[0].reason, /unexpected token '\('/);
  assert.match(failures[0].reason, /commit could not be parsed: a{40}/);
});

test("the real-world body line from the issue is flagged", () => {
  const commits = [
    commit(
      SHA("4"),
      "fix(archkeep): decide historyOutputRefusal on the physical destination (#896)\n\n" +
        "We still compare the resolved path:\n" +
        "`physicalDestination(dirname(outputAbs)) === physicalDestination(dir)`.\n",
    ),
  ];
  const { failures } = detect(commits);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "dropped");
  assert.match(failures[0].reason, /unexpected token/);
});

test("in a mixed batch exactly the thrower is flagged", () => {
  const commits = [
    commit(SHA("a"), "fix(x): subject\n\n`foo(bar(baz))`.\n"),
    commit(
      SHA("b"),
      "feat: add the thing\n\nA body with a single parenthetical (like this) is fine.\n",
    ),
    commit(SHA("c"), "docs: update the readme\n"),
    commit(SHA("d"), "chore(archkeep): release 0.28.1\n"),
    commit(SHA("e"), "chore(deps): bump some-dep from 1.2.3 to 1.3.0\n"),
    commit(SHA("f"), "Merge pull request #895 from ecoma-io/a-branch\n\nfeat: the merged work\n"),
    commit(SHA("9"), "Update dependencies by hand\n"),
  ];
  const { failures } = detect(commits);
  assert.deepEqual(
    failures.map((f) => f.sha),
    [SHA("a")],
  );
  assert.equal(failures[0].subject, "fix(x): subject");
});

test("non-conventional and malformed-header commits are not findings, though the parser drops them", () => {
  // Both of these vanish from the parse output with a debug line — that is
  // the parser's designed exclusion, not the defect. A gate that flagged
  // them would fail every lane that ever carried a squash-merge or a hand
  // commit.
  const commits = [
    commit(SHA("b"), "Update dependencies by hand\n"),
    commit(SHA("9"), "fix missing colon\n"),
  ];
  const { failures } = detect(commits);
  assert.deepEqual(failures, []);
});

test("a nested-commit block that fails to parse is a partial finding on the carrying commit", () => {
  const commits = [
    commit(
      SHA("f"),
      "feat: outer ok\n\nBEGIN_NESTED_COMMIT\nfix: inner fine\n\n`a(b(c))`\nEND_NESTED_COMMIT\n",
    ),
  ];
  const { failures } = detect(commits);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "partial");
  assert.match(failures[0].reason, /unexpected token/);
});

test("an empty range is zero findings, not silence", () => {
  const { failures, parsedCount } = detect([]);
  assert.deepEqual(failures, []);
  assert.equal(parsedCount, 0);
});

test("every finding names the sha, the subject, and the parser's reason", () => {
  const commits = [
    commit(SHA("a"), "fix(x): subject\n\n`foo(bar(baz))`.\n"),
    commit(
      SHA("f"),
      "feat: outer ok\n\nBEGIN_NESTED_COMMIT\nfix: inner fine\n\n`a(b(c))`\nEND_NESTED_COMMIT\n",
    ),
  ];
  for (const failure of detect(commits).failures) {
    assert.match(failure.sha, /^[0-9a-f]{40}$/);
    assert.equal(typeof failure.subject, "string");
    assert.ok(failure.subject.length > 0);
    assert.match(failure.reason, /unexpected token/);
    assert.ok(["dropped", "partial"].includes(failure.kind));
  }
});

test("isConventionalSubject agrees with the parser about what could become a changelog entry", () => {
  assert.equal(isConventionalSubject("fix: subject"), true);
  assert.equal(isConventionalSubject("feat(scope)!: subject"), true);
  assert.equal(isConventionalSubject("chore(archkeep): release 0.28.1"), true);
  // The parser's grammar allows a colon with no following whitespace; the
  // gate must accept every header the parser would turn into an entry, or
  // the drops of those headers go unexamined.
  assert.equal(isConventionalSubject("fix(x):ship it"), true);
  assert.equal(isConventionalSubject("feat!:ship it"), true);
  assert.equal(isConventionalSubject("fix:\tsubject"), true);
  assert.equal(isConventionalSubject("Update dependencies by hand"), false);
  assert.equal(isConventionalSubject("fix missing colon"), false);
  assert.equal(isConventionalSubject("Merge pull request #895 from ecoma-io/a-branch"), false);
});

test("yieldsLaneEntry agrees with the splitter about what reaches the parser", () => {
  assert.equal(yieldsLaneEntry("fix: subject"), true);
  // splitMessages splits a blank-line-delimited conventional paragraph out
  // of any commit — merge-commit subjects in front of carried entries are
  // the shape to defend against.
  assert.equal(
    yieldsLaneEntry("Merge pull request #895 from ecoma-io/a-branch\n\nfeat: the merged work\n"),
    true,
  );
  assert.equal(yieldsLaneEntry("Merge pull request #895 from ecoma-io/a-branch\n"), false);
  assert.equal(yieldsLaneEntry("Update dependencies by hand\n\nsome prose, no entry\n"), false);
  // BEGIN_NESTED_COMMIT blocks are extracted and parsed on their own,
  // whatever the first line is.
  assert.equal(
    yieldsLaneEntry(
      "Update dependencies by hand\n\nBEGIN_NESTED_COMMIT\nfix: inner\nEND_NESTED_COMMIT\n",
    ),
    true,
  );
});
test("laneEntryCount mirrors the splitter's piece count", () => {
  // in front of a merge-commit subject, zero in plain prose, two when a
  // nested block is extracted for separate parsing.
  assert.equal(
    laneEntryCount("Merge pull request #895 from ecoma-io/a-branch\n\nfeat: the merged work\n"),
    1,
  );
  assert.equal(laneEntryCount("Update dependencies by hand\n\nsome prose, no entry\n"), 0);
  assert.equal(
    laneEntryCount(
      "feat: outer ok\n\nBEGIN_NESTED_COMMIT\nfix: inner fine\n\n`a(b(c))`\nEND_NESTED_COMMIT\n",
    ),
    2,
  );
});

test("a merge commit carrying a nested entry the parser drops is a finding", () => {
  // The silent-direction case the first-line predicate missed: nothing on
  // the first line is conventional, yet the lane loses the carried
  // `feat:` entry to the same body throw as issue #903.
  const commits = [
    commit(
      SHA("f"),
      "Merge pull request #895 from ecoma-io/a-branch\n\nfeat: the merged work\n\n`foo(bar(baz))`.\n",
    ),
  ];
  const { failures, parsedCount } = detect(commits);
  assert.equal(parsedCount, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "dropped");
  assert.match(failures[0].reason, /unexpected token/);
});

test("a partial finding survives a shortened sha in the parser's debug lines", () => {
  const commits = [
    commit(
      SHA("a"),
      "feat: outer\n\nBEGIN_NESTED_COMMIT\nfix: inner\n\n`a(b(c))`\nEND_NESTED_COMMIT\n",
    ),
  ];
  const shortSha = SHA("a").slice(0, 8);
  const failures = detectParseFailures({
    commits,
    parse: (parsed, logger) => {
      logger.debug(`commit could not be parsed: ${shortSha} fix: inner`);
      logger.debug("error message: Error: unexpected token '('");
      // The commit itself parses; only its nested message failed.
      return /** @type {ReturnType<typeof parseConventionalCommits>} */ ([
        { sha: SHA("a"), message: "feat: outer" },
      ]);
    },
  }).failures;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, "partial");
});

test("the report names every finding and states the release-less claim in full", () => {
  const lock = { releasePlease: "17.6.0", parser: "0.4.1" };
  const clean = renderReport({ range: "v0.28.1..HEAD", commits: [], failures: [], lock });
  assert.equal(clean.length, 1);
  assert.match(clean[0], /^ok {3}v0\.28\.1\.\.HEAD — 0 commit\(s\)/);

  const failing = renderReport({
    range: "v0.28.1..HEAD",
    commits: [commit(SHA("a"), "fix(x): subject\n\n`foo(bar(baz))`.\n")],
    failures: detect([commit(SHA("a"), "fix(x): subject\n\n`foo(bar(baz))`.\n")]).failures,
    lock,
  });
  assert.match(failing.join("\n"), /FAIL a{12} \[dropped\] fix\(x\): subject/);
  assert.match(failing.join("\n"), /1 of 1 commit\(s\)/);
});

test("pickRange falls back through the manifest's history on a release pull request", () => {
  // The release-PR shape: the working tree's manifest names the NEXT
  // release, whose tag exists only after the action runs post-merge. The
  // boundary release-please itself reads is the last released version, one
  // manifest generation back — on the release PR's CI run and on the
  // release-merge push alike.
  assert.equal(
    pickRange({
      versions: ["0.29.0", "0.28.1"],
      tagResolves: (version) => version !== "0.29.0",
    }),
    "v0.28.1..HEAD",
  );
  // An ordinary push: the working tree's tag resolves immediately.
  assert.equal(pickRange({ versions: ["0.28.1"], tagResolves: () => true }), "v0.28.1..HEAD");
  // No candidate resolves — the caller must report, never scan nothing.
  assert.equal(pickRange({ versions: ["0.29.0", "0.28.1"], tagResolves: () => false }), null);
});

test("rangeAdmits judges the spellings an action package.json uses", () => {
  assert.equal(rangeAdmits("^17.6.0", "17.6.0"), true);
  assert.equal(rangeAdmits("^17.6.0", "17.11.2"), true);
  assert.equal(rangeAdmits("^17.6.0", "18.0.0"), false);
  assert.equal(rangeAdmits("^17.6.0", "16.15.0"), false);
  assert.equal(rangeAdmits("~17.6.0", "17.6.5"), true);
  assert.equal(rangeAdmits("~17.6.0", "17.9.0"), false);
  assert.equal(rangeAdmits("17.6.0", "17.6.0"), true);
  assert.equal(rangeAdmits("17.6.0", "17.6.1"), false);
  assert.equal(rangeAdmits("^16.0.0 || ^17.0.0", "17.6.0"), true);
  assert.equal(rangeAdmits("^16.0.0 || ^17.0.0", "18.0.0"), false);
  assert.equal(rangeAdmits("workspace:*", "17.6.0"), null);
  assert.equal(rangeAdmits(">=17.0.0 <18", "17.6.0"), null);
  assert.equal(rangeAdmits("^17.6.0", "not-a-version"), null);
});

const LOCK = {
  action: { repo: "googleapis/release-please-action", sha: SHA("5"), version: "v5.0.0" },
  releasePlease: "17.6.0",
  parser: "0.4.1",
};

const RELEASE_YML = [
  "jobs:",
  "  release:",
  "    steps:",
  `      - uses: googleapis/release-please-action@${SHA("5")} # v5.0.0`,
  "        with:",
  "          token: ${{ steps.app-token.outputs.token }}",
].join("\n");

test("a lock agreeing with the workflow and the installed packages is clean", () => {
  assert.deepEqual(
    verifyVersionLock({
      lock: LOCK,
      releaseYmlText: RELEASE_YML,
      installedReleasePlease: "17.6.0",
      installedParser: "0.4.1",
    }),
    [],
  );
});

test("every drifted surface is named: pin, version comment, installed parser", () => {
  const drifted = verifyVersionLock({
    lock: LOCK,
    releaseYmlText: RELEASE_YML.replace(SHA("5"), SHA("6")),
    installedReleasePlease: "17.6.0",
    installedParser: "0.5.0",
  });
  assert.deepEqual(
    drifted.map((v) => v.id),
    ["action-sha-drifted", "parser-drifted"],
  );
});

test("a workflow that no longer pins the action is named, not skipped", () => {
  const drifted = verifyVersionLock({
    lock: LOCK,
    releaseYmlText: "jobs:\n  release:\n    steps:\n      - run: echo hi\n",
    installedReleasePlease: "17.6.0",
    installedParser: "0.4.1",
  });
  assert.deepEqual(
    drifted.map((v) => v.id),
    ["action-pin-missing"],
  );
});

test("parseActionPin reads the real pin shape, or nothing", () => {
  assert.deepEqual(parseActionPin(RELEASE_YML), {
    repo: "googleapis/release-please-action",
    sha: SHA("5"),
    version: "v5.0.0",
  });
  assert.equal(parseActionPin("uses: googleapis/release-please-action@v5 # floating tag\n"), null);
});

test("remoteActionAdmits: range drift, missing dependency, and unreadable package are all violations", () => {
  const bumped = remoteActionAdmits({
    actionPackageText: JSON.stringify({ dependencies: { "release-please": "^18.0.0" } }),
    lock: LOCK,
  });
  assert.deepEqual(
    bumped.map((v) => v.id),
    ["action-range-drifted"],
  );

  const missing = remoteActionAdmits({
    actionPackageText: JSON.stringify({ dependencies: {} }),
    lock: LOCK,
  });
  assert.deepEqual(
    missing.map((v) => v.id),
    ["action-dependency-missing"],
  );

  const unreadable = remoteActionAdmits({ actionPackageText: "{not json", lock: LOCK });
  assert.deepEqual(
    unreadable.map((v) => v.id),
    ["action-package-unreadable"],
  );

  const admitting = remoteActionAdmits({
    actionPackageText: JSON.stringify({ dependencies: { "release-please": "^17.6.0" } }),
    lock: LOCK,
  });
  assert.deepEqual(admitting, []);
});

test("readLock throws on a file that is not JSON, and names shape gaps in one that is", () => {
  assert.throws(() => readLock("not json"));
  const { violations } = readLock(JSON.stringify({ action: {} }));
  assert.ok(violations.length >= 4);
});
