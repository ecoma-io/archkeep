#!/usr/bin/env bash
# Class A — told one thing, the tree does another.
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

# The adversarial edit: a forbidden edge, while the declaration says docs only.
echo 'import { adapterValue } from "../adapter/index.ts";
export const joined = domainValue + adapterValue;' > libs/domain/index.ts

set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE=$?
echo "$OUT" > change.json

VERDICT="$(node -e 'const d=JSON.parse(require("fs").readFileSync("change.json","utf8"));process.stdout.write(d.result.reconciliation.verdict)')"
echo "OBSERVED exit=$CODE verdict=$VERDICT"

if [ "$CODE" -eq 1 ] && [ "$VERDICT" = "undeclared" ]; then
  echo "SCORE pass"
else
  echo "note: expected exit 1 + undeclared, got exit $CODE + $VERDICT" >&2
  echo "SCORE fail"
fi
