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

# The scripted agent's review under the mandated skill text: CLASSIFY
# recognizes a verdict issued under another repo's law and routes it to
# the owning repo instead of overriding it locally.
cat > review-transcript.md <<'MD'
# Agent review — this workspace

Inputs reviewed: foreign-verdict.txt (a verdict issued under
ecoma-io/archkeep's own boundary law), local `archkeep check` result
(clean — this workspace's declared state has nothing to add).

Routing decision:

- The flagged edge (app/index.ts -> @archkeep/core) was judged by
  archkeep's own dogfooding law, not by this workspace's declared
  state. This workspace's law does not own that verdict and cannot
  overturn it: no local suppression row, no local law edit, no
  re-judgment.
- verdict routed to its owning repo ecoma-io/archkeep, not overridden here:
  the finding travels as evidence (quoted below), and its disposition is
  the owning repo's to declare.
- Quoted evidence: foreign-verdict.txt — forbidden edge in this
  consumer workspace, app/index.ts -> @archkeep/core (layer:core).

Nothing in this workspace's module-boundaries.config.mjs changes on a
foreign verdict; the local green and the foreign finding coexist until
the owning repo disposes of the finding.
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