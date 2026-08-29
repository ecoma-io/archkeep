/**
 * The terminal report for the `trajectory` command: the aggregate signals
 * across a snapshot history, with what each number is a claim about.
 *
 * Every line states counts, never judgments — the report has no "better", no
 * score, no direction adjective. The header names the observation basis (one
 * observation is one stored graph snapshot, not a commit or a day), an
 * insufficient history says so instead of printing zeros, and the disclosures
 * line prints even when every count is zero, so a reader can tell "nothing
 * was incomparable" from "the report forgot to say".
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`../README.md`).
 */

/**
 * Neutralises control and terminal-escape sequences before anything reaches
 * the terminal (`SECURITY.md`) — the same sanitation every other renderer
 * applies. Only paths and snapshot filenames are printed here; project and
 * edge identities stay aggregated precisely so nothing name-shaped needs to.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\x00-\x1F\x7F]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * A delta with its sign, so +2 / -1 / 0 read as movement rather as bare
 * magnitudes. Zero prints unsigned — it is the absence of movement, not a
 * positive one.
 *
 * @param {number|null} value
 * @returns {string}
 */
function signed(value) {
  if (value === null) return "n/a";
  if (value > 0) return `+${value}`;
  return `${value}`;
}

/**
 * A count that is either established or explicitly unavailable. `null`
 * renders as `n/a` beside the reason the header already stated — never as a
 * zero that would claim a measurement.
 *
 * @param {number|null} value
 * @returns {string}
 */
function counted(value) {
  return value === null ? "n/a" : `${value}`;
}

/**
 * One structural axis as one line: endpoints, then events, then persistence.
 *
 * @param {{first: number, current: number, delta: number|null,
 *   addedEvents: number|null, removedEvents: number|null,
 *   changedEvents: number|null, introduced: number|null, resolved: number|null,
 *   persistent: number|null}} axis
 * @param {boolean} withChanged Whether the axis carries a changed-event count
 *   (projects do; edges do not — a type flip is remove+add under the triple
 *   identity).
 * @returns {string}
 */
function formatAxis(axis, withChanged) {
  const parts = [
    `first ${axis.first}`,
    `current ${axis.current}`,
    `delta ${signed(axis.delta)}`,
    `added ${counted(axis.addedEvents)}`,
    `removed ${counted(axis.removedEvents)}`,
  ];
  if (withChanged) parts.push(`changed ${counted(axis.changedEvents)}`);
  parts.push(
    `introduced ${counted(axis.introduced)}`,
    `resolved ${counted(axis.resolved)}`,
    `persistent ${counted(axis.persistent)}`,
  );
  return parts.join(" · ");
}

/**
 * The whole trajectory report.
 *
 * @param {{trajectory: {dir: string, observations: {count: number, basis: string,
 *   first: string|null, last: string|null, withProvenance: number,
 *   dirtyProvenance: number}, available: boolean, unavailableReason: string|null,
 *   transitions: {count: number, architecture: number, policy: number,
 *     provider: number, codeDrift: number, incomparable: number, unchanged: number},
 *   disclosures: {policyOneSided: number, provenanceOneSided: number, crossRepo: number},
 *   projects: object, edges: object,
 *   trends: object|null}, coverage: object}} input
 * @returns {string}
 */
export function formatTrajectoryReport({ trajectory, coverage }) {
  const sections = [];

  const observations = trajectory.observations;
  sections.push(`trajectory  ${trajectory.dir}`);
  sections.push(
    `${observations.count} observation${observations.count === 1 ? "" : "s"} ` +
      `(${observations.basis}), ${trajectory.transitions.count} transition${
        trajectory.transitions.count === 1 ? "" : "s"
      }`,
  );

  if (!trajectory.available) {
    // Named, not implied: a one-snapshot history cannot show movement, and
    // every derived number below stays n/a rather than reading as a zero.
    sections.push(
      `✖ ${trajectory.unavailableReason}: a trajectory needs at least two observations — ` +
        "derived values are unavailable, not zero",
    );
  }

  const t = trajectory.transitions;
  sections.push(
    `signals  architecture ${t.architecture} · policy ${t.policy} · provider ${t.provider} · ` +
      `code drift ${t.codeDrift} · incomparable ${t.incomparable} · unchanged ${t.unchanged}`,
  );
  sections.push(`projects  ${formatAxis(trajectory.projects, true)}`);
  sections.push(`edges     ${formatAxis(trajectory.edges, false)}`);

  const d = trajectory.disclosures;
  sections.push(
    `disclosures  policy incomparable ${d.policyOneSided} · provenance incomparable ` +
      `${d.provenanceOneSided} · cross-repo ${d.crossRepo} · ` +
      `dirty captures ${observations.dirtyProvenance} · with provenance ${observations.withProvenance}`,
  );

  // The trend facts, from the SAME comparable transitions the signals line
  // counts. `null` prints as n/a — an insufficient or fully-incomparable
  // history never reads as zero change — and the basis line names exactly
  // what the counts are a claim about.
  if (trajectory.trends === null) {
    sections.push(
      trajectory.available
        ? "trends  n/a — no comparable transition classifications"
        : "trends  n/a",
    );
  } else {
    const byClass = trajectory.trends.byClass;
    sections.push(
      `trends  CHANGE ${byClass.CHANGE} · DRIFT ${byClass.DRIFT} · VIOLATION ${byClass.VIOLATION} · ` +
        `REPAIR ${byClass.REPAIR} · DECISION_CHANGE ${byClass.DECISION_CHANGE} · ` +
        `violations introduced ${trajectory.trends.violationsIntroduced} · resolved ` +
        `${trajectory.trends.violationsResolved}`,
    );
    sections.push(
      `trends basis  ${trajectory.trends.comparableTransitions} comparable transition${
        trajectory.trends.comparableTransitions === 1 ? "" : "s"
      } (${trajectory.trends.basis})`,
    );
    if (typeof trajectory.trends.note === "string" && trajectory.trends.note !== "") {
      sections.push(sanitize(trajectory.trends.note));
    }
  }

  for (const note of coverage.notes) {
    sections.push(sanitize(note));
  }

  return sections.join("\n");
}
