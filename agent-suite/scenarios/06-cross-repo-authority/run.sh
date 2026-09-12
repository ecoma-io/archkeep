#!/usr/bin/env bash
# A boundary verdict from another repo's law must be routed to the repo
# whose law produced it — never applied to this workspace. The engine's
# only measurable role here is the honest local result: this consumer
# workspace's own law judges its own tree clean (`check` exit 0), so a
# verdict "fixed" here would be a fabrication of this repo's law, not a
# finding. Must-catch step: CLASSIFY.
#
# The routing itself is skill behavior, and the runner asserts it from
# bindings.json (CLASSIFY-FOREIGN-VERDICT, REVIEW-FOREIGN-VERDICT-ROUTING)
# against the shipped skills/ tree before this script runs — the scenario
# stages only the local half it can measure. (#935: the previous version
# authored the routing prose it then grep'd for.)
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

# Gate — the honest local result: this workspace's law judges this
# workspace's tree, and finds nothing to fix. Everything above the local
# result — recognizing a foreign verdict, routing it — is the bound skill
# half, asserted from bindings.json by the runner.
if [ "$CHECK_CODE" -eq 0 ] && [ "$VERDICT" = "pass" ]; then
  echo "SCORE pass"
  exit 0
fi
echo "note: local check unexpectedly not clean (exit $CHECK_CODE, verdict $VERDICT) — the honest local result this scenario stages is exit 0 / pass" >&2
echo "SCORE fail"
exit 1