/**
 * Putting the two verdicts side by side, and naming the direction of every
 * disagreement.
 *
 * Three outcomes per reported violation, and they are not symmetric:
 *
 * - **agree** — both engines report the same `messageId` at the same site.
 * - **this-tool-stricter** — this engine reports where ESLint is silent. A
 *   DECISION, legitimate only when the case declares it and says why; never
 *   tolerated silently.
 * - **this-tool-weaker** — ESLint reports where this engine is silent. A
 *   DEFECT, always. It is the false negative the whole tool exists to remove:
 *   a green light nobody can trust is worse than the silence this replaces,
 *   because silence about Go, Rust and Python is at least known.
 *
 * ## What "the same site" means
 *
 * ESLint reports the whole statement — `import { a } from "@x/y";` starts at
 * column 1 — while this engine reports the SPECIFIER, because an editor
 * diagnostic should underline the string that is wrong. Comparing columns for
 * equality would therefore mark every single pair as a disagreement about
 * nothing. Instead a pair matches when this engine's position falls INSIDE the
 * range ESLint reported, which is the strongest statement that survives the
 * difference: same file, same statement, same rule. A violation this engine
 * reports at a different statement stays unmatched, and so surfaces as one
 * stricter plus one weaker rather than being quietly absorbed.
 *
 * ## The axis that does not need ESLint at all
 *
 * Everything above is a diff, and a diff needs a counterparty. ESLint has no
 * parser for `.go`, `.rs` or `.py`, so `weaker` is EMPTY BY CONSTRUCTION for
 * those three — not measured and found to be zero, but unmeasurable. What is
 * left for them is each probe's hand-written `tool: [...]`, which can only
 * catch a regression on a fixture shape somebody already thought to write.
 *
 * So a second axis, which compares this engine against ITSELF:
 * **`spelling`**. Probes carrying the same `spelling` key write one and the
 * same import in different ways — `use a::b;` and `use a::{b};`, a package at
 * `src/pkg` and the same package under a declared `package-dir` — and the
 * suite requires them to produce the identical verdict. No expectation has to
 * be right for that to bite: a spelling the analyzer silently drops disagrees
 * with its siblings even when someone wrote the wrong `tool: [...]` down for
 * it and the declaration check went green.
 *
 * `measuredScope` is the same honesty applied to the diff itself — which
 * probes upstream could read at all, as data, so "zero weaker rows" can be
 * read as the JS/TS/Vue measurement it is.
 */

/** Is `(line, column)` inside the `[start, end)` range of an ESLint message? */
function withinRange(message, line, column) {
  const endLine = message.endLine ?? message.line;
  const endColumn = message.endColumn ?? message.column + 1;
  const afterStart = line > message.line || (line === message.line && column >= message.column);
  const beforeEnd = line < endLine || (line === endLine && column < endColumn);
  return afterStart && beforeEnd;
}

/** A short, stable description of where a violation sits, for a report line. */
const siteOf = (file, line, column) => `${file}:${line}:${column}`;

/**
 * Pairs one file's two verdicts.
 *
 * @param {string} file Workspace-relative.
 * @param {{readable: boolean, messages: object[], notes: string[]}} upstream
 * @param {object[]} tool Violations from `evaluate`, already filtered to `file`.
 * @returns {{agree: object[], stricter: object[], weaker: object[]}}
 */
export function compareFile(file, upstream, tool) {
  const remaining = [...tool];
  const agree = [];
  const weaker = [];

  for (const message of upstream.messages) {
    const index = remaining.findIndex(
      (violation) =>
        violation.messageId === message.messageId &&
        withinRange(message, violation.line, violation.column),
    );
    if (index === -1) {
      weaker.push({
        messageId: message.messageId,
        site: siteOf(file, message.line, message.column),
        detail: message.message,
      });
      continue;
    }
    const [violation] = remaining.splice(index, 1);
    agree.push({
      messageId: message.messageId,
      site: siteOf(file, violation.line, violation.column),
      sameText: violation.message === message.message,
    });
  }

  const stricter = remaining.map((violation) => ({
    messageId: violation.messageId,
    site: siteOf(file, violation.line, violation.column),
    upstreamReadable: upstream.readable,
    detail: violation.message,
  }));
  return { agree, stricter, weaker };
}

/**
 * Compares a whole case and checks it against what it CLAIMED, which is the
 * half that keeps the suite honest.
 *
 * A differential where both engines stay silent "agrees" and proves nothing —
 * it is what a fixture that stopped triggering its rule looks like. So every
 * probe declares the message ids upstream must report (`upstream`) and, when
 * the two are meant to differ, the ids this engine must report (`tool`) plus
 * the reason. A claim that no longer matches reality is a failure of the same
 * weight as a disagreement.
 *
 * @returns {{rows: object[], breaches: string[]}} `breaches` is empty when the
 *   case behaved as declared; each entry names exactly what did not.
 */
