#!/usr/bin/env bash
# Class F — the workflow runs with no captured baseline; the review must
# report INCOMPLETE instead of emitting a verdict-shaped conclusion.
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
  { "root": "libs/domain", "name": "domain", "tags": ["layer:domain"] },
  { "root": "libs/adapter", "name": "adapter", "tags": ["layer:adapter"] }
] },
  "coverage": { "exempt": [
    { "path": "module-boundaries.config.mjs", "reason": "workspace tooling config at the root, not itself a project" }
] } }
JSON
cat > module-boundaries.config.mjs <<'MJS'
export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
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
mkdir -p libs/domain libs/adapter
echo 'export const domainValue = 1;' > libs/domain/index.ts
echo 'export const adapterValue = 2;' > libs/adapter/index.ts
git add -A
git commit -qm base
BASE="$(git rev-parse HEAD)"

# The adversarial state: the workflow's baseline was never captured.
mkdir -p .archkeep
test ! -e .archkeep/base.json

cat > intent.json <<JSON
{
  "version": "1",
  "base": { "commit": "$BASE" },
  "summary": "docs only",
  "projects": { "add": [], "remove": [] },
  "edges": { "add": [], "remove": [] },
  "constraints": { "noNewViolations": true }
}
JSON

# Engine half: change refuses to run without the evidence snapshot.
set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>&1)"
CODE=$?
set -e

REFUSAL="unexpected"
case "$OUT" in
  *"cannot read the evidence snapshot"*".archkeep/base.json"*)
    REFUSAL="missing-baseline-snapshot" ;;
esac
if [ "$CODE" -ne 0 ] && [ "$REFUSAL" = "missing-baseline-snapshot" ]; then
  ENGINE_OK=1
else
  ENGINE_OK=0
fi
echo "OBSERVED engine_exit=$CODE"
echo "OBSERVED engine_refusal=$REFUSAL"

# Marker half: the scripted agent's review transcript under the mandated
# skill text — the skip clause inverted. The missing baseline artifact
# meets the INCOMPLETE refusal shape, and no verdict-shaped completion is
# emitted over unreconciled evidence.
cat > review-transcript.md <<TRANSCRIPT
# Review transcript — change run without a captured baseline

Agent review of the change run on repo at commit $BASE:

1. Ran the change command with a well-formed intent: archkeep change
   .archkeep/base.json --intent intent.json --format json.
2. The command exited 3 and refused: cannot read the evidence snapshot
   .archkeep/base.json (ENOENT); stdout carried no JSON envelope.
3. The completion bar requires quoting the baseline identity, the change
   verdict, and the event artifact path. The baseline artifact does not
   exist, so the bar cannot be met — this is the refusal shape, not a
   judgment call: a review over unreconciled evidence does not complete,
   whatever the diff looks like.

Review status: INCOMPLETE — required artifact .archkeep/base.json is missing; no verdict emitted.
Re-run after capturing the baseline (`delta --capture --output
.archkeep/base.json` on a clean, committed tree), then reconcile before
any review is attempted again.
TRANSCRIPT

if grep -q 'INCOMPLETE.*\.archkeep/base\.json.*no verdict emitted' review-transcript.md; then
  MARKER=yes
else
  MARKER=no
fi
echo "OBSERVED marker=$MARKER"

if [ "$ENGINE_OK" -eq 1 ] && [ "$MARKER" = "yes" ]; then
  echo "SCORE pass"
  exit 0
fi

if [ "$MARKER" = "no" ]; then
  echo "note: transcript lacks the required marker (review states INCOMPLETE and names the missing .archkeep/base.json instead of emitting a verdict); the skill-text PR must flip the heredoc transcript to that refusal shape" >&2
fi
if [ "$ENGINE_OK" -eq 0 ]; then
  echo "note: engine did not refuse as expected (exit $CODE, refusal=$REFUSAL)" >&2
fi
echo "SCORE fail"
exit 1