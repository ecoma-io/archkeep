/**
 * The `report` command: one architecture governance document — how healthy the
 * architecture is, and **why** — assembled from the surfaces the other
 * commands already own.
 *
 * `health` answers the first half with numbers (`./health.mjs`). The second
 * half is spread across four other commands: which suppressions the boundary
 * law is carrying (`./waivers.mjs`), which declared quality gates hold
 * (`./fitness.mjs`), which recorded decision authorizes each governed row
 * (`./adr.mjs` and each row's `decisionRef`), and where this run's facts came
 * from (`./provenance.mjs`). A maintainer answering "is our architecture in
 * good shape, and on whose authority" had to run five commands and hold the
 * answer in their head. This command is that answer as one document.
 *
 * ## It composes; it never re-decides
 *
 * Every number and every verdict here is produced by the SAME function the
 * owning command calls — `healthCommand`, `waiversCommand`, `fitnessCommand`,
 * `readAdrContext`, `resolveDecisionRef`, `hasOrigin`, `resolveProvenance`.
 * There is no new scan, no second traversal, and no second copy of any
 * judgment, which is what makes it impossible for this document to disagree
 * with `health`, `waivers`, `fitness`, `adr` or `provenance` about the same
 * tree under the same law. (Under a DIFFERENT law it answers a different
 * question, which is what `--config` asks for: a `report --config other.mjs`
 * describes `other.mjs`'s world, exactly as `check --config other.mjs` judges
 * it.) The cost of composing whole commands is real and accepted: each one
 * resolves provenance for its own envelope, and `fitnessCommand` re-reads the
 * workspace's intent through `driftForCheck` rather than taking the copy this
 * command already holds — in a real run both come from the one tracked
 * `architecture-intent.json`, so they agree. The alternative — reaching past
 * these commands into their internals, or caching a result one of them
 * computed — is the disagreement this design exists to refuse.
 *
 * One law governs the whole document. `../../cli.mjs` resolves the boundary
 * policy once (`resolvePolicy`, so `--config` and a `profiles` registry work
 * exactly as they do for `check`) and hands the same object to every surface
 * below, so the report can never cite two different laws in one page.
 *
 * ## Descriptive, and what its status means
 *
 * `report` is descriptive: it never exits 1, because a description of how
 * healthy an architecture is is never itself a finding — `check` and `fitness`
 * are the only two verbs whose verdict carries that lane (`../../AGENTS.md`,
 * "What is a stub, and how each one says so"). A failing fitness gate or a
 * live boundary violation is therefore RENDERED, loudly and by name, over
 * exit 0; the commands that own those verdicts own their exit codes.
 *
 * What the status does mean is whether the document could be established:
 *
 * - `ok` (exit 0) — every surface reached a verdict.
 * - `no-verdict` (exit 3) — at least one did not, and `result.uninspectable`
 *   names every one of them with the reason. That list is the whole point:
 *   an empty result is a claim, not a shrug (`../../../../AGENTS.md`), so a
 *   metric the run could not measure, a waiver surface it could not read, a
 *   gate it could not determine, and a `decisionRef` that resolves to nothing
 *   all appear as named `unknown`s that hold the whole document back from
 *   claiming a verdict. **Nothing here is ever rendered as a clean zero over
 *   evidence the run could not inspect.**
 *
 * Three things deliberately do NOT hold the document back, because each is a
 * stated fact rather than an uninspected one:
 *
 * - a **`not_applicable`** surface (no boundary law, no declared fitness, no
 *   ADR registry) — the workspace declared none, and saying "could not look"
 *   about a thing that does not exist would be a false claim
 *   (`../governance/metrics.mjs` fixes that distinction for metrics; it holds
 *   the same way for a whole surface);
 * - **repo provenance that git cannot establish** — `resolveProvenance`
 *   returns `null` for "git absent, or not a repository", which is a
 *   legitimate no-origin claim the report prints as such, and which `adr` and
 *   `provenance` both already exit 0 over;
 * - an **unattested row** (no `origin` record) — a documentation finding
 *   `provenance` reports over exit 0, rendered here the same way.
 *
 * An unresolved `decisionRef` is the opposite case and is a `no-verdict` here:
 * a citation that names nothing is a governance claim nobody can check, and
 * reading it as a pass is exactly the silent direction.
 *
 * **This is stricter than `check`, deliberately, and the difference is worth
 * knowing.** `check` resolves the citations on BOTH tables — the intent rows
 * and the `depConstraints` rows — but folds only the intent half into its
 * no-verdict lane (`../../cli.mjs` skips a `depConstraints`-shaped row before
 * counting `intentUnresolvedDecisionRefs`), so a dangling citation on a
 * constraint row is rendered by the gate without failing the build. That is a
 * gate's call to make: it fails builds, and a documentation citation is not
 * a broken boundary. This document is the opposite instrument — its entire
 * subject is on whose authority each governed row stands — so it holds both
 * tables to the same standard and cannot claim a verdict over a citation it
 * could not resolve, wherever the row sits. It changes no exit code of
 * `check`'s, and the two never disagree about the FACT: both name the same
 * unresolved citation, through the same `resolveDecisionRef`.
 *
 * ## Determinism
 *
 * Text and JSON are byte-stable over an unchanged tree, an unchanged law and
 * the same reference instant. Rows keep their declaration order (the order the
 * workspace wrote them, which is semantic for a constraint table) or a
 * plain-`<` sort — never `localeCompare`. The one clock-dependent fact this
 * document carries is a waiver's `active`/`expired` status, which is a fact
 * about the deadline the workspace itself wrote and the same judgment `check`
 * makes; `remainingMs` — the millisecond countdown that genuinely differs
 * between two runs a second apart — is deliberately NOT carried here, and
 * `waivers` remains the surface that reports it (with its own disclosure).
 *
 * It does not print, and it does not decide the process's exit code —
 * `../../cli.mjs` owns those (`./README.md`).
 */
