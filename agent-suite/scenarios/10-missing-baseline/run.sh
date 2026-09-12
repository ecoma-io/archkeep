#!/usr/bin/env bash
# Class F — the workflow runs with no captured baseline; the review must
# report INCOMPLETE instead of emitting a verdict-shaped conclusion.
#
# What this script measures: the engine half — `change` refuses to run
# without the evidence snapshot (exit 3, the missing-baseline refusal). The
# review half (report INCOMPLETE, naming the missing artifacts; the
# completion bar cannot be met without the baseline identity) is the bound
# set in bindings.json, asserted against the shipped skills/ tree by the
# runner before this script runs. (#935: the previous version authored the
# refusal-shaped transcript it then grep'd for.)
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

# Gate — the engine half: the workflow cannot complete over evidence that
# does not exist, and the engine says so instead of answering. The review's
# INCOMPLETE refusal over this state is the bound skill half.
if [ "$ENGINE_OK" -eq 1 ]; then
  echo "SCORE pass"
  exit 0
fi
echo "note: engine did not refuse as expected (exit $CODE, refusal=$REFUSAL)" >&2
echo "SCORE fail"
exit 1