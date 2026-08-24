/**
 * The containment decision is pure over injectable `lstatSync`/`realpathSync`
 * seams — the same shape `../governance/adr-registry.mjs`'s `loadAdrRegistry`
 * passes into this helper — so every rule of the read policy and the write
 * policy is pinned with no filesystem. Each case carries its silent direction:
 * the state where the OLD behavior (plain `readFileSync(join(root, path))` /
 * `renameSync`) passed cleanly and the NEW behavior is loud.
 */
import { describe, expect, it } from "vitest";

import { containmentViolation, pathEscapes } from "./containment.mjs";

/**
 * A fake in-memory tree: directories and files are the existent nodes,
 * symlinks the redirecting ones. `lstatSync` answers existence for the
 * ancestry walk (`deepestExistingAncestor`); `realpathSync` resolves a symlink
 * chain to its (possibly file) landing — a non-existent path is ENOENT.
 */
function fakeIo({ dirs = new Set(), files = new Set(), symlinks = new Map() } = {}) {
  const exists = (path) => dirs.has(path) || files.has(path);
  const targetOf = (path) => {
    for (const link of symlinks) {
      // A symlink at the deepest matching prefix redirects this path.
      if (path === link[0] || path.startsWith(`${link[0]}/`)) return link[1];
    }
    return null;
  };
  const lstatSync = (path) => {
    const target = targetOf(path);
    if (target !== null) return { isSymbolicLink: () => true };
    if (exists(path)) return { isSymbolicLink: () => false };
    throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
  };
  const realpathSync = (path) => {
    const target = targetOf(path);
    if (target !== null) return realpathSync(target);
    // A path with no matching symlink is its own realpath — the mount-at-root
    // shape (`/ws -> /mnt/ws`) is represented by the caller passing the
    // realpath as the root string, exactly as the policy docstring says. The
    // "resolvable" test is component existence, which the caller's
    // deepest-existing-ancestor walk has already established for the path it
    // hands us.
    if (!exists(path)) throw new Error(`ENOENT: realpath '${path}'`);
    return path;
  };
  return { lstatSync, realpathSync, exists };
}

describe("containmentViolation — read policy", () => {
  const root = "/ws";

  it("returns null when the path is inside the workspace", () => {
    const io = fakeIo({ dirs: new Set(["/ws", "/ws/apps", "/ws/apps/x"]) });
    expect(containmentViolation(root, "/ws/apps/x/hooks.go", io)).toBeNull();
  });

  it("returns null for a tracked symlink whose realpath stays inside the workspace (legitimate internal layout)", () => {
    // `apps/x/hooks.ts -> ../../libs/shared/hooks.ts` — the read policy must
    // NOT refuse an internal symlink; only a path that escapes is a finding.
    const io = fakeIo({
      dirs: new Set(["/ws", "/ws/apps", "/ws/apps/x", "/ws/libs", "/ws/libs/shared"]),
      symlinks: new Map([["/ws/apps/x/hooks.ts", "/ws/libs/shared/hooks.ts"]]),
    });
    expect(containmentViolation(root, "/ws/apps/x/hooks.ts", io)).toBeNull();
  });

  it("returns a reason when a symlink resolves outside the workspace — the G-10 read escape", () => {
    // Silent direction: `readFileSync` follows the symlink and reads
    // `/tmp/out/outsider.ts` as the workspace's own source — outside bytes
    // judged inside, reported clean. New behavior: refused, and the analyzer
    // turns the refusal into a whole-file failure (exit 3 / indexGaps).
    const io = fakeIo({
      dirs: new Set(["/ws", "/ws/apps", "/ws/apps/x", "/tmp", "/tmp/out"]),
      files: new Set(["/tmp/out/outsider.ts"]),
      symlinks: new Map([["/ws/apps/x/hooks.ts", "/tmp/out/outsider.ts"]]),
    });
    const reason = containmentViolation(root, "/ws/apps/x/hooks.ts", io);
    expect(reason).toContain("outside");
    expect(reason).toContain("/ws");
  });

  it("returns null for a tracked symlink pointing INTO the workspace from outside (G-10 reverse)", () => {
    // The AUDIT's second direction: an outside entry `outside/tool.ts -> /ws/apps/x/hooks.ts`
    // resolves INSIDE the workspace, so it is not the escape this guard closes —
    // it reaches tracked content, not attacker bytes. The workspace-relative
    // read `readWorkspaceFile(root, "apps/x/hooks.ts")` never touches the
    // outside entry at all.
    const io = fakeIo({
      dirs: new Set(["/ws", "/ws/apps", "/ws/apps/x", "/tmp", "/tmp/out"]),
      files: new Set(["/tmp/out/tool.ts", "/ws/apps/x/hooks.ts"]),
      symlinks: new Map([["/tmp/out/tool.ts", "/ws/apps/x/hooks.ts"]]),
    });
    expect(containmentViolation(root, "/ws/apps/x/hooks.ts", io)).toBeNull();
  });

  it("returns a reason when the path is not inside the workspace at all", () => {
    const io = fakeIo({
      dirs: new Set(["/tmp", "/tmp/out"]),
      files: new Set(["/tmp/out/outsider.ts"]),
    });
    expect(containmentViolation(root, "/tmp/out/outsider.ts", io)).toContain("outside");
  });

  it("refuses a raw `..` segment — the check cannot prove where the kernel lands, so it fails loudly", () => {
    // Silent direction: `lstat` answers ENOENT for a non-collapsed `..`, so
    // the ancestry probe skips the symlink the kernel WOULD follow (`sub ->
    // /tmp/out`, then `..` climbs to `/tmp`). The write site must `resolve()`
    // first; a caller that forgets gets a loud refusal, not a silent escape.
    const io = fakeIo({
      dirs: new Set(["/ws", "/tmp", "/tmp/out"]),
      files: new Set(["/tmp/out/PWN.txt"]),
      symlinks: new Map([["/ws/sub", "/tmp/out"]]),
    });
    const reason = containmentViolation(root, "/ws/sub/../out/PWN.txt", { ...io, forWrite: true });
    expect(reason).toContain("..");
    expect(containmentViolation(root, "/ws/sub/../out/PWN.txt", io)).toContain("..");
  });

  it("pathEscapes compares components, so a Windows `..\\` sibling is refused with a forward-slash harness", () => {
    // G-10's Windows corner: `relative("C:\\ws", "C:\\out")` is `"..\\out"`,
    // which the `"../"` string test misreads as contained; same-drive siblings
    // must be caught by component comparison instead. POSIX-style CWD paths
    // resolve to the same shape, so component comparison works on both
    // separator families.
    expect(pathEscapes("C:/ws", "C:/out")).toBe(true);
    expect(pathEscapes("C:/ws", "C:/ws/libs/shared")).toBe(false);
    expect(pathEscapes("/ws", "/mnt/ws")).toBe(true);
    expect(pathEscapes("/ws", "/ws/libs/shared")).toBe(false);
  });

  it("within carries the same separator awareness on the real win32 path module", () => {
    // The write short-circuit uses `relative()`, whose string form differs by
    // platform: `win32.relative("C:\\ws", "C:\\out")` is `"..\\out"`, which
    // starts with `..\`, not `../`. `containmentViolation`'s `within` test must
    // treat that `..\` prefix as outside too — this pins it against the actual
    // win32 module rather than a hand-written fixture.
    const { win32 } = require("node:path");
    const inside = containmentViolation("C:\\ws", win32.resolve("C:\\ws", "out.json"), {
      forWrite: true,
    });
    const sibling = containmentViolation("C:\\ws", "C:\\out\\report.json", { forWrite: true });
    // Inside is null; the sibling is the caller's explicitly-outside choice, so
    // it short-circuits to null via `within` (write) rather than being refused
    // as a symlink escape — the outside-target policy, not the Windows path.
    expect(inside).toBeNull();
    expect(sibling).toBeNull();
  });
});

