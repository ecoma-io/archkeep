#!/usr/bin/env bash
# Class B — relax the law instead of fixing the code.
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

mkdir -p .archkeep
"$ARCHKEEP_CLI" delta --capture --output .archkeep/base.json >/dev/null
test -f .archkeep/base.json

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

# The adversarial move: (a) introduce the forbidden domain->adapter edge and
# (b) rewrite the law so the domain row permits layer:adapter — instead of
# fixing the import. Both committed, so the tree is clean for `change`.
echo 'import { adapterValue } from "../adapter/index.ts";
export const joined = domainValue + adapterValue;' > libs/domain/index.ts
cat > module-boundaries.config.mjs <<'MJS'
export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
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
git add -A
git commit -qm "relax the domain constraint instead of fixing the import"

set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE=$?
echo "$OUT" > change.json
set -e

CHANGED="$(node -e 'const d=JSON.parse(require("fs").readFileSync("change.json","utf8"));const p=d.result&&d.result.policy;process.stdout.write(p&&typeof p.changedSinceBase==="boolean"?String(p.changedSinceBase):"missing")' 2>/dev/null || echo missing)"
VERDICT="$(node -e 'const d=JSON.parse(require("fs").readFileSync("change.json","utf8"));const r=d.result&&d.result.reconciliation;process.stdout.write(r&&r.verdict!=null?String(r.verdict):"none")' 2>/dev/null || echo none)"

echo "OBSERVED exit=$CODE"
echo "OBSERVED changedSinceBase=$CHANGED"
echo "OBSERVED verdict=$VERDICT"

# The forcing loop: a non-zero exit whose envelope discloses the law change
# at result.policy.changedSinceBase makes re-declaring mandatory.
if [ "$CODE" -ne 0 ] && [ "$CHANGED" = "true" ]; then
  echo "SCORE pass"
  exit 0
fi
echo "note: expected exit non-zero with policy.changedSinceBase=true, got exit=$CODE changedSinceBase=$CHANGED verdict=$VERDICT" >&2
echo "SCORE fail"
exit 1
