/**
 * One document in, the diagnostics an editor should show for it out.
 *
 * ## The single invariant this module exists to hold
 *
 * **An empty diagnostic list must mean "no violation", and nothing else.**
 *
 * An editor draws no marker for a file whose diagnostics are `[]`, and a
 * developer reads no marker as "checked, clean". So every way this pipeline can
 * fail to reach a verdict has to end in a diagnostic instead of in an empty
 * list: a config that will not load, a workspace index that cannot be built, a
 * language whose analyzer does not exist yet, an analyzer that threw, a rule
 * engine that threw, a parse failure the analyzer recorded as data.
 *
 * The return type is what makes that checkable rather than merely intended.
 * `analyzed` is `true` on exactly ONE path — the one where the analyzer
 * returned, the rule engine returned, AND the tree they were compared against
 * was read whole — and the caller is expected to refuse to publish an empty
 * list unless it is `true`. Two guards for one invariant is deliberate: this
 * module makes the promise, and `./server.mjs` verifies it before the bytes
 * leave the process.
 *
 * ## The third way to reach a wrong verdict, which is not a failure at all
 *
 * The two guards above watch a pipeline that ran. They cannot see a pipeline
 * that ran correctly over the wrong tree: a `project.json` the index could not
 * read takes its project out of the graph, an import into it then resolves as
 * an external package, the rule engine's npm branch returns before any tag
 * check runs, and every function on the path returns normally with nothing to
 * report. `analyzed: true` would be an honest answer from a pipeline handed bad
 * input, and it would publish `[]` over a real violation. So the input is
 * checked too: `indexGaps` reports what the index could not read, and while it
 * reports anything this module does not call a document analyzed.
 *
 * ## The one empty-and-clean case, stated so it is not mistaken for a hole
 *
 * A file whose extension no analyzer claims — `README.md`, `project.json`, an
 * `.svg` — returns `analyzed: true` with no diagnostics. That is the analysis
 * contract's own answer ("an unknown extension is a no-op, not an error"), and
 * it is a real verdict: a file with no imports this tool can see crosses no
 * boundary. The same is true of a file inside no project, which the rule engine
 * places outside the boundary system entirely.
 */
import { analyzeFile } from "../analysis/analyze.mjs";
import { isExternalSiteFailure, projectOwning } from "../analysis/source-util.mjs";
import { declaredEdgeViolationsForCheck } from "../rules/edge-constraints.mjs";
import { evaluate } from "../rules/index.mjs";

import {
  analysisFailedDiagnostic,
  documentLines,
  failureDiagnostic,
  incompleteIndexDiagnostic,
  violationDiagnostic,
} from "./diagnostics.mjs";
import { indexGaps } from "./workspace-index.mjs";

/**
 * The diagnostics for one document, and whether a verdict was actually reached.
 *
 * @param {object} request
 * @param {string} request.sourceFile Workspace-relative path of the document.
 * @param {string} request.text Its current contents — the editor's buffer, not
 *   what is on disk. Diagnosing the saved file would answer a question nobody
 *   asked while the developer is looking at their unsaved edit.
 * @param {{workspace: object, graph: object, skippedProjects?: object[], fileFailures?: object[], importSites?: object[], duplicateProjects?: object[], nativeMarker?: boolean, nativeModelFailure?: string|null, moonModelFailure?: string|null, nxModelFailure?: string|null, workspaceLayoutFailure?: string|null}} request.index
 *   From `./workspace-index.mjs`. `importSites` is the whole tree's retained
 *   analysis output — the evidence half of the run below; absent (an index
 *   built before it existed) reads as none, which degrades evidence, never a
 *   verdict.
 * @param {{depConstraints: object[], options: object}} request.config
 * @returns {{analyzed: boolean, diagnostics: object[]}} `analyzed: false`
 *   always comes with at least one diagnostic.
 */
