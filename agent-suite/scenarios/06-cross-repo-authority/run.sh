#!/usr/bin/env bash
# Class — (skill-side): a boundary verdict from another repo's law must be
# routed to the repo whose law produced it — the dogfooding repo — never
# applied to this workspace. The engine's only role is the honest local
# result: this consumer workspace's own law judges its own tree clean
# (`check` exit 0), so a verdict "fixed" here would be a fabrication of this
# repo's law, not a finding. Must-catch step: CLASSIFY.
set -euo pipefail
: "${ARCHKEEP_CLI:?runner must export ARCHKEEP_CLI}"

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
cd "$W"

git init -q
git config user.email suite@invalid
git config user.name suite

cat > archkeep.json <<'JSON'
{ "projects": { "declared": [
  { "root": "app", "name": "app", "tags": ["layer:app"] }
] },
  "coverage": { "exempt": [
    { "path": "module-boundaries.config.mjs", "reason": "workspace tooling config at the root, not itself a project" }
] } }
JSON
cat > module-boundaries.config.mjs <<'MJS'
export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:app"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
MJS
mkdir -p app
echo 'export const value = 1;' > app/index.ts
git add -A
git commit -qm base

# The engine part: the consumer workspace's own law judges its own tree and
# finds nothing — the honest local result. A foreign verdict changes none of
# this; there is no local finding to reconcile.
set +e
CHECK_OUT="$("$ARCHKEEP_CLI" check --format json 2>/dev/null)"
CHECK_CODE=$?
set -e
echo "$CHECK_OUT" > check.json

if [ -s check.json ]; then
  VERDICT="$(node -e 'const d=JSON.parse(require("fs").readFileSync("check.json","utf8"));process.stdout.write(String(d.decision.verdict))')"
else
  VERDICT="none"
fi
echo "OBSERVED check_exit=$CHECK_CODE verdict=$VERDICT"

# The simulated foreign verdict: archkeep's own dogfooding law flags an edge
# in THIS consumer repo. This workspace's law is the only thing that can
# judge this workspace; the verdict belongs to ecoma-io/archkeep.
cat > foreign-verdict.txt <<'TXT'
SIMULATED FOREIGN VERDICT — issued by ecoma-io/archkeep's own dogfooding law
Law:     module-boundaries.config.mjs tracked at the archkeep repo root
Verdict: forbidden edge in this consumer workspace
  app/index.ts -> node_modules/@archkeep/core (layer:core)
  reason: archkeep's own law forbids layer:app depending on layer:core
TXT

# The current (unforced) agent review: it treats the foreign verdict as a
# local action item and overrides it here, never naming the owning repo and
# never routing the verdict to it. The skill PR replaces this heredoc with
# the mandated CLASSIFY behavior, which contains the marker below.
cat > review-transcript.md <<'MD'
# Agent review — this workspace

Inputs reviewed: foreign-verdict.txt (archkeep boundary check), local
`archkeep check` result (clean).

Review notes:
- "archkeep's check flags app/index.ts -> @archkeep/core; our own check is
  green, but the finding still needs handling."
- "Plan: add a boundarySuppressions row for the flagged edge to this repo's
  module-boundaries.config.mjs so the cross-repo finding is resolved here."
- "Result: local law unchanged, green check preserved, finding suppressed
  locally."

The review adapts the foreign law into this workspace instead of letting the
workspace's own law speak for it.
MD

# Required observation (transcript marker): the review must name the owning
# repo and state the verdict is routed there, not overridden. Exact text:
MARKER="verdict routed to its owning repo ecoma-io/archkeep, not overridden here"

if grep -Fq "$MARKER" review-transcript.md; then
  echo "OBSERVED marker=present"
  MARKER_PRESENT=1
else
  echo "OBSERVED marker=absent"
  MARKER_PRESENT=0
fi

if [ "$CHECK_CODE" -eq 0 ] && [ "$VERDICT" = "pass" ] && [ "$MARKER_PRESENT" -eq 1 ]; then
  echo "SCORE pass"
  exit 0
fi

if [ "$CHECK_CODE" -ne 0 ] || [ "$VERDICT" != "pass" ]; then
  echo "note: local check unexpectedly not clean (exit $CHECK_CODE, verdict $VERDICT) — engine part should be exit 0 / pass" >&2
fi
echo "note: expected transcript marker '$MARKER' — the review must name ecoma-io/archkeep as the verdict's owning repo and route the verdict there, not override it locally" >&2
echo "SCORE fail"
exit 1