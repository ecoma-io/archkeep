import { describe, expect, it } from "vitest";

import { formatHistoryReport } from "./history-text.mjs";

// The renderer is a pure function of the evolution record and coverage, so
// every branch is pinned by feeding it shaped inputs directly — the same
// contract `diff-text.mjs`'s tests follow for `formatDiffReport`.

const coverage = { complete: true, projects: 2, analyzedFiles: 4, imports: 3 };

/** A minimal transition payload in the shape `computeEvolution` produces. */
function transition(overrides = {}) {
  return {
    from: "0001-a.json",
    to: "0002-b.json",
    architectureChanged: false,
    changes: null,
    policyChanged: null,
    policyOneSided: false,
    provenanceChanged: false,
    providerChanged: false,
    codeDrift: false,
    notes: [],
    ...overrides,
  };
}

const snapshots = [
  { name: "0001-a.json", id: "aaaaaaaaaaaaaaaa" },
  { name: "0002-b.json", id: "bbbbbbbbbbbbbbbb" },
];

describe("formatHistoryReport", () => {
  it("states the directory, counts, and inspection scope in the header", () => {
    const text = formatHistoryReport({
      evolution: { dir: "/ws/hist", captured: null, snapshots, transitions: [transition()] },
      coverage,
    });
    expect(text).toContain("history  /ws/hist");
    expect(text).toContain("2 snapshots, 1 transition (3 imports in 4 files across 2 projects)");
  });

  it("lists each snapshot with its short id", () => {
    const text = formatHistoryReport({
      evolution: { dir: "/ws/hist", captured: null, snapshots, transitions: [transition()] },
      coverage,
    });
    expect(text).toContain("0  0001-a.json  aaaaaaaa");
    expect(text).toContain("1  0002-b.json  bbbbbbbb");
  });

  it("reports a capture as written", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: { name: "0002-b.json" },
        snapshots,
        transitions: [transition()],
      },
      coverage,
    });
    expect(text).toContain("capture  0002-b.json written");
  });

  it("reports a deduplicated capture", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: { name: "0001-a.json", duplicate: true },
        snapshots,
        transitions: [transition()],
      },
      coverage,
    });
    expect(text).toContain("capture  0001-a.json — already the last snapshot, no new file written");
  });

  it("classifies an architecture-changing transition with its changes", () => {
    const changes = {
      addedProjects: [],
      removedProjects: [],
      changedProjects: [],
      addedEdges: [{ source: "a", target: "b", type: "static" }],
      removedEdges: [],
    };
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ architectureChanged: true, changes, notes: ["a note"] })],
      },
      coverage,
    });
    expect(text).toContain("~ 0001-a.json → 0002-b.json  (architecture)");
    expect(text).toContain("+ 1 added edge");
    expect(text).toContain("  a → b (static)");
    expect(text).toContain("  a note");
    expect(text).toContain("1 transition recorded an architectural change");
  });

  it("renders removed projects, changed projects, and removed edges", () => {
    const changes = {
      addedProjects: [{ name: "new", root: "libs/new", tags: [] }],
      removedProjects: [{ name: "gone", root: "libs/gone", tags: ["layer:core"] }],
      changedProjects: [
        { name: "a", changes: [{ field: "root", baseline: "libs/old-a", head: "libs/a" }] },
      ],
      addedEdges: [],
      removedEdges: [{ source: "a", target: "c", type: "static" }],
    };
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ architectureChanged: true, changes })],
      },
      coverage,
    });
    expect(text).toContain("+ 1 added project");
    expect(text).toContain("  new  libs/new");
    expect(text).toContain("- 1 removed project");
    expect(text).toContain("  gone  libs/gone [layer:core]");
    expect(text).toContain("~ 1 changed project");
    expect(text).toContain("  a");
    expect(text).toContain("  root  libs/old-a → libs/a");
    expect(text).toContain("- 1 removed edge");
    expect(text).toContain("  a → c (static)");
  });

  it("classifies a policy change even when the graph did not move", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ policyChanged: true, notes: ["policy changed"] })],
      },
      coverage,
    });
    expect(text).toContain("(policy)");
    expect(text).toContain("  policy changed");
    // A policy-only transition is not an architectural change — the footer
    // says so rather than counting it as one.
    expect(text).toContain(
      "✔ no architectural change recorded across the snapshots (only policy, provider, or drift signals)",
    );
  });

  it("classifies a provider change", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ providerChanged: true, notes: ["provider changed"] })],
      },
      coverage,
    });
    expect(text).toContain("(provider)");
  });

  it("discloses code drift on an otherwise unchanged transition", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ codeDrift: true })],
      },
      coverage,
    });
    expect(text).toContain("(code drift)");
  });

  it("reports an unchanged transition as unchanged", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition()],
      },
      coverage,
    });
    expect(text).toContain("(unchanged)");
    expect(text).toContain("✔ no architectural change recorded across the snapshots");
  });

  it("labels a one-sided policy pair not comparable, never unchanged", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ policyChanged: null, policyOneSided: true })],
      },
      coverage,
    });
    expect(text).toContain("(not comparable)");
    expect(text).not.toContain("(unchanged)");
  });

  it("labels a provenance-advancing pair with no policy on either side not comparable", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ policyChanged: null, provenanceChanged: true })],
      },
      coverage,
    });
    expect(text).toContain("(not comparable)");
    expect(text).not.toContain("(unchanged)");
  });

  it("says so when the history has a single snapshot and no transitions", () => {
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots: [snapshots[0]],
        transitions: [],
      },
      coverage,
    });
    expect(text).toContain("1 snapshot, 0 transitions");
    expect(text).toContain("✔ one snapshot, no transitions yet");
  });

  it("counts only true architecture change in the footer, not policy signals", () => {
    // A policy-only transition is a change to the record's interpretation, not
    // to the architecture — the footer must not read as "N transitions
    // recorded an architectural change".
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ policyChanged: true, notes: ["policy changed"] })],
      },
      coverage,
    });
    expect(text).toContain("(policy)");
    expect(text).toContain(
      "✔ no architectural change recorded across the snapshots (only policy, provider, or drift signals)",
    );
  });

  it("neutralises control and escape sequences in rendered names", () => {
    const changes = {
      addedProjects: [
        { name: "esc[31mred[0m", root: "libs/esc", tags: [] },
        { name: "ok", root: "libs/ok", tags: ["tagbell"] },
      ],
      removedProjects: [],
      changedProjects: [],
      addedEdges: [{ source: "a", target: "ok", type: "static" }],
      removedEdges: [],
    };
    const text = formatHistoryReport({
      evolution: {
        dir: "/ws/hist",
        captured: null,
        snapshots,
        transitions: [transition({ architectureChanged: true, changes, notes: [] })],
      },
      coverage,
    });
    // No raw ESC byte may reach the output.
    expect(text).not.toContain("");
    expect(text).toContain("\\x1b[31mred\\x1b[0m");
    expect(text).toContain("tag\\x07bell");
  });
});
