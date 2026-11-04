// 外发 shape 规则（plan.md v3.2 §6.1）——本地规则与外发共用（§11.1）。
//
// 任何情况都只产生 `program` 或 `program subcommand`：不发参数、flag 值、URL
// 或路径。已知子命令程序（git/npm/pnpm/yarn/gh/cargo/docker）按逐程序枚举表
// 发 `program subcommand`（子命令不在枚举内 ⇒ 只发 program）；其他程序取
// basename 且须匹配 ^[a-z0-9._-]{1,24}$；脚本 basename 须匹配
// ^[\w.-]{1,40}\.sh$；解释器 -c/-e 只发 program（不解析内层）。pi-free；无
// 模块级可变状态（I4）。

import type { SimpleCommand } from "../contracts.js";
import { parseShell } from "../shell-parse.js";

// ───────────────────────────── 枚举表（§6.1） ─────────────────────────────

/** git 与 npm、gh 的枚举表逐字取自方案 §6.1；pnpm/yarn/cargo/docker 方案只
 *  给了程序名，枚举按各程序常用子命令补齐（保守：宁缺毋滥，缺省只发
 *  program，不泄露更多信息）。 */
export const SUBCOMMAND_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set([
    "commit",
    "push",
    "pull",
    "fetch",
    "status",
    "diff",
    "log",
    "add",
    "reset",
    "rebase",
    "checkout",
    "switch",
    "merge",
    "cherry-pick",
    "stash",
    "tag",
    "branch",
    "worktree",
    "clone",
    "show",
  ]),
  npm: new Set(["install", "i", "ci", "test", "run", "publish", "version"]),
  pnpm: new Set(["install", "i", "add", "remove", "ci", "test", "run", "publish"]),
  yarn: new Set(["install", "add", "remove", "test", "run", "publish"]),
  gh: new Set(["pr", "run", "release", "workflow", "issue"]),
  cargo: new Set(["build", "test", "run", "publish", "bench", "check", "clippy", "fmt", "doc"]),
  docker: new Set(["build", "run", "push", "pull", "ps", "images", "stop", "rm", "exec", "compose", "tag", "inspect"]),
};

const PROGRAM_RE = /^[a-z0-9._-]{1,24}$/;
const SCRIPT_RE = /^[\w.-]{1,40}\.sh$/;
const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "node", "python", "python3"]);

function sanitizeProgram(program: string): string {
  return PROGRAM_RE.test(program) ? program : "other";
}

// ───────────────────────────── 单命令 shape（§6.1 shapeOf） ─────────────────────────────

/** 一个 SimpleCommand → `program [subcommand]`。`cmd.program` 由 parseShell
 *  去壳得出（`timeout 600 bash x.sh` 的 program 已是 `x.sh`）。解释器带
 *  `-c`/`-e` ⇒ 只发 program（不解析内层，§6.1）。 */
export function shapeOfCommand(cmd: SimpleCommand): string {
  const program = sanitizeProgram(cmd.program);
  if (program === "other") return "other";
  if (SCRIPT_RE.test(program)) return program; // 脚本 basename（去壳后的 program）
  if (INTERPRETERS.has(program) && cmd.argv.slice(1).some((a) => a === "-c" || a === "-e")) {
    return program; // 解释器 -c/-e：只发 program
  }
  const enums = SUBCOMMAND_ENUMS[program];
  if (enums === undefined) return program; // echo/curl/解释器/未知程序：只发 program
  const sub = cmd.argv.slice(1).find((a) => !a.startsWith("-"));
  if (sub === undefined || !enums.has(sub)) return program; // 非枚举子命令 ⇒ 只发 program
  return `${program} ${sub}`;
}

// ───────────────────────────── 整条命令（本地规则入口） ─────────────────────────────

/** parseShell 会把 `-c`/`$()` 内层平铺进结果（内层在前、外壳在后）。取**最后
 *  一个** SimpleCommand 作为主 shape：多命令链取最后一个、递归命令取外壳——
 *  两种取向都保证绝不把内层内容提升为 shape（§6.1 口径）。 */
export function shapeOf(command: string): string {
  const commands = parseShell(command).commands;
  if (commands.length === 0) return "other";
  return shapeOfCommand(commands[commands.length - 1]!);
}

/** 全部子命令的 shape（去重、保序）。状态约束 S（§3.4）用它做存在性匹配：
 *  `sh release.sh && gh release create` 的两个 top-level 命令都能被看到。 */
export function allShapes(command: string): readonly string[] {
  const out: string[] = [];
  for (const cmd of parseShell(command).commands) {
    const shape = shapeOfCommand(cmd);
    if (!out.includes(shape)) out.push(shape);
  }
  return out;
}
