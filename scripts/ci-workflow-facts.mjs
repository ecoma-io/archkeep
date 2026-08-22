// Reads facts out of GitHub Actions workflow text, so tests can pin what CI
// depends on without restating it.
//
// The same rule `check-packages.mjs` states for its target list holds here:
// CI is where "green" is defined, and a second copy of anything a workflow
// already says would agree with the first only until someone edited one of
// them. Every function here takes the workflow TEXT as an argument and
// returns plain data — no file is opened and nothing is decided, so tests can
// feed synthetic fixtures and the drift pins in `ci-drift-pins.test.mjs` can
// feed the real files.
//
// These are line-based readers over the workflow YAML as this repository
// formats it (Prettier's two-space job indent, one expression per line), not
// a YAML parser. That is deliberate and bounded: every value a GitHub Actions
// workflow can put on its own line arrives on one line here, and a construct
// these functions cannot read makes itself known by yielding less than the
// callers require — which the pins treat as a failure, never as an empty
// pass. A folded (`>-`) multi-line value would be misread; none of the four
// workflows carries one outside a `run:` block, which no function here reads.

/**
 * A top-level job's structural facts.
 *
 * @typedef {object} WorkflowJob
 * @property {string} id the key under `jobs:`
 * @property {string[]} needs every job id the job names in `needs:` — scalar,
 *   flow sequence (`[a, b]`) and block sequence forms all read
 * @property {string | null} gateIf the JOB-level `if:` expression, or null
 *   when the job declares none. Step-level `if:` lines sit deeper than four
 *   spaces and are never captured here.
 */

/**
 * The jobs of a workflow, in declaration order.
 *
 * Job ids are the two-space-indented keys under the top-level `jobs:` mapping;
 * a zero-indent key ends the section. Whole-line comments are dropped first so
 * prose quoting a job id can never become one.
 *
 * @param {string} workflowText contents of a `.github/workflows/*.yml` file
 * @returns {WorkflowJob[]}
 */
export function parseJobs(workflowText) {
  const lines = workflowText.split("\n").filter((line) => !/^\s*#/.test(line));
  /** @type {WorkflowJob[]} */
  const jobs = [];
  let inJobs = false;
  /** @type {WorkflowJob | null} */
  let current = null;
  let readingBlockNeeds = false;

  for (const line of lines) {
    if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      current = null;
      readingBlockNeeds = false;
      continue;
    }
    if (!inJobs) continue;

    const jobId = /^ {2}([A-Za-z][\w-]*):\s*(?:#.*)?$/.exec(line);
    if (jobId) {
      current = { id: jobId[1], needs: [], gateIf: null };
      jobs.push(current);
      readingBlockNeeds = false;
      continue;
    }
    if (!current) continue;

    const needs = /^ {4}needs:(?:\s+(.*))?$/.exec(line);
    if (needs) {
      // A trailing `# …` comment is stripped before the value is read; YAML
      // needs a space before an inline comment, so the split cannot cut into
      // a job id.
      const inline = (needs[1] ?? "").replace(/\s+#.*$/, "").trim();
      current.needs =
        inline === ""
          ? []
          : inline
              .replace(/^\[/, "")
              .replace(/\]\s*$/, "")
              .split(/,\s*/);
      readingBlockNeeds = inline === "";
      continue;
    }
    if (readingBlockNeeds) {
      const item = /^ {6}-\s+(\S+)\s*$/.exec(line);
      if (item) {
        current.needs.push(item[1]);
        continue;
      }
      readingBlockNeeds = false;
    }

    // Exactly four spaces is the job-key indent; every step-level `if:` sits
    // deeper, inside that job's `steps:` list.
    const gateIf = /^ {4}if:\s*(.+?)\s*$/.exec(line);
    if (gateIf && current.gateIf === null) current.gateIf = gateIf[1];
  }
  return jobs;
}

/**
 * Every `uses:` reference in a workflow, with the line it was read from.
 *
 * The ref is the single token after `uses:` — `owner/repo@ref` for an action,
 * `docker://image@digest` for a container step — with any trailing `# version`
 * comment excluded because it was never part of the token. Local action refs
 * (`./.github/actions/...`) arrive here like any other; callers decide what
 * they accept.
 *
 * @param {string} workflowText contents of a `.github/workflows/*.yml` file
 * @returns {{ref: string, line: number}[]} in file order, 1-based line numbers
 */
export function parseActionRefs(workflowText) {
  return [...workflowText.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => ({
    ref: m[1],
    line: workflowText.slice(0, m.index).split("\n").length,
  }));
}

/**
 * Every container `image:` reference in a workflow, with its line.
 *
 * Reads the token after any `image:` key — today that is the Semgrep job's
 * `container.image`. A service or step-level image would be captured the same
 * way, which is the point: a caller pinning digests wants every image the run
 * would pull, whatever block named it.
 *
 * @param {string} workflowText contents of a `.github/workflows/*.yml` file
 * @returns {{image: string, line: number}[]} in file order, 1-based line numbers
 */
export function parseContainerImages(workflowText) {
  return [...workflowText.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => ({
    image: m[1],
    line: workflowText.slice(0, m.index).split("\n").length,
  }));
}