export function compareCase(materialized, upstreamByFile, toolViolations) {
  const { spec } = materialized;
  const rows = [];
  const breaches = [];

  for (const probe of spec.probes) {
    const file = `${spec.id}/${probe.file}`;
    const upstream = upstreamByFile.get(file) ?? { readable: false, messages: [], notes: [] };
    const tool = toolViolations.filter((violation) => violation.sourceFile === file);
    const comparison = compareFile(file, upstream, tool);

    const actualUpstream = upstream.messages.map((message) => message.messageId).sort();
    const actualTool = tool.map((violation) => violation.messageId).sort();
    const claimedUpstream = [...(probe.upstream ?? [])].sort();
    const claimedTool = [...(probe.tool ?? probe.upstream ?? [])].sort();

    if (upstream.notes.length > 0) {
      breaches.push(
        `${spec.id} / ${probe.file}: ESLint reported something other than the boundary rule — ` +
          `${upstream.notes.join("; ")}. The fixture does not parse, so its verdict means nothing.`,
      );
    }
    if (JSON.stringify(actualUpstream) !== JSON.stringify(claimedUpstream)) {
      breaches.push(
        `${spec.id} / ${probe.file}: ESLint reported [${actualUpstream.join(", ") || "nothing"}], ` +
          `the case claims [${claimedUpstream.join(", ") || "nothing"}]. The fixture no longer ` +
          `triggers what it was built to trigger, so any agreement it shows is vacuous.`,
      );
    }
    if (JSON.stringify(actualTool) !== JSON.stringify(claimedTool)) {
      breaches.push(
        `${spec.id} / ${probe.file}: this engine reported [${actualTool.join(", ") || "nothing"}], ` +
          `the case claims [${claimedTool.join(", ") || "nothing"}].`,
      );
    }
    if (probe.tool && !probe.divergence) {
      breaches.push(
        `${spec.id} / ${probe.file}: declares a verdict of its own without a 'divergence' reason. ` +
          `A deliberate difference from ESLint is a decision and must be stated, never assumed.`,
      );
    }
    // A false negative is never a decision, so it is never simply "declared and
    // fine". A case may only RECORD one it has found, and then the suite holds
    // the record to the observed reality from both sides: a new one that is not
    // in the ledger fails here, and one the ledger names that has since been
    // fixed fails the ledger check. Neither direction can rot quietly.
    const ledgered = probe.divergence?.direction === "weaker";
    for (const weak of comparison.weaker) {
      if (ledgered) continue;
      breaches.push(
        `${spec.id} / ${probe.file}: FALSE NEGATIVE — ESLint reports ` +
          `${weak.messageId} at ${weak.site} and this engine does not.`,
      );
    }
    if (ledgered && comparison.weaker.length === 0) {
      breaches.push(
        `${spec.id} / ${probe.file}: records a false negative that no longer happens. ` +
          `Delete the ledger entry — a ledger of defects that are fixed is a ledger nobody rereads.`,
      );
    }

    rows.push({
      caseId: spec.id,
      file,
      intent: spec.intent,
      divergence: probe.divergence ?? null,
      probeUpstream: probe.upstream ?? [],
      upstreamReadable: upstream.readable,
      // The group of probes writing one import several ways, or null. The
      // spelling axis is decided on these two fields alone, never on what the
      // probe CLAIMED — a claim is exactly what it must be able to outlive.
      spelling: probe.spelling ?? null,
      reported: { upstream: actualUpstream, tool: actualTool },
      ...comparison,
    });
  }
  return { rows, breaches };
}

