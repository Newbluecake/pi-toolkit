/**
 * HUD 插件自身信息：包版本（package.json）+ 所在 git 检出的 HEAD commit / 提交时间 / 脏标记。
 *
 * - 包根由 import.meta.url 推出（<root>/src/hud 或 <root>/dist/hud → <root>/）。
 * - 只有当包根本身就是 git 顶层目录时才读 git 信息：npm 安装到某项目的 node_modules
 *   里时，`git -C <root>` 会上溯到宿主项目，报出的是别人的 commit，必须排除。
 * - 不走 pi.exec：每次 activate 只读一次，用独立的 execFile，避免与 refresh 的
 *   git 调用（及其测试 mock 顺序）互相干扰。所有失败静默降级（缺哪段就不显示哪段）。
 */
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginInfo {
  version?: string | undefined;
  commit?: string | undefined;
  /** HEAD 提交时间（epoch ms，committer date）。 */
  commitTime?: number | undefined;
  /** 工作树有未提交的已跟踪文件改动。 */
  dirty?: boolean | undefined;
}

export type GitRunner = (args: string[]) => Promise<string | undefined>;

export interface PluginInfoDeps {
  root: string;
  readText: (path: string) => Promise<string>;
  git: GitRunner;
  realpath: (path: string) => Promise<string>;
}

const GIT_TIMEOUT_MS = 3_000;

export function pluginRoot(): string | undefined {
  try {
    return fileURLToPath(new URL("../..", import.meta.url));
  } catch {
    return undefined;
  }
}

function defaultGit(root: string): GitRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = execFile(
        "git",
        ["-C", root, ...args],
        { timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
        (err, stdout) => resolve(err ? undefined : stdout),
      );
      child.unref();
    });
}

export function defaultPluginInfoDeps(): PluginInfoDeps | undefined {
  const root = pluginRoot();
  if (!root) return undefined;
  return { root, readText: (p) => readFile(p, "utf8"), git: defaultGit(root), realpath };
}

async function safeRealpath(deps: PluginInfoDeps, path: string): Promise<string> {
  try {
    return await deps.realpath(path);
  } catch {
    return path.replace(/[/\\]+$/, "");
  }
}

export async function readPluginInfo(deps: PluginInfoDeps): Promise<PluginInfo> {
  const info: PluginInfo = {};
  try {
    const pkg = JSON.parse(await deps.readText(join(deps.root, "package.json"))) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) info.version = pkg.version;
  } catch {
    /* 无 package.json / 解析失败：不显示版本 */
  }

  const top = (await deps.git(["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return info;
  const [topReal, rootReal] = await Promise.all([safeRealpath(deps, top), safeRealpath(deps, deps.root)]);
  if (topReal !== rootReal) return info;

  const [log, status] = await Promise.all([
    deps.git(["log", "-1", "--format=%h%x09%ct"]),
    deps.git(["status", "--porcelain", "--untracked-files=no"]),
  ]);
  const [hash, ct] = (log ?? "").trim().split("\t");
  if (hash) info.commit = hash;
  const seconds = Number(ct);
  if (ct && Number.isFinite(seconds) && seconds > 0) info.commitTime = seconds * 1000;
  if (status !== undefined) info.dirty = status.trim().length > 0;
  return info;
}
