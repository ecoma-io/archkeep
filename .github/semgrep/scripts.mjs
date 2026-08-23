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
//
// The `ruleid:` roster below is a roster of SPELLINGS, not of examples. Node's
// signature is `spawn(command[, args][, options])` and `execFile(file[, args]
// [, options][, callback])`, so the options object is not pinned to the third
// position; `shell` takes a string as readily as `true`; and a command can be
// assembled into a variable a line before the call that runs it. Every one of
// those was a live hole here — five of the shapes below scanned clean against
// rules whose message says they are the thing being caught.
import { execFileSync, spawnSync } from "node:child_process";

const packageDir = process.argv[2];

// ruleid: script-spawn-with-shell-true
spawnSync(packageDir, [], { shell: true });

// ruleid: script-spawn-with-shell-true
spawnSync("node", ["nx.js", "show", "project", packageDir], { shell: true, encoding: "utf8" });

// The TWO-argument form, which is what `spawn(command[, args][, options])`
// makes valid: options in position two, no argument array at all. Every
// pattern here once demanded a three-argument shape, so each of these ran
// through `/bin/sh -c` with the rule reporting nothing.
// ruleid: script-spawn-with-shell-true
spawnSync(`nx show project ${packageDir}`, { shell: true });

// ruleid: script-spawn-with-shell-true
spawn(`rm -rf ${packageDir}`, { shell: true });

// ruleid: script-spawn-with-shell-true
execFileSync(`ls ${packageDir}`, { shell: true });

// `execFile` puts its callback AFTER the options object, so the options are
// neither the second argument nor the last one.
// ruleid: script-spawn-with-shell-true
execFile(`ls ${packageDir}`, { shell: true }, () => {});

// The same two shapes reached through a namespace import rather than a named
// one — the `$X.` half of every pattern, which had the same arity demand.
// ruleid: script-spawn-with-shell-true
childProcess.spawnSync(`nx show project ${packageDir}`, { shell: true });

// ruleid: script-spawn-with-shell-true
childProcess.execFileSync(`ls ${packageDir}`, { shell: true });

// `shell` is documented as `<boolean> | <string>`, and the string form names
// the shell to run the command in — the same `/bin/sh -c` exposure under a
// spelling the literal `true` pattern never matched.
// ruleid: script-spawn-with-shell-true
spawnSync("git", ["log"], { shell: "/bin/bash" });

// ruleid: script-spawn-with-shell-true
spawnSync("git", ["log"], { shell: process.env.SHELL });

// `shell: false` IS the fix the message asks for — spelled out rather than
// omitted. Reporting it would send a reader to a change they have already
// made, so the rule matches the option's VALUE and excludes exactly this one.
// ok: script-spawn-with-shell-true
spawnSync("git", ["log"], { shell: false });

// ok: script-spawn-with-shell-true
spawnSync("node", ["nx.js", "show", "project", packageDir], { encoding: "utf8" });

// ok: script-spawn-with-shell-true
execFileSync("git", ["ls-files", "--", packageDir], { encoding: "utf8" });

// ruleid: script-exec-command-built-from-a-value
execSync(`nx show project ${packageDir}`);

// ruleid: script-exec-command-built-from-a-value
exec("nx show project " + packageDir, () => {});

// Assembling the command one line earlier changes nothing about what reaches
// the shell, and a rule that only looks at the call site sees a plain
// identifier and reports nothing. This is the shape a refactor produces the
// first time a command gets long enough to want a name.
const templateCommand = `nx show project ${packageDir}`;
// ruleid: script-exec-command-built-from-a-value
execSync(templateCommand);

const concatenatedCommand = "nx show project " + packageDir;
// ruleid: script-exec-command-built-from-a-value
childProcess.exec(concatenatedCommand, () => {});

// A literal command with nothing interpolated still runs through a shell, but it
// carries no value that a package directory could have supplied — the rule is
// about the interpolation, so this must not be reported.
// ok: script-exec-command-built-from-a-value
execSync("git rev-parse --show-toplevel");

// A literal assembled into a variable is the same non-finding one refactor
// later: nothing a package directory supplied ever enters it.
const literalCommand = "git rev-parse --show-toplevel";
// ok: script-exec-command-built-from-a-value
execSync(literalCommand);

// The fix the message asks for. If this were reported, following the message
// would lead nowhere.
// ok: script-exec-command-built-from-a-value
execFileSync("nx", ["show", "project", packageDir], { encoding: "utf8" });
