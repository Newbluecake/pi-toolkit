import { constants } from "node:fs";
import { normalize } from "node:path";
import {
  createRetainedSessionGuard,
  type RetainedSessionFs,
  type RetainedStat,
} from "../../../../src/web-hub/hub/spawn/retained-session.js";

export function retainedFake(
  files = new Map<string, { head: string; uid?: number; symlink?: boolean; file?: boolean; dir?: boolean }>(),
) {
  let nextFd = 10;
  const fds = new Map<number, string>();
  const inodes = new Map<string, number>();
  const bad = new Map<string, "symlink" | "missing" | "owner" | "nlink" | "directory">();
  const ledger: Array<{ op: string; path: string; flags?: number }> = [];
  let onOp = (_op: string, _path: string): void => {};
  const pathOf = (path: string): string => {
    const match = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(path);
    if (!match) return path;
    const parent = fds.get(Number(match[1]));
    if (parent === undefined) throw Error("closed fd");
    return normalize(`${parent}/${match[2]}`);
  };
  const mark = (op: string, path: string, flags?: number) => {
    ledger.push({ op, path, ...(flags === undefined ? {} : { flags }) });
    onOp(op, path);
  };
  const stat = (path: string, directory: boolean): RetainedStat => {
    const fault = bad.get(path),
      f = files.get(path);
    if (fault === "missing" || (!directory && f === undefined))
      throw Object.assign(Error("missing"), { code: "ENOENT" });
    let ino = inodes.get(path);
    if (ino === undefined) {
      ino = inodes.size + 1;
      inodes.set(path, ino);
    }
    return {
      dev: 1,
      ino,
      uid: fault === "owner" ? 999 : (f?.uid ?? 1000),
      nlink: fault === "nlink" ? 2 : 1,
      isDirectory: () => directory && fault !== "symlink",
      isFile: () => !directory && fault !== "directory" && f?.file !== false && f?.dir !== true && f?.symlink !== true,
      isSymbolicLink: () => fault === "symlink" || f?.symlink === true,
    };
  };
  const fs: RetainedSessionFs = {
    openSync(raw, flags) {
      const path = pathOf(raw);
      mark("open", path, flags);
      if (bad.get(path) === "symlink") throw Object.assign(Error("symlink"), { code: "ELOOP" });
      if (bad.get(path) === "missing") throw Object.assign(Error("missing"), { code: "ENOENT" });
      const fd = nextFd++;
      fds.set(fd, path);
      return fd;
    },
    fstatSync(fd) {
      const path = fds.get(fd);
      if (path === undefined) throw Error("closed");
      mark("fstat", path);
      return stat(path, !files.has(path));
    },
    lstatSync(raw) {
      const path = pathOf(raw);
      mark("lstat", path);
      return stat(path, false);
    },
    readSync(fd, buffer, offset, length, position) {
      const path = fds.get(fd);
      if (path === undefined) throw Error("closed");
      mark("read", path);
      const data = Buffer.from(files.get(path)?.head ?? "");
      return data.copy(buffer, offset, position, position + length);
    },
    closeSync(fd) {
      const path = fds.get(fd);
      mark("close", path ?? "unknown");
      fds.delete(fd);
    },
  };
  const guard = createRetainedSessionGuard({ agentDir: "/home/u/.pi/agent", uid: 1000, fs });
  return {
    fs,
    guard,
    files,
    ledger,
    bad,
    inodes,
    fds,
    setOnOp: (fn: typeof onOp) => {
      onOp = fn;
    },
    reads: () => ledger.filter((e) => e.op === "read"),
    probes: () => ledger.filter((e) => e.op !== "close"),
    nofollow: () => ledger.filter((e) => e.op === "open").every((e) => (e.flags! & constants.O_NOFOLLOW) !== 0),
  };
}
