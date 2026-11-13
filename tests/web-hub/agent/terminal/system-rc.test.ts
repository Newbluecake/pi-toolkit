/** Unit filesystem fixtures only: never source rc or modify the host's /etc. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemRcPreflight } from "../../../integration/web-hub-terminal-system-rc.js";

vi.mock("node:fs", async (load) => {
  const real = await load<typeof import("node:fs")>();
  return { ...real, statSync: vi.fn(real.statSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.mocked(statSync).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rc-"));
  roots.push(root);
  for (const dir of ["etc/profile.d", "usr/share/rc", "outside", "etc-escape"])
    mkdirSync(join(root, dir), { recursive: true });
  const file = join(root, "etc/profile.d/test.sh");
  const target = join(root, "usr/share/rc/test.sh");
  const write = (path: string, text = 'export LANG="C.UTF-8"\n', mode = 0o644) => {
    writeFileSync(path, text);
    chmodSync(path, mode); // Independent of the caller's umask.
  };
  const check = (files: string[] = [file]) => systemRcPreflight({ root, files, ownerUid: process.getuid!() });
  return { root, file, target, write, check };
}

describe("terminal fixture system rc preflight", () => {
  it("audits a symlink's safe regular target under /usr, not the link's 0777 mode", () => {
    const f = fixture();
    f.write(f.target);
    symlinkSync(f.target, f.file);
    expect(f.check()).toEqual([f.target]);
    expect(vi.mocked(statSync)).toHaveBeenCalledWith(f.target);
  });
  it("also accepts a safe target under /etc", () => {
    const f = fixture();
    const target = join(f.root, "etc/rc.sh");
    f.write(target);
    symlinkSync(target, f.file);
    expect(f.check()).toEqual([target]);
  });
  it.each(["outside", "etc-escape"])("rejects a symlink escaping trusted roots to %s with path and reason", (dir) => {
    const f = fixture();
    const target = join(f.root, dir, "rc.sh");
    f.write(target);
    symlinkSync(target, f.file);
    expect(f.check).toThrow(`${f.file}: resolved target outside trusted /etc or /usr: ${target}`);
  });
  it.each([false, true])("rejects world-writable targets (symlink=%s) without leaking rc text", (symlink) => {
    const f = fixture();
    f.write(symlink ? f.target : f.file, "SECRET_RC_BODY\n", 0o646);
    if (symlink) symlinkSync(f.target, f.file);
    expect(f.check).toThrow(`${f.file}: resolved target is world-writable`);
    expect(f.check).not.toThrow("SECRET_RC_BODY");
  });
  it("allows root-group write but refuses write by another group", () => {
    const f = fixture();
    f.write(f.file, "# harmless\n", 0o664);
    const st = statSync(f.file);
    vi.mocked(statSync).mockReturnValueOnce({ ...st, isFile: st.isFile.bind(st), gid: 0 } as ReturnType<
      typeof statSync
    >);
    expect(f.check()).toEqual([f.file]);
    vi.mocked(statSync).mockReturnValueOnce({ ...st, isFile: st.isFile.bind(st), gid: 1234 } as ReturnType<
      typeof statSync
    >);
    expect(f.check).toThrow(`${f.file}: resolved target is writable by non-root group`);
  });
  it("requires root ownership by default, including for symlink targets", () => {
    const f = fixture();
    f.write(f.target);
    symlinkSync(f.target, f.file);
    const st = statSync(f.target);
    vi.mocked(statSync).mockReturnValueOnce({ ...st, isFile: st.isFile.bind(st), uid: 1234 } as ReturnType<
      typeof statSync
    >);
    expect(() => systemRcPreflight({ root: f.root, files: [f.file] })).toThrow(
      `${f.file}: resolved target is not owned by trusted root uid`,
    );
  });
  it.each(["export HOME=/not-the-fixture", "ZDOTDIR=/elsewhere", "unset HOME", "read ZDOTDIR"])(
    "preserves redirection detection through symlinks: %s",
    (code) => {
      const f = fixture();
      f.write(f.target, code);
      symlinkSync(f.target, f.file);
      expect(f.check).toThrow(`${f.file}: system startup redirects fixture HOME/ZDOTDIR`);
    },
  );
  it("ignores full-line comments, not active redirection", () => {
    const f = fixture();
    f.write(f.file, "  # export HOME=/not-the-fixture\n# unset ZDOTDIR\n");
    expect(f.check()).toEqual([f.file]);
  });
  it("rejects dangling links and non-files with the candidate path", () => {
    const f = fixture();
    symlinkSync(f.target, f.file);
    expect(f.check).toThrow(`${f.file}: cannot resolve startup file (ENOENT)`);
    rmSync(f.file);
    mkdirSync(f.file);
    expect(f.check).toThrow(`${f.file}: resolved target is not a regular file`);
  });
  it("skips missing optional files but discovers Ubuntu bash/zsh and profile.d inputs", () => {
    const f = fixture();
    f.write(join(f.root, "etc/bash.bashrc"));
    mkdirSync(join(f.root, "etc/zsh"));
    f.write(join(f.root, "etc/zsh/zshenv"));
    f.write(f.file);
    expect(f.check([join(f.root, "etc/missing")])).toEqual([]);
    expect(systemRcPreflight({ root: f.root, ownerUid: process.getuid!() })).toEqual([
      join(f.root, "etc/bash.bashrc"),
      join(f.root, "etc/zsh/zshenv"),
      f.file,
    ]);
  });
});