import { formatGovernanceReport } from "../report/report-text.mjs";
import { jsonEnvelope, renderJson } from "../report/json.mjs";
import { healthCommand } from "./health.mjs";
import { declaresFitness, fitnessCommand } from "./fitness.mjs";
import { waiversCommand } from "./waivers.mjs";
import { readAdrContext } from "./adr.mjs";
import { resolveProvenance } from "./provenance.mjs";
import {
  configRows,
  hasOrigin,
  intentRows,
  rowLabel,
  unresolvedDecisionRefNote,
} from "./provenance-command.mjs";
import {
  ADR_DIR,
  adrsBinding,
  declaredFitnessNames,
  resolveDecisionRef,
  stripAdrPrefix,
} from "../governance/adr-registry.mjs";
import { computeDecisionFitness } from "../governance/decision-fitness.mjs";
import { hasAuthority, stripRuleFitnessPrefix } from "../governance/adr-registry.mjs";

/**
 * The message a thrown refusal carries, as the report's reason for a surface
 * it could not establish.
 *
 * The catches that call this are deliberately broad, and that is the one
 * place a reader should push back, so: a composed command throws for exactly
 * two reasons — a workspace condition it refuses over (incomplete coverage, a
 * graph that cannot see the tree's edges, an unreadable registry), or a bug in
 * this package. Turning the first into a named `unknown` is the whole design;
 * the second lands there too, and still surfaces as a NON-ZERO exit with the
 * error's own message printed under `could not inspect`. Neither can produce
 * a clean-looking run, which is the property that matters — a `catch` that
 * swallows is the defect (`../../../../AGENTS.md`), and one that converts to
 * a named no-verdict is not one.
 *
 * Every refusal in this package throws an `Error`
 * whose message is already the sentence a user reads (`archkeep: …`), so the
 * report quotes it rather than inventing a second wording that could drift
 * from the command's own.
 *
 * @param {unknown} error
 * @returns {string}
 */
function refusalReason(error) {
  const message = /** @type {{message?: unknown}} */ (error)?.message;
  return typeof message === "string" && message.length > 0 ? message : String(error);
}

