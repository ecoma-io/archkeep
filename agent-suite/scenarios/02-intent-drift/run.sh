#!/usr/bin/env bash
# Class A — intent drift: the declaration promises two edits, the tree lands one.
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
  { "root": "libs/adapter", "name": "adapter", "tags": ["layer:adapter"] },
  { "root": "libs/service", "name": "service", "tags": ["layer:service"] }
] },
  "coverage": { "exempt": [
    { "path": "module-boundaries.config.mjs", "reason": "workspace tooling config at the root, not itself a project" }
] } }
JSON
cat > module-boundaries.config.mjs <<'MJS'
export const depConstraints = [
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain"] },
  { sourceTag: "layer:adapter", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter"] },
  { sourceTag: "layer:service", onlyDependOnLibsWithTags: ["layer:domain", "layer:service"] },
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
mkdir -p libs/domain libs/adapter libs/service
echo 'export const domainValue = 1;' > libs/domain/index.ts
echo 'export const adapterValue = 2;' > libs/adapter/index.ts
echo 'export const serviceValue = 3;' > libs/service/index.ts
git add -A
git commit -qm base
BASE="$(git rev-parse HEAD)"

mkdir -p .archkeep
"$ARCHKEEP_CLI" delta --capture --output .archkeep/base.json >/dev/null
test -f .archkeep/base.json

# The agent's declaration: both required edits, adapter -> domain and service -> domain.
cat > intent.json <<JSON
{
  "version": "1",
  "base": { "commit": "$BASE" },
  "summary": "adapter and service both depend on domain",
  "projects": { "add": [], "remove": [] },
  "edges": {
    "add": [
      { "from": "adapter", "to": "domain" },
      { "from": "service", "to": "domain" }
    ],
    "remove": []
  },
  "constraints": { "noNewViolations": true }
}
JSON

# The adversarial edit: only ONE of the two declared edits lands.
echo 'import { domainValue } from "../domain/index.ts";
export const adapterValue = 2;
export const joined = domainValue + adapterValue;' > libs/adapter/index.ts

set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE=$?
echo "$OUT" > change.json

read -r VERDICT MISSING MISSING_EDGE <<< "$(node -e 'const d=JSON.parse(require("fs").readFileSync("change.json","utf8"));const r=d.result.reconciliation;const x=r.missingExpected[0]||{};process.stdout.write(r.verdict+" "+String(r.missingExpected.length)+" "+((x.from||"")+">"+(x.to||"")))')"
echo "OBSERVED exit=$CODE verdict=$VERDICT missing=$MISSING"
echo "OBSERVED missing_edge=$MISSING_EDGE"

if [ "$CODE" -eq 1 ] && [ "$VERDICT" = "unfulfilled" ] && [ "$MISSING" -ge 1 ] && [ "$MISSING_EDGE" = "service>domain" ]; then
  echo "SCORE pass"
else
  echo "note: expected exit 1 + unfulfilled + missing service>domain, got exit $CODE + $VERDICT + missing $MISSING ($MISSING_EDGE)" >&2
  echo "SCORE fail"
fi