/**
 * pi-hud 移植：git / worktree 状态读取（pi.exec 包装，exec 注入可测）。
 * 非 git 目录 / git 失败一律返回 undefined（footer 降级为 footerData.getGitBranch()）。
 */

export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export type GitState = {
  branch: string;
  localOid?: string | undefined;
  ahead: number;
  behind: number;
  dirty: number;
};

export type WorktreeInfo = {
  path: string;
  branch?: string | undefined;
  oid?: string | undefined;
  state?: GitState | undefined;
};

export async function readRepoState(exec: ExecFn, cwd: string): Promise<GitState | undefined> {
  const result = await exec("git", ["-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], {
    timeout: 3_000,
  });
  if (result.code !== 0) return undefined;

  let branch = "detached";
  let localOid: string | undefined;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length);
      if (oid !== "(initial)") localOid = oid.slice(0, 7);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      const aheadStr = match?.[1];
      const behindStr = match?.[2];
      if (aheadStr !== undefined && behindStr !== undefined) {
        ahead = Number(aheadStr);
        behind = Number(behindStr);
      }
    } else if (line && !line.startsWith("#")) {
      dirty++;
    }
  }

  return { branch, localOid, ahead, behind, dirty };
}

export async function readWorktrees(exec: ExecFn, cwd: string): Promise<WorktreeInfo[] | undefined> {
  const result = await exec("git", ["worktree", "list", "--porcelain"], {
    cwd,
    timeout: 3_000,
  });
  if (result.code !== 0) return undefined;

  const list: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      list.push(current);
    } else if (line.startsWith("HEAD ") && current) {
      current.oid = line.slice("HEAD ".length, "HEAD ".length + 7);
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  await Promise.all(
    list.slice(0, 10).map(async (wt) => {
      wt.state = await readRepoState(exec, wt.path);
    }),
  );
  return list;
}