/** The probes of each `caseId / spelling` group, keyed by that pair. */
export function spellingGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.spelling) continue;
    const key = `${row.caseId} / ${row.spelling}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/** What one probe's two engines actually said, as one comparable string. */
const verdictText = (row) =>
  `upstream [${row.reported.upstream.join(", ") || "nothing"}], this engine [${
    row.reported.tool.join(", ") || "nothing"
  }]`;

/**
 * Every spelling group whose members did not all reach the same verdict.
 *
 * A group of one is reported too. It asserts nothing — one spelling cannot
 * disagree with itself — and a group that lost its siblings to an edit is
 * exactly the silent way this axis would stop working.
 *
 * @param {object[]} rows From `compareCase`.
 * @returns {string[]} One line per group that failed, empty when all agree.
 */
export function spellingDisagreements(rows) {
  const lines = [];
  for (const [key, members] of spellingGroups(rows)) {
    if (members.length < 2) {
      lines.push(
        `${key}: only one probe writes this import, so nothing is compared. A spelling group ` +
          `needs at least two spellings to say anything.`,
      );
      continue;
    }
    const first = verdictText(members[0]);
    if (members.every((row) => verdictText(row) === first)) continue;
    lines.push(
      `${key}: one import, different verdicts depending on how it is written — ` +
        members.map((row) => `${row.file} → ${verdictText(row)}`).join("; "),
    );
  }
  return lines;
}

/**
 * What the differential actually measured, as data rather than as prose.
 *
 * `weaker` can only ever be non-zero where upstream could parse the file, so a
 * reader deciding what "zero weaker rows" covers needs the readable/unreadable
 * split beside the number. Emitting it here — rather than describing it in a
 * document beside the run — is what stops the scope and the figure from
 * drifting apart.
 *
 * @param {object[]} rows From `compareCase`.
 */
export function measuredScope(rows) {
  const extensionOf = (file) => file.slice(file.lastIndexOf("."));
  const comparableExtensions = new Set();
  const incomparableExtensions = new Set();
  let comparable = 0;
  for (const row of rows) {
    if (row.upstreamReadable) {
      comparable++;
      comparableExtensions.add(extensionOf(row.file));
    } else {
      incomparableExtensions.add(extensionOf(row.file));
    }
  }
  return {
    probes: rows.length,
    comparable,
    incomparable: rows.length - comparable,
    comparableExtensions: [...comparableExtensions].sort(),
    incomparableExtensions: [...incomparableExtensions].sort(),
    spellingGroups: spellingGroups(rows).size,
  };
}

/**
 * Every outcome for one messageId, across every case that produced it.
 *
 * `comparable` counts the hits upstream could have contradicted — the ones on
 * a file it can parse. Where it is 0 the `weaker` column beside it is 0 by
 * construction and says nothing about this engine (see `measuredScope`).
 */
function tallyFor(rows, messageId) {
  const tally = {
    agree: 0,
    stricter: 0,
    weaker: 0,
    comparable: 0,
    cases: new Set(),
    notes: new Set(),
  };
  for (const row of rows) {
    const count = (hit) => {
      if (hit.messageId !== messageId) return false;
      tally.cases.add(row.caseId);
      if (row.upstreamReadable) tally.comparable++;
      return true;
    };
    for (const hit of row.agree) {
      if (count(hit)) tally.agree++;
    }
    for (const hit of row.stricter) {
      if (!count(hit)) continue;
      tally.stricter++;
      tally.notes.add(
        hit.upstreamReadable
          ? (row.divergence?.reason ?? "undeclared")
          : "upstream cannot parse the language",
      );
    }
    for (const hit of row.weaker) {
      if (count(hit)) tally.weaker++;
    }
  }
  return tally;
}

/**
 * The per-message differential table, as data.
 *
 * Driven by the id list read off the INSTALLED rule, so a message this engine
 * has never heard of appears as a row rather than being absent from a table
 * that then looks complete (an empty result is a claim, not a shrug).
 *
 * @param {object[]} rows From `compareCase`.
 * @param {readonly string[]} upstreamMessageIds Every id upstream defines.
 * @param {readonly string[]} toolMessageIds Every id this engine can produce.
 */
export function summarize(rows, upstreamMessageIds, toolMessageIds) {
  const implemented = new Set(toolMessageIds);
  return upstreamMessageIds.map((messageId) => {
    const tally = tallyFor(rows, messageId);
    return {
      messageId,
      implemented: implemented.has(messageId),
      agree: tally.agree,
      stricter: tally.stricter,
      weaker: tally.weaker,
      comparable: tally.comparable,
      exercised: tally.agree + tally.stricter + tally.weaker > 0,
      cases: [...tally.cases].sort(),
      notes: [...tally.notes].sort(),
    };
  });
}

/**
 * The summary as a fixed-width table, for a terminal and for a report.
 *
 * `comparable` sits beside `weaker` deliberately: a 0 in the weaker column is
 * a measurement only where the number to its left is not also 0.
 */
export function renderTable(summary) {
  const header = ["messageId", "agree", "stricter", "weaker", "comparable", "verdict"];
  const body = summary.map((row) => [
    row.messageId,
    String(row.agree),
    String(row.stricter),
    String(row.weaker),
    String(row.comparable),
    verdictOf(row),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...body.map((row) => row[column].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join(
    "\n",
  );
}

/**
 * Every disagreement, one line each, with its direction and its reason — the
 * raw material `README.md`'s ledger is written from, emitted by the run rather
 * than maintained beside it.
 */
export function renderDivergences(rows) {
  const lines = [];
  for (const row of rows) {
    for (const hit of row.weaker) {
      lines.push(
        `weaker    ${hit.messageId}  ${row.file}\n            ${row.divergence?.reason ?? "UNDECLARED"}`,
      );
    }
    for (const hit of row.stricter) {
      const reason = row.upstreamReadable
        ? (row.divergence?.reason ?? "UNDECLARED")
        : "ESLint has no parser for this language";
      lines.push(`stricter  ${hit.messageId}  ${hit.site}\n            ${reason}`);
    }
  }
  return lines.join("\n");
}

/** Pairs whose rendered message text differs, which is a report-quality note rather than a verdict. */
export function renderTextDifferences(rows) {
  return rows
    .flatMap((row) =>
      row.agree.filter((hit) => !hit.sameText).map((hit) => `${hit.messageId}  ${hit.site}`),
    )
    .join("\n");
}

/** One word for a row, so a reader does not have to do the arithmetic. */
export function verdictOf(row) {
  if (!row.implemented) return "UNIMPLEMENTED";
  if (!row.exercised) return "NOT EXERCISED";
  if (row.weaker > 0) return "WEAKER — DEFECT";
  if (row.stricter > 0 && row.agree > 0) return "agree + stricter";
  if (row.stricter > 0) return "stricter only";
  return "agree";
}