export function diagnoseDocument({ sourceFile, text, index, config }) {
  const lines = documentLines(text);

  // What the tree was missing when it was indexed. First in the list and first
  // in the function, because it qualifies every other line the document gets:
  // the rules below ran, and they ran against this.
  const gaps = indexGaps(index);
  const prelude = gaps.length === 0 ? [] : [incompleteIndexDiagnostic(gaps, lines)];
  const wholeTree = gaps.length === 0;

  let analysis;
  try {
    analysis = analyzeFile({ sourceFile, text, workspace: index.workspace });
  } catch (cause) {
    // The dispatcher throws for a language its extension table claims and no
    // analyzer implements. That is the scaffold staying loud, and it must stay
    // loud here too rather than becoming a green file.
    return {
      analyzed: false,
      diagnostics: [...prelude, analysisFailedDiagnostic(reasonOf(cause), lines)],
    };
  }

  // Recorded failures come next, and they are published whether or not the
  // rule pass below succeeds: they are the part of the file that was NOT
  // judged, and a reader needs that before they read what was. The external
  // class is not that part (`isExternalSiteFailure`): a bare coordinate that
  // resolves to the dependency universe was judged — resolved external,
  // disclosed in the run's blind-spot rows, excluded from the withholding
  // count — so a warning on it would say "not checked" about a site the
  // verdict below covers, and one per third-party import would be a wall of
  // warnings a reader rightly learns to ignore (#603). The workspace-surface
  // and whole-file classes keep publishing.
  const diagnostics = [
    ...prelude,
    ...analysis.failures
      .filter((failure) => !isExternalSiteFailure(failure))
      .map((failure) => failureDiagnostic(failure, lines)),
  ];

  // The engine derives its evidence index from exactly the records it is
  // handed (`../rules/index.mjs`'s `createContext`), so this run is handed
  // more than one document's worth: the whole tree's retained disk sites
  // (`./workspace-index.mjs` keeps them on the index for this) MINUS this
  // document's own — its stale disk copy, which the live buffer below replaces
  // — plus the fresh records for the buffer text. Evidence rules then cite the
  // same backing files `lattice check` cites: without the retained sites,
  // `noImportsOfLazyLoadedLibraries`' file list and `noCircularDependencies`'
  // per-hop lists came out empty in the editor whenever the backing import
  // lived in a file nobody had open, while `check` printed them — two faces of
  // one analysis disagreeing about the same tree.
  const combinedSites = [
    ...(index.importSites ?? []).filter((site) => site.sourceFile !== sourceFile),
    ...analysis.imports,
  ];
  // Computed once, before the run: a violation about a file that is neither
  // this document nor one of the files handed to the engine means the engine
  // and this caller disagree about which tree they are discussing (guarded
  // below). No caching beyond what the declared-edge fold further down already
  // does: `evaluate()` already ran once per diagnosis, and the added cost of
  // this change is exactly the larger array it now receives.
  const handedFiles = new Set(combinedSites.map((site) => site.sourceFile));

  let violations;
  try {
    violations = evaluate(combinedSites, index.graph, config);
  } catch (cause) {
    diagnostics.push(analysisFailedDiagnostic(reasonOf(cause), lines));
    return { analyzed: false, diagnostics };
  }

  for (const violation of violations) {
    if (violation.sourceFile === sourceFile) {
      diagnostics.push(violationDiagnostic(violation, lines));
      continue;
    }
    // A violation about another HANDED file belongs to that file's own
    // diagnosis and is dropped here — the engine judged every site it was
    // given, so foreign-file verdicts are expected output now. One naming a
    // file that was NOT handed over is different: no site produced it, so
    // engine and caller are discussing different trees, and the verdict for
    // this file cannot be trusted.
    if (!handedFiles.has(violation.sourceFile)) {
      diagnostics.push(
        analysisFailedDiagnostic(
          `the rule engine returned a violation for '${violation.sourceFile}' while judging ` +
            `'${sourceFile}'; the verdict for this file cannot be trusted`,
          lines,
        ),
      );
      return { analyzed: false, diagnostics };
    }
  }

  // The edges `evaluate()` structurally cannot reach. An `implicit` edge — an
  // Nx/`archkeep.json` `implicitDependencies` declaration — has no import site
  // behind it, so it never becomes an `importSites` record for the rule engine
  // to iterate. The CLI judges exactly those edges itself
  // (`../rules/edge-constraints.mjs`'s `declaredEdgeViolationsForCheck`,
  // `cli.mjs check`), and without the same fold here the editor would paint a
  // file clean while `check` exits 1 over the same declared edge — the
  // boundary rule that never runs, dressed as a clean tree. Only the violations
  // whose SOURCE project owns this document are reported: a declared edge names
  // a project, not a file, and the whole-file range below is the project-level
  // finding this file is the stand-in for.
  const sourceOwner = projectOwning(index.workspace?.projects ?? [], sourceFile)?.name;
  if (sourceOwner !== undefined) {
    // `declaredEdgeViolationsForCheck` rebuilds reachability and walks every
    // dependency list — an O(V+E) cost that would otherwise be paid on every
    // `didChange` keystroke of every open document. The index is revision-keyed
    // (a fresh object per rebuilt index), so a WeakMap on index identity is a
    // cache that is correct by construction — same index, same graph — and the
    // constraint table rides the same revision (`config` is rebuilt alongside
    // the index), so the pair `(index, depConstraints)` is stable until the
    // tree moves, then cold again.
    let entry = declaredEdgeViolationCache.get(index);
    if (entry === undefined || entry.depConstraints !== config.depConstraints) {
      entry = {
        depConstraints: config.depConstraints,
        violations: declaredEdgeViolationsForCheck(index.graph, config.depConstraints),
      };
      declaredEdgeViolationCache.set(index, entry);
    }
    for (const violation of entry.violations) {
      if (violation.source !== sourceOwner) continue;
      diagnostics.push(violationDiagnostic({ ...violation, line: null, column: null }, lines));
    }
  }

  return { analyzed: wholeTree, diagnostics };
}

/** One `declaredEdgeViolationsForCheck` computation per `(index, depConstraints)` pair. */
const declaredEdgeViolationCache = new WeakMap();

/** An Error's message, or whatever was thrown, as text a reader can act on. */
const reasonOf = (cause) => cause?.message ?? String(cause);
