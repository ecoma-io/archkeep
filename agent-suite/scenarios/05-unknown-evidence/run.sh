#!/usr/bin/env bash
# Class E — evidence the analyzer cannot read: a tracked file goes dark.
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

# The adversarial move: after the baseline is captured, a tracked source file
# becomes unreadable. Coverage is now unknowable, so any verdict — clean or
# otherwise — would be a claim over evidence the analyzer never saw.
chmod 000 libs/domain/index.ts

set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE=$?
echo "$OUT" > change.json
set -e
read -r STATUS VERDICT NOTANALYZED DARKFILE < <(node -e '
try {
  const d = JSON.parse(require("fs").readFileSync("change.json", "utf8"));
  const rows = (d.coverage && d.coverage.notAnalyzed) || [];
  console.log([
    d.status || "<none>",
    (d.decision && d.decision.verdict) || "<none>",
    rows.length,
    rows.length > 0 ? rows[0].file : "-"
  ].join(" "));
} catch {
  console.log("<unparseable> <unparseable> 0 -");
}
')

echo "OBSERVED exit=$CODE status=$STATUS verdict=$VERDICT notAnalyzed=$NOTANALYZED unreadable=$DARKFILE"

if [ "$CODE" -eq 3 ] && [ "$STATUS" = "no-verdict" ] && [ "$VERDICT" = "unknown" ] && [ "$NOTANALYZED" -ge 1 ] && [ "$DARKFILE" = "libs/domain/index.ts" ]; then
  echo "SCORE pass"
else
  echo "note: expected exit 3 no-verdict with the unreadable tracked file in coverage.notAnalyzed, got exit $CODE, status=$STATUS, verdict=$VERDICT, notAnalyzed=$NOTANALYZED ($DARKFILE)" >&2
  echo "SCORE fail"
fi