/**
 * Plain string comparison — never `localeCompare`, which depends on the locale
 * and the Node build's ICU data and would let two machines order the same rows
 * differently (the determinism rule every snapshot-state command shares).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byBytes(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The waiver surface, as the document carries it: the counts, and one row per
 * suppression with what it currently covers.
 *
 * `remainingMs` is dropped on purpose (see this module's header). `status` is
 * kept: it is the same active/expired judgment `check` makes about a deadline
 * the workspace wrote down, and an expired waiver silently re-asserting is
 * exactly what a maintainer reads this document for.
 *
 * @param {object} surface `waiversCommand`'s `waivers` result.
 * @returns {{waivers: number, covered: number, expired: number, stale: number,
 *   suppressions: number, suppressed: number}}
 */
function waiverCounts(surface) {
  return {
    waivers: surface.waivers.length,
    covered: surface.covered,
    expired: surface.expired,
    stale: surface.stale,
    suppressions: surface.suppressions.length,
    suppressed: surface.suppressed,
  };
}

/**
 * One rendered suppression row. Both halves of the table are carried — a
 * temporary waiver and a permanent suppression — because a permanent row
 * appears in no other report at all (`./waivers.mjs`'s header owns why).
 *
 * No `decisionRef` here, and that is a decision rather than an omission: a
 * suppression row has no such field — `../config.mjs`'s `SUPPRESSION_KEYS`
 * admits `path`, `messageId`, `reason`, `expiresAt` and `origin`, and a row
 * carrying anything else is refused at load. Rendering one anyway would print
 * a citation this document never resolved, next to rows whose citations it
 * did, and a reader would reasonably take the two for the same claim.
 *
 * @param {object} row
 * @param {"waiver"|"suppression"} kind
 * @returns {{kind: string, path: string, status: string, covered: number,
 *   reason: string|null, expiresAt: string|null}}
 */
function suppressionRow(row, kind) {
  return {
    kind,
    path: row.path,
    status: kind === "waiver" ? row.status : "permanent",
    covered: row.covered,
    reason: typeof row.reason === "string" ? row.reason : null,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
  };
}

/**
 * Runs the `report` command: composes health, waivers, fitness, the decision
 * registry and provenance into one document, and reports which evidence — if
 * any — it could not inspect.
 *
 * @param {object} commandContext From `resolveCommandContext`.
 * @param {{config?: object|null, intent?: object|null, trendDir?: string|null,
 *   policySource?: string|null, now?: string, readSnapshots?: Function}} [io]
 *   `config` is the ONE boundary law the whole document is written against
 *   (`../../cli.mjs`'s `resolvePolicy` resolved it, so `--config` and profiles
 *   apply), `intent` the loaded intent model or `null`, `trendDir` the
 *   snapshot directory for trends (the same directory `history` reads),
 *   `policySource` the workspace-relative name of the law that governed the
 *   run, and `now` the injectable clock the waiver judgment reads.
 * @returns {Promise<{status: "ok"|"no-verdict", result: object, coverage: object,
 *   report: {text: string, json: string}}>}
 * @throws {Error} on the conditions every command refuses out of — no
 *   workspace, a graph the provider could not build, a commitless repository —
 *   all exit-3 class, raised by the composed commands themselves.
 */
