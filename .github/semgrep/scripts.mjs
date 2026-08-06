// Fixtures for scripts.yaml, exercised by `semgrep --test --config
// .github/semgrep .github/semgrep`. Deliberately unsafe code: this file is
// excluded from every production scan (`--exclude .github/semgrep`) and from
// both rules' `paths: include:`, so nothing here runs or ships. It is also in
// `.prettierignore` — Prettier's inserted blank line would detach every
// annotation below from the case it belongs to.
//
// Each rule needs both halves. The `ruleid:` case proves the pattern still
// matches; without it a rule that quietly stopped matching passes every scan by
// finding nothing. The `ok:` case is a near-miss that must NOT be reported, so a
// rule cannot be widened into flagging the safe call the fix asks for.
import { execFileSync, spawnSync } from "node:child_process";

const packageDir = process.argv[2];

// ruleid: script-spawn-with-shell-true
spawnSync(packageDir, [], { shell: true });

// ruleid: script-spawn-with-shell-true
spawnSync("node", ["nx.js", "show", "project", packageDir], { shell: true, encoding: "utf8" });

// ok: script-spawn-with-shell-true
spawnSync("node", ["nx.js", "show", "project", packageDir], { encoding: "utf8" });

// ok: script-spawn-with-shell-true
execFileSync("git", ["ls-files", "--", packageDir], { encoding: "utf8" });

// ruleid: script-exec-command-built-from-a-value
execSync(`nx show project ${packageDir}`);

// ruleid: script-exec-command-built-from-a-value
exec("nx show project " + packageDir, () => {});

// A literal command with nothing interpolated still runs through a shell, but it
// carries no value that a package directory could have supplied — the rule is
// about the interpolation, so this must not be reported.
// ok: script-exec-command-built-from-a-value
execSync("git rev-parse --show-toplevel");

// The fix the message asks for. If this were reported, following the message
// would lead nowhere.
// ok: script-exec-command-built-from-a-value
execFileSync("nx", ["show", "project", packageDir], { encoding: "utf8" });
