import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePeerFloorMajor } from "./peer-floor.mjs";

test("reads the floor off >= comparators", () => {
  assert.equal(parsePeerFloorMajor(">=21"), 21);
  assert.equal(parsePeerFloorMajor(">=21.4.2"), 21);
});

test("a conjunction floors at its loosest >= comparator", () => {
  assert.equal(parsePeerFloorMajor(">=5 <7"), 5);
});

test("reads the floor off caret, tilde, and exact-major shapes", () => {
  assert.equal(parsePeerFloorMajor("^21"), 21);
  assert.equal(parsePeerFloorMajor("~21.1"), 21);
  assert.equal(parsePeerFloorMajor("21.x"), 21);
  assert.equal(parsePeerFloorMajor("21.4.2"), 21);
});

test("an unbounded range yields null, which the lane turns red", () => {
  // The silent direction: if the parser guessed a floor for an unbounded
  // range, the floor lane would test a version of its own invention while
  // reading green. null is the value the caller fails on.
  assert.equal(parsePeerFloorMajor("*"), null);
  assert.equal(parsePeerFloorMajor("latest"), null);
  assert.equal(parsePeerFloorMajor(""), null);
});