export async function reportCommand(commandContext, io = {}) {
  const { root, provider, marker, tracked } = commandContext;
  const config = io.config === undefined ? null : io.config;
  const intent = io.intent === undefined ? null : io.intent;

  /**
   * Every piece of evidence this run could not inspect, named. This list is
   * what decides the document's status, and a surface that lands here can
   * never also be rendered as a clean zero.
   *
   * @type {{surface: string, reason: string}[]}
   */
  const uninspectable = [];

  // ── Health ────────────────────────────────────────────────────────────
  // The metrics, verbatim from the command that owns them. Each `unknown`
  // metric is carried into `uninspectable` with the note the metric itself
  // wrote, so the document says WHICH number it could not establish rather
  // than only that one is missing.
  const health = healthCommand(commandContext, {
    config,
    intent,
    trendDir: io.trendDir ?? null,
    ...(io.readSnapshots ? { readSnapshots: io.readSnapshots } : {}),
  });
  for (const [key, metric] of Object.entries(health.metrics).sort(([a], [b]) => byBytes(a, b))) {
    if (metric.verdict === "unknown") {
      uninspectable.push({
        surface: `metric:${key}`,
        reason: metric.note ?? "the metric could not be measured over this run's evidence",
      });
    }
  }
  // A guard, not a check on the workspace: `health` decides its own status
  // from the same metrics walked above, so a `no-verdict` health with nothing
  // in `uninspectable` would mean this loop stopped seeing unknowns — and the
  // document would claim a verdict `health` refused. That is a bug in this
  // file, so it throws rather than degrades, the same posture `jsonEnvelope`
  // takes for the invariants it asserts (`../report/json.mjs`).
  if (health.status === "no-verdict" && uninspectable.length === 0) {
    throw new Error(
      "archkeep: report could not account for health's no-verdict — no metric was carried into " +
        "the uninspectable list. This is a bug in the report command, not a fact about the " +
        "workspace being judged.",
    );
  }

  // ── Waivers ───────────────────────────────────────────────────────────
  // The suppression table the law is carrying. No law, no table: that is
  // `not_applicable`, never an empty list that would read as "nothing is
  // waived". A refusal (incomplete coverage, a graph that cannot see the
  // workspace's edges) becomes a named unknown instead of a silent zero.
  /** @type {{verdict: string, note: string|null, counts: object|null, rows: object[]}} */
  let waivers = {
    verdict: "not_applicable",
    note: "no boundary law is declared, so there is no suppression table to read",
    counts: null,
    rows: [],
  };
  if (config !== null) {
    try {
      const surface = await waiversCommand(commandContext, config, {
        ...(io.now ? { now: io.now } : {}),
      });
      waivers = {
        verdict: "ok",
        note: null,
        counts: waiverCounts(surface.waivers),
        rows: [
          ...surface.waivers.waivers.map((row) => suppressionRow(row, "waiver")),
          ...surface.waivers.suppressions.map((row) => suppressionRow(row, "suppression")),
        ],
      };
    } catch (error) {
      const reason = refusalReason(error);
      waivers = { verdict: "unknown", note: reason, counts: null, rows: [] };
      uninspectable.push({ surface: "waivers", reason });
    }
  }

  // ── The decision registry ─────────────────────────────────────────────
  // Read first, because both the fitness section and the citation section
  // link into it. An unreadable registry is a named unknown for both — "could
  // not read the registry" must never read as "no ADRs" (`./adr.mjs`).
  /** @type {{records: object[], byId: Map<string, object>}|null} */
  let registry = null;
  /** @type {string|null} */
  let registryRefusal = null;
  try {
    registry = readAdrContext(root, { tracked });
  } catch (error) {
    registryRefusal = refusalReason(error);
    uninspectable.push({ surface: "decisions", reason: registryRefusal });
  }

  // ── Fitness gates ─────────────────────────────────────────────────────
  // Every declared quality gate, with its verdict and the ADR(s) that bind it
  // — `adrsBinding` is `adr`'s own reverse lookup, so the link this document
  // draws is the one that command would answer. A policy declaring no gates
  // is `not_applicable` (`declaresFitness` is the one predicate both this and
  // `fitnessCommand`'s own refusal read); an undetermined gate is an unknown
  // that holds the document back, the same lane `fitness` and `check` put it
  // in.
  /** @type {{verdict: string, note: string|null, functions: object[]}} */
  let fitness = {
    verdict: "not_applicable",
    note: "the boundary law declares no fitness functions",
    functions: [],
  };
  if (declaresFitness(config)) {
    try {
      const judged = await fitnessCommand(commandContext, { config });
      fitness = {
        verdict: judged.fitness.verdict,
        note: null,
        functions: judged.fitness.functions.map((decision) => ({
          name: decision.name,
          verdict: decision.verdict,
          message: typeof decision.message === "string" ? decision.message : null,
          // An unreadable registry cannot answer "which ADR binds this gate",
          // so the link is `null` — distinct from `[]`, which is the real
          // answer "no recorded decision binds it".
          adrs: registry === null ? null : adrsBinding(registry.records, decision.name),
        })),
      };
      for (const decision of judged.fitness.functions) {
        if (decision.verdict === "unknown") {
          uninspectable.push({
            surface: `fitness:${decision.name}`,
            reason:
              typeof decision.message === "string" && decision.message.length > 0
                ? decision.message
                : "the fitness function could not be determined",
          });
        }
      }
    } catch (error) {
      const reason = refusalReason(error);
      fitness = { verdict: "unknown", note: reason, functions: [] };
      uninspectable.push({ surface: "fitness", reason });
    }
  }

  // ── The governed rows: attestation and citation ───────────────────────
  // The same two row walks `provenance` makes, through the same two exported
  // helpers, so the two commands cannot come to disagree about which rows
  // exist. `intentRows` reads a normalized intent model; a workspace with no
  // intent file contributes none.
  const governanceRows = [...(intent === null ? [] : intentRows(intent)), ...configRows(config)];
  const unattested = governanceRows
    .filter(({ row }) => !hasOrigin(row))
    .map(({ kind, row }) => ({ kind, label: rowLabel(kind, row) }));

  // Each governed row that CITES a decision, and whether the citation
  // resolves. `resolveDecisionRef` is the one function that answers it, over
  // the registry index and — F04 — the fitness ids the executed policy
  // DECLARES, never the ADRs' own bindings, which would let a citation
  // resolve itself.
  const knownFitness = declaredFitnessNames(config);
  const citations = governanceRows
    .filter(({ row }) => typeof row?.decisionRef === "string" && row.decisionRef.trim() !== "")
    .map(({ kind, row }) => {
      const decisionRef = row.decisionRef;
      // A registry that could not be read cannot resolve anything: every
      // citation is `unknown` (already carried into `uninspectable` once, by
      // the registry refusal itself — naming each row again would report the
      // one failure N times).
      const resolution =
        registry === null
          ? "unknown"
          : resolveDecisionRef(registry.byId, knownFitness, decisionRef);
      const record =
        resolution === "adr" ? registry?.byId.get(stripAdrPrefix(decisionRef)) : undefined;
      return {
        kind,
        label: rowLabel(kind, row),
        decisionRef,
        resolution,
        adr: record === undefined ? null : { id: record.id, status: record.status },
      };
    });
  if (registry !== null) {
    for (const citation of citations) {
      if (citation.resolution === "unknown") {
        uninspectable.push({
          surface: `decisionRef:${citation.label}`,
          reason: unresolvedDecisionRefNote(citation.decisionRef),
        });
      }
    }
  }

  // The order of these three tests is load-bearing, and it is NOT the order
  // they were first written in. An unresolved citation is checked BEFORE the
  // empty-registry case: a workspace with no ADRs at all whose constraint row
  // cites `0009-missing` has a citation that resolved to nothing, and reading
  // that surface as `not_applicable` — "the workspace records no decisions
  // there" — would state a true sentence in place of the one that matters,
  // collapsing "nothing to measure" into "measured and could not resolve".
  // Those two must never read alike (`../report/report-text.mjs` renders both
  // and says the same).
  const unresolvedCitation = citations.some((citation) => citation.resolution === "unknown");
  // The per-record fitness derivation. It is the same function `adr` runs
  // over the same registry, folded here with THIS run's declared gates: the
  // verdicts of the `fitness` surface above (same `{name, verdict}` shape
  // `fitnessCommand` emits) are the ONLY door — a citation resolves against
  // declared ids (F04), and a record's own bound id must match one to be
  // verified. `computeDecisionFitness`'s second argument exists to carry
  // verdicts but is unused by design: the lookup is the single door, so it is
  // `null`, exactly as `adr` passes it. An empty verdict set is legitimate:
  // every authority record then derives `unverifiable` — the registry alone
  // asserts nothing, never a clean pass (the invariant).
  const fitnessById = new Map(
    computeDecisionFitness(registry === null ? [] : registry.records, null, (bindingId) => {
      const stripped = stripRuleFitnessPrefix(bindingId);
      const gate = fitness.functions.find((fn) => fn.name === stripped);
      return gate === undefined ? undefined : { name: gate.name, verdict: gate.verdict };
    }).map((entry) => [entry.id, entry]),
  );

  const decisions = {
    verdict:
      registry === null
        ? "unknown"
        : unresolvedCitation
          ? "unknown"
          : registry.records.length === 0
            ? "not_applicable"
            : "ok",
    note:
      registryRefusal ??
      (!unresolvedCitation && registry !== null && registry.records.length === 0
        ? `no ADRs in ${ADR_DIR}/ — the workspace records no decisions there`
        : null),
    registry: { dir: ADR_DIR, count: registry === null ? null : registry.records.length },
    records:
      registry === null
        ? []
        : registry.records.map((record) => ({
            id: record.id,
            status: record.status,
            authority: hasAuthority(record.status),
            bindings: [...record.bindings],
            // The per-decision fitness level from the derivation above. A
            // record binding nothing this run's gates declared derives
            // `unverifiable` — the registry alone asserts nothing.
            fitness: fitnessById.get(record.id),
            // The governed rows (intent + constraint) that CITATION this
            // record as their authority — the "who stands on this decision"
            // answer, filtered from the same citation walk above.
            constraints: citations
              .filter(
                (citation) =>
                  citation.resolution === "adr" &&
                  citation.adr !== null &&
                  citation.adr.id === record.id,
              )
              .map((citation) => ({ kind: citation.kind, label: citation.label })),
          })),
    citations,
    // The citations that could not be resolved — every one is already a
    // governed row that holds the document back (they feed `unresolvedCitation`
    // and `uninspectable` above); this materializes them for the text face so
    // a reader sees which rows, not only that one was missing.
    unresolvedDecisionRefs: citations
      .filter((citation) => citation.resolution === "unknown")
      .map((citation) => ({
        kind: citation.kind,
        label: citation.label,
        decisionRef: citation.decisionRef,
        reason: unresolvedDecisionRefNote(citation.decisionRef),
      })),
  };
  // ── Provenance ────────────────────────────────────────────────────────
  // Where this run's facts came from. `null` is git's honest "no origin
  // claim", printed as such and never folded into a commit this run cannot
  // name (`./provenance.mjs`).
  const repo = resolveProvenance(root);
  const provenance = {
    repo: repo ?? { commit: null, remote: null, dirty: null },
    established: repo !== null,
    policySource: io.policySource ?? null,
    rows: { total: governanceRows.length, unattested },
  };

  const status = uninspectable.length > 0 ? "no-verdict" : "ok";

  // The health coverage facts, plus this document's own disclosures. The two
  // `complete`/`notAnalyzed` fields ride through unchanged — `jsonEnvelope`
  // asserts they agree with each other and with an `ok` status, and this
  // document must never widen either claim.
  const coverage = {
    ...health.coverage,
    notes: [
      ...health.coverage.notes,
      "report composes health, waivers, fitness, the ADR registry and provenance through the " +
        "same functions those commands run; it performs no scan of its own and cannot disagree " +
        "with them about the same tree.",
      "a waiver's active/expired status is judged against this run's reference instant, the " +
        "same judgement `check` makes; remainingMs is not carried here — run `waivers` for it.",
      "the debt surface here is the per-run one (the boundary law's own deferred rows). The " +
        "ledger aged across snapshots is `debt`'s, which needs a snapshot directory.",
    ],
  };

  const result = {
    trendDir: io.trendDir ?? null,
    metrics: health.metrics,
    trends: health.trends,
    waivers,
    fitness,
    decisions,
    provenance,
    // Unconditional, like `provenance`'s own `unattested`: an empty array is
    // itself the claim "every surface was inspectable", never an omitted key
    // that would leave a reader unable to tell "checked, clean" from "never
    // checked" (`../../../../AGENTS.md`).
    uninspectable,
  };

  const envelope = jsonEnvelope({
    command: "report",
    context: { root, provider, marker, provenance: repo },
    status,
    exitCode: status === "ok" ? 0 : 3,
    coverage,
    result,
    // No `decision` field, deliberately. The envelope's decision must agree
    // with its status (`../report/json.mjs`), and this status is about whether
    // the document could be ESTABLISHED, not about whether the architecture is
    // healthy — so a report over a tree with live violations would carry
    // `verdict: "pass"`. That is the disagreement the envelope refuses,
    // arriving through the one field that is optional. `health` omits it for
    // the same reason.
  });

  return {
    status,
    result,
    coverage,
    report: {
      text: formatGovernanceReport({
        coverage,
        metrics: health.metrics,
        trends: health.trends,
        waivers,
        fitness,
        decisions,
        provenance,
        uninspectable,
        context: { root, provider, marker },
      }),
      json: renderJson(envelope),
    },
  };
}
