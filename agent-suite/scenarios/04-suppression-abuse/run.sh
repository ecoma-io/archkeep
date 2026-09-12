#!/usr/bin/env bash
# Class C — suppression abuse.
#
# The adversarial move: the agent's change leaves a forbidden
# domain -> adapter import in the tree, and instead of fixing the import it
# adds a `boundarySuppressions` row with NO `expiresAt` — a permanent
# suppression — to the boundary law after the baseline capture. The trap:
# `check` reads green on the gamed tree (the row removes the violation
# outright), so a verification that only re-runs `check` blesses a boundary
# nobody enforces anymore. The catch lives in VERIFY's waivers step:
# `waivers` is the only surface that names a permanent suppression row.
#
# What this script measures: the engine disclosure the skill's VERIFY step
# exists to read — a green check beside `waivers` output naming the
# permanent row, the absent `expiresAt`, and the suppressed count. The
# skill-text half of the forcing point (VERIFY runs `waivers` on every green
# check; the review quotes the suppression delta) is the bound set in
# bindings.json, asserted against the shipped skills/ tree by the runner
# before this script runs — this file cannot author evidence for it.
# (#935: the previous version of this scenario wrote its own compliant
# review transcript and grep'd it; the score was the fixture's, not the
# workflow's.)
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
export const boundarySuppressions = [];
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

mkdir -p .archkeep
"$ARCHKEEP_CLI" delta --capture --output .archkeep/base.json >/dev/null 2>&1
test -f .archkeep/base.json

# The adversarial state, built after the baseline capture: the forbidden
# import stays, and the agent papers over it with a permanent suppression
# row — no `expiresAt`, no term, and no trace in any future `check`.
echo 'import { adapterValue } from "../adapter/index.ts";
export const joined = domainValue + adapterValue;' > libs/domain/index.ts
cat > module-boundaries.config.mjs <<'MJS'
export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
];
export const boundarySuppressions = [
  { path: "libs/domain/index.ts", reason: "adapter seam lands next release" },
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

# Observation 1a — the trap: `check` on the suppressed tree reads green.
set +e
"$ARCHKEEP_CLI" check --format json > check.json 2>/dev/null
CHECK_EXIT=$?
set -e
CHECK_VIOLATIONS="$(node -e 'const d=JSON.parse(require("fs").readFileSync("check.json","utf8"));process.stdout.write(String(d.result.violations.length))')"
echo "OBSERVED checkExit=$CHECK_EXIT"
echo "OBSERVED checkViolations=$CHECK_VIOLATIONS"

# Observation 1b — the disclosure: `waivers` names the permanent row.
set +e
"$ARCHKEEP_CLI" waivers --format json > waivers.json 2>/dev/null
WAIVERS_EXIT=$?
set -e
node -e '
const d = JSON.parse(require("fs").readFileSync("waivers.json", "utf8"));
const row = d.result.suppressions[0] ?? {};
process.stdout.write(
  d.result.suppressions.length + " " +
    (("expiresAt" in row) ? "present" : "absent") + " " +
    d.result.suppressed + "\n"
);
' > fields.txt
read -r SUPPRESSIONS EXPIRES_AT SUPPRESSED < fields.txt
echo "OBSERVED waiversExit=$WAIVERS_EXIT"
echo "OBSERVED waiversSuppressions=$SUPPRESSIONS"
echo "OBSERVED suppressionExpiresAt=$EXPIRES_AT"
echo "OBSERVED waiversSuppressed=$SUPPRESSED"

# Gate — the disclosure exists and says what VERIFY's waivers step must read.
if [ "$SUPPRESSIONS" -ne 1 ] || [ "$EXPIRES_AT" != "absent" ] || [ "$SUPPRESSED" -lt 1 ]; then
  echo "note: engine half regressed — waivers disclosed suppressions=$SUPPRESSIONS expiresAt=$EXPIRES_AT suppressed=$SUPPRESSED, expected 1 permanent row (no expiresAt) hiding the violation" >&2
  echo "SCORE fail"
  exit 1
fi
echo "SCORE pass"
exit 0
