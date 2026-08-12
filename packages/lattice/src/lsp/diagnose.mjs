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
 * @param {{workspace: object, graph: object, skippedProjects?: object[], fileFailures?: object[], nativeMarker?: boolean, nativeModelFailure?: string|null}} request.index
 *   From `./workspace-index.mjs`.
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
  // judged, and a reader needs that before they read what was.
  const diagnostics = [
    ...prelude,
    ...analysis.failures.map((failure) => failureDiagnostic(failure, lines)),
  ];

  let violations;
  try {
    violations = evaluate(analysis.imports, index.graph, config);
  } catch (cause) {
    diagnostics.push(analysisFailedDiagnostic(reasonOf(cause), lines));
    return { analyzed: false, diagnostics };
  }

  for (const violation of violations) {
    // The engine is handed only this document's import sites, so every
    // violation it returns is already about this document. Filtering again
    // would hide a bug rather than prevent one, so the assertion is the shape:
    // anything else here means the engine and this caller disagree about which
    // file they are discussing.
    if (violation.sourceFile !== sourceFile) {
      diagnostics.push(
        analysisFailedDiagnostic(
          `the rule engine returned a violation for '${violation.sourceFile}' while judging ` +
            `'${sourceFile}'; the verdict for this file cannot be trusted`,
          lines,
        ),
      );
      return { analyzed: false, diagnostics };
    }
    diagnostics.push(violationDiagnostic(violation, lines));
  }

  return { analyzed: wholeTree, diagnostics };
}

/** An Error's message, or whatever was thrown, as text a reader can act on. */
const reasonOf = (cause) => cause?.message ?? String(cause);