describe("containmentViolation — write policy", () => {
  const root = "/ws";

  it("returns null for a plain internal write target", () => {
    const io = fakeIo({ dirs: new Set(["/ws", "/ws/reports"]) });
    expect(
      containmentViolation(root, "/ws/reports/out.json", { ...io, forWrite: true }),
    ).toBeNull();
  });

  it("returns null for an explicitly-outside target the caller named — `--output /tmp/report.json` is the caller's choice", () => {
    // The write policy refuses workspace-controlled symlink redirection, not
    // the caller's own explicit choice of an outside path. This is what keeps
    // `--output /tmp/...` in a CI recipe working.
    const io = fakeIo({ dirs: new Set(["/tmp"]) });
    expect(containmentViolation(root, "/tmp/report.json", { ...io, forWrite: true })).toBeNull();
  });

  it("refuses an intermediate symlink resolving outside — the G-02 runner-write escape", () => {
    // Silent direction: `archkeep check --output sub/PWN.txt` with `sub ->
    // /tmp/out` writes the report to /tmp/out/PWN.txt and reports success,
    // tree untouched. New behavior: refused loudly (exit 3).
    const io = fakeIo({
      dirs: new Set(["/ws", "/tmp", "/tmp/out"]),
      symlinks: new Map([["/ws/sub", "/tmp/out"]]),
    });
    const reason = containmentViolation(root, "/ws/sub/PWN.txt", { ...io, forWrite: true });
    expect(reason).toContain("symlink");
    expect(reason).toContain("/ws/sub");
  });

  it("refuses an intermediate self-loop symlink resolving inside — the G-02 `sub -> .` determinism bug", () => {
    // Silent direction: `sub -> .` passes a realpath-containment check (it
    // resolves INSIDE the workspace) but lands the write at the workspace
    // ROOT instead of under `sub/` — a different location than the user
    // named, byte-identical to a clean run. The write policy's
    // no-symlink-below-root rule catches it where realpath containment alone
    // cannot.
    const io = fakeIo({
      dirs: new Set(["/ws"]),
      symlinks: new Map([["/ws/sub", "/ws"]]),
    });
    const reason = containmentViolation(root, "/ws/sub/report.txt", { ...io, forWrite: true });
    expect(reason).toContain("symlink");
    expect(reason).toContain("/ws/sub");
  });

  it("refuses a symlink in any intermediate component, not only the first", () => {
    const io = fakeIo({
      dirs: new Set(["/ws", "/ws/a"]),
      symlinks: new Map([["/ws/a/b", "/tmp/out"]]),
    });
    expect(containmentViolation(root, "/ws/a/b/c/d.json", { ...io, forWrite: true })).toContain(
      "symlink",
    );
  });

  it("allows an internal symlinked directory for READS but refuses it for WRITES", () => {
    // The one asymmetric rule: an internal symlink is a legitimate tracked
    // layout for reads, and a different-location landing spot for writes.
    const io = fakeIo({
      dirs: new Set(["/ws", "/ws/lib", "/ws/lib/real"]),
      symlinks: new Map([["/ws/app", "/ws/lib/real"]]),
    });
    expect(containmentViolation(root, "/ws/app/x.go", io)).toBeNull();
    expect(containmentViolation(root, "/ws/app/x.go", { ...io, forWrite: true })).toContain(
      "symlink",
    );
  });
});
