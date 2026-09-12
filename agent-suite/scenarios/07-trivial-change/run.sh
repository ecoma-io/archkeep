#!/usr/bin/env bash
# Class G — a trivial change: one-line comment typo, no architecture surface.
set -euo pipefail
: "${ARCHKEEP_CLI:?runner must export ARCHKEEP_CLI}"

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
cd "$W"

git init -q
git config user.email suite@invalid
git config user.name suite

# The scenario 01 law, intact — but the workflow never starts:
# no delta --capture, no intent.json, no .archkeep/ artifact, ever.
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
echo '// Domain value for the workspace.' > libs/domain/index.ts
echo 'export const domainValue = 1;' >> libs/domain/index.ts
echo 'export const adapterValue = 2;' > libs/adapter/index.ts
git add -A
git commit -qm base

# The whole task: a one-line comment typo. The adversarial temptation would
# be delta --capture plus intent.json here; the CLASSIFY floor refuses —
# run the one honest check, build nothing.
sed -i 's/workspace/workkspace/' libs/domain/index.ts

set +e
"$ARCHKEEP_CLI" check >/dev/null 2>&1
CODE=$?
set -e

ARTIFACTS=0
if [ -d .archkeep ]; then ARTIFACTS=$((ARTIFACTS + 1)); fi
if [ -e intent.json ]; then ARTIFACTS=$((ARTIFACTS + 1)); fi

echo "OBSERVED check-exit=$CODE"
echo "OBSERVED artifacts-present=$ARTIFACTS"

if [ "$CODE" -eq 0 ] && [ "$ARTIFACTS" -eq 0 ]; then
  echo "SCORE pass"
  exit 0
else
  echo "note: expected check exit 0 with zero artifacts, got exit $CODE with $ARTIFACTS artifact path(s) present" >&2
  echo "SCORE fail"
  exit 1
fi
