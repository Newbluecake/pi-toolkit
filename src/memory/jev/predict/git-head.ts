// `.git` / `.git/HEAD` 分支读取（plan.md v3.2 §7.3）——pi-free，fs 经端口注入。
//
// 普通仓库：`<cwd>/.git` 是目录，`HEAD` 直接在其下。linked worktree：
// `<cwd>/.git` 是一个文本文件，内容 `gitdir: <main>/.git/worktrees/<name>`
// （可能是相对 cwd 的相对路径）；该 worktree 的真实 HEAD 在
// `<gitdir>/HEAD`，且那里直接就是 `ref: refs/heads/<branch>`（不会再指向
// 另一个 gitdir）。`ref: refs/heads/<branch>` => 分支；40 位十六进制 =>
// detached（undefined）；HEAD 文件本身异常地含 `gitdir:`（不应出现，防御性
// 处理）=> 不当作分支，返回 undefined。任何失败都返回 undefined，永不抛。

import { resolve as resolvePathNode } from "node:path";

export interface GitHeadIo {
  /** 同步读一个小文本文件；任何失败（不存在/是目录/过大/编码异常）返回 undefined。 */
  readTextFile(path: string): string | undefined;
}

const REF_PREFIX = "ref: refs/heads/";
const GITDIR_PREFIX = "gitdir:";
const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[\w./-]{1,200}$/;
const MAX_HEAD_BYTES = 512;

function parseHeadText(text: string | undefined): { branch?: string; gitdir?: string } {
  if (text === undefined) return {};
  const firstLine = text.split("\n", 1)[0]!.trim();
  if (firstLine.length > MAX_HEAD_BYTES) return {};
  if (firstLine.startsWith(REF_PREFIX)) {
    const branch = firstLine.slice(REF_PREFIX.length);
    if (BRANCH_RE.test(branch) && !branch.includes("..") && !branch.endsWith(".lock")) {
      return { branch };
    }
    return {};
  }
  if (SHA_RE.test(firstLine)) return {}; // detached HEAD
  if (firstLine.startsWith(GITDIR_PREFIX)) {
    const dir = firstLine.slice(GITDIR_PREFIX.length).trim();
    if (dir !== "" && !dir.includes("\n")) return { gitdir: dir };
  }
  return {};
}

/** 读 `<dir>/HEAD` 并解析（纯；IO 全部经 `io`）。 */
export function readHeadAt(dir: string, io: GitHeadIo): { branch?: string; gitdir?: string } {
  return parseHeadText(io.readTextFile(`${dir.replace(/\/+$/, "")}/HEAD`));
}

/** 解析 `<cwd>/.git` 本身应被当作哪个目录读 `HEAD`：普通仓库返回其自身路径
 *  （`.git` 是目录，`readTextFile` 对目录返回 undefined，走该分支）；linked
 *  worktree 返回 `gitdir:` 指向的目录（相对路径按 cwd 解析）；都读不到/
 *  内容异常 => undefined。 */
function resolveGitDir(cwd: string, io: GitHeadIo): string | undefined {
  const normalizedCwd = cwd.replace(/\/+$/, "");
  const dotGitPath = `${normalizedCwd}/.git`;
  const dotGitText = io.readTextFile(dotGitPath);
  if (dotGitText === undefined) {
    // `.git` 不是一个可读文本文件（普通仓库中它是目录；也可能根本不存在，
    // 留给 readHeadAt 去读 `<dotGitPath>/HEAD` 时自然返回 undefined）。
    return dotGitPath;
  }
  const firstLine = dotGitText.split("\n", 1)[0]!.trim();
  if (firstLine.length > MAX_HEAD_BYTES || !firstLine.startsWith(GITDIR_PREFIX)) return undefined;
  const raw = firstLine.slice(GITDIR_PREFIX.length).trim();
  if (raw === "" || raw.includes("\n")) return undefined;
  return raw.startsWith("/") ? raw : resolvePathNode(normalizedCwd, raw);
}

/** 当前分支；非仓库 / detached / 指针损坏 => undefined。 */
export function readGitBranch(cwd: string, io: GitHeadIo): string | undefined {
  const gitDir = resolveGitDir(cwd, io);
  if (gitDir === undefined) return undefined;
  return readHeadAt(gitDir, io).branch;
}
