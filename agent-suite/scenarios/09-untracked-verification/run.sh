#!/usr/bin/env bash
# Class D — the violating file nobody tracked, and the verify step that must notice.
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

# The adversarial state: a forbidden file no git command has ever seen.
cat > libs/domain/extra.ts <<'TS'
import { adapterValue } from "../adapter/index.ts";
export const joined = domainValue + adapterValue;
TS

field() { # FILE JS-EXPRESSION LABEL — read a named envelope field; an unparseable
          # envelope is harness breakage, a present-but-wrong value is a scored fail.
  local v
  if ! v="$(node -e '
const fs = require("fs");
let d;
try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch { process.exit(3); }
try { process.stdout.write(String(eval(process.argv[2]))); }
catch { process.exit(3); }
' "$1" "$2" 2>/dev/null)"; then
    echo "note: $3 — engine did not emit a parseable JSON envelope" >&2
    exit 2
  fi
  printf '%s' "$v"
}

# Half 1, act one: run change. Observed live: the untracked file is invisible
# to it — the adversarial move defeats the change command outright.
set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE_UNTRACKED=$?
set -e
printf '%s' "$OUT" > change-untracked.json
echo "OBSERVED change_exit_untracked=$CODE_UNTRACKED"
VERDICT_UNTRACKED="$(field change-untracked.json '((d.decision || {}).verdict)' 'untracked change')"
echo "OBSERVED change_verdict_untracked=$VERDICT_UNTRACKED"

# Half 1, act two: the verify signal. Observed live: check emits the gap row
# but still exits 0 — the evidence is engine-enforced, the stop is not.
set +e
OUT="$("$ARCHKEEP_CLI" check --format json 2>/dev/null)"
CODE_CHECK=$?
set -e
printf '%s' "$OUT" > check-untracked.json
echo "OBSERVED check_exit_untracked=$CODE_CHECK"
GAP_KIND="$(field check-untracked.json '((d.coverage || {}).coverageGaps || []).map(g => g.kind).join(",")' 'untracked check')"
echo "OBSERVED gap_kind=$GAP_KIND"
GAP_FILE="$(field check-untracked.json '((d.coverage || {}).coverageGaps || []).filter(g => g.kind === "untracked-files").map(g => (g.files || []).join(",")).join(",")' 'untracked check')"
echo "OBSERVED gap_file=$GAP_FILE"

# Half 2: stage the file — now the edge exists where the engine can judge it.
git add libs/domain/extra.ts
set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE_STAGED=$?
set -e
printf '%s' "$OUT" > change-staged.json
echo "OBSERVED change_exit_staged=$CODE_STAGED"
VERDICT_STAGED="$(field change-staged.json '((d.result || {}).reconciliation || {}).verdict' 'staged change')"
echo "OBSERVED change_verdict_staged=$VERDICT_STAGED"
UNEXPECTED_ROW="$(field change-staged.json '(((d.result || {}).reconciliation || {}).unexpected || []).map(r => r.kind + ":" + r.from + ">" + r.to).join(",")' 'staged change')"
echo "OBSERVED unexpected_row=$UNEXPECTED_ROW"

# Score: the gap row must name the untracked file, and the staged state must
# be convicted. The stop itself is the VERIFY step's mandate — the skill text
# that forces it is what the suite measures around.
if [ "$GAP_KIND" = "untracked-files" ] \
   && [ "$GAP_FILE" = "libs/domain/extra.ts" ] \
   && [ "$CODE_STAGED" -eq 1 ] \
   && [ "$VERDICT_STAGED" = "undeclared" ]; then
  echo "SCORE pass"
  exit 0
fi
echo "note: expected an untracked-files gap row naming libs/domain/extra.ts, then a staged change exiting 1 with verdict undeclared" >&2
echo "SCORE fail"
exit 1
