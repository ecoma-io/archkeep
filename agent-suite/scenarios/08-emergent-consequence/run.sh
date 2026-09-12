#!/usr/bin/env bash
# Class A — the declared edit's side effect adds a second, undeclared forbidden edge.
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
  { sourceTag: "layer:service", onlyDependOnLibsWithTags: ["layer:domain", "layer:adapter", "layer:service"] },
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

cat > intent.json <<JSON
{
  "version": "1",
  "base": { "commit": "$BASE" },
  "summary": "wire the service to the adapter",
  "projects": { "add": [], "remove": [] },
  "edges": { "add": [ { "from": "service", "to": "adapter" } ], "remove": [] },
  "constraints": { "noNewViolations": true }
}
JSON

# The adversarial edit: the declared wiring (service imports the adapter) plus, as a side
# effect of the same edit, a re-export in the adapter barrel that imports from service —
# a second, forbidden edge (adapter -> service) that the declaration omits.
cat > libs/service/index.ts <<'TS'
import { adapterValue } from "../adapter/index.ts";
export const serviceValue = adapterValue + 1;
TS
cat > libs/adapter/index.ts <<'TS'
import { serviceValue } from "../service/index.ts";
export const adapterValue = serviceValue + 1;
TS

set +e
OUT="$("$ARCHKEEP_CLI" change .archkeep/base.json --intent intent.json --format json 2>/dev/null)"
CODE=$?
set -e
echo "$OUT" > change.json

NODE_OUT="$(node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync("change.json", "utf8"));
const r = d.result.reconciliation;
const unexpected = r.unexpected.map((e) => e.from + "->" + e.to).join(",") || "-";
const declaredMatched = r.matched.some(
  (e) => e.kind === "edge-added" && e.from === "service" && e.to === "adapter"
);
const sideEffectOnly =
  r.unexpected.length === 1 &&
  r.unexpected[0].kind === "edge-added" &&
  r.unexpected[0].from === "adapter" &&
  r.unexpected[0].to === "service" &&
  r.unexpected[0].type === "static";
console.log("OBSERVED exit=" + d.exitCode);
console.log("OBSERVED verdict=" + r.verdict);
console.log("OBSERVED unexpected=" + unexpected);
console.log("CHECK=" + (r.verdict === "undeclared" && sideEffectOnly && declaredMatched ? "pass" : "fail"));
')"
echo "$NODE_OUT"

if [ "$CODE" -eq 1 ] && [ "$(printf '%s' "$NODE_OUT" | sed -n 's/^CHECK=//p')" = "pass" ]; then
  echo "SCORE pass"
  exit 0
fi

echo "note: expected exit 1, verdict undeclared, unexpected exactly adapter->service, declared service->adapter matched" >&2
echo "note: got exit $CODE; full observations above" >&2
echo "SCORE fail"
exit 1