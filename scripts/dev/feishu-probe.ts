#!/usr/bin/env node
// Node >=22.22 native type stripping (no transpiler or runtime dependencies).
import { pathToFileURL } from "node:url";
import { failureInfo } from "./feishu-probe/errors.ts";
import { P1, handlers, stepStatus } from "./feishu-probe/steps.ts";
import { Probe, QUESTIONS, STEPS, Unknown } from "./feishu-probe/runtime.ts";
import type { StepId } from "./feishu-probe/runtime.ts";
import { readCredentials, writePrivate } from "./feishu-probe/safety.ts";

const HELP = `飞书真实租户探针 F-probe（零依赖，Node 22.22+）
用法：
  node scripts/dev/feishu-probe.ts --steps P1
  node scripts/dev/feishu-probe.ts --reuse --steps P2,P3,P4,P5,P6,P7,P8
  node scripts/dev/feishu-probe.ts --reuse --steps P5 --timeout 120
  npx tsx scripts/dev/feishu-probe.ts --help

选项：
  --steps P1,P2,...  只运行指定步骤（始终按 P1–P8 顺序；默认全部）
  --skip P4,P8      跳过指定步骤；每步也可交互输入 s 跳过
  --reuse           复用 ~/.pi/agent/feishu-probe/credentials.json
  --timeout 秒      每次交互/收事件窗口，5–600（默认 90）；HTTP 8s / WS 握手 10s
  --help, -h        仅显示帮助，不联网、不创建文件

P1 扫码注册 PersonalAgent；P2 endpoint/WS/pong；P3 私聊接收+ACK；
P4 故意不 ACK→新连接重投 + 双连接；P5 卡片按钮/ACK/PATCH ±update_multi；
P6 Typing、生成的无敏感附件上传/发送、用户附件下载；
P7 普通群 @/reply_in_thread、话题群；P8 错误 secret + 第二位用户可见性。

请用测试应用/非敏感消息；先关闭同一应用的其他机器人客户端。
探针会发送卡片、消息和小附件，P4 故意不 ACK，P8 故意认证失败。
下载只读入内存并丢弃，不落盘。不会执行任何 pi/机器人控制命令。
凭据为 0600、目录 0700；报告只保留脱敏事实（ID 哈希，文本长度）。
超时/无消息=unknown，不能据此认定平台不支持；重投窗口不能证明无限期保证。
Ctrl-C 会关闭连接并保存部分报告。退出：0 完成（含 skipped/unknown），1 失败，2 参数错误，130 中断。
`;
export function parseArgs(args: string[]): { steps: StepId[]; reuse: boolean; timeoutMs: number; help: boolean } {
  let selected = STEPS.slice(),
    skip: StepId[] = [],
    reuse = false,
    timeoutMs = 90_000;
  const list = (value: string | undefined): StepId[] => {
    const ids = value?.split(",") ?? [];
    if (!ids.length || ids.some((id) => !STEPS.includes(id as StepId))) throw new Error("steps");
    return ids as StepId[];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return { steps: [], reuse: false, timeoutMs, help: true };
    if (a === "--reuse") reuse = true;
    else if (a === "--steps") selected = list(args[++i]);
    else if (a === "--skip") skip = list(args[++i]);
    else if (a === "--timeout") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) throw new Error("timeout");
      timeoutMs = seconds * 1000;
    } else throw new Error("argument");
  }
  return { steps: STEPS.filter((id) => selected.includes(id) && !skip.includes(id)), reuse, timeoutMs, help: false };
}
export async function main(args: string[]): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(args);
  } catch {
    console.error("参数无效。使用 --help 查看用法。");
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (typeof WebSocket !== "function") {
    console.error("需要 Node 22.22+ 的全局 WebSocket。");
    return 1;
  }
  const p = new Probe(options.timeoutMs);
  let code = 0,
    reportPath: string | undefined;
  const interrupted = () => {
    p.report.interrupted = true;
    code = 130;
    p.close();
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    console.log(
      "F-probe：本地交互测试，不是生产机器人。所有租户结论仅适用于当前应用及当前配置。每步回车运行 / s 跳过。",
    );
    if (options.reuse && !options.steps.includes("P1")) {
      p.credentials = await readCredentials(p.credentialDir);
      p.secrets.push(p.credentials.appSecret);
    }
    for (const id of options.steps) {
      if (p.signal.aborted) break;
      p.current = id;
      try {
        const answer = await p.ask(`运行 ${id}？（回车=运行，s=跳过）`);
        if (answer.toLowerCase() === "s") continue;
        p.report.steps[id].status = "pass";
        if (id === "P1") await P1(p, options.reuse);
        else await handlers[id](p);
        p.report.steps[id].status = stepStatus(p, id);
      } catch (e) {
        if (p.signal.aborted) {
          if (p.report.steps[id].status !== "fail") p.report.steps[id].status = "unknown";
          p.record("interrupted", { reason: "interrupted" });
          break;
        }
        if (p.report.steps[id].status !== "fail") p.report.steps[id].status = e instanceof Unknown ? "unknown" : "fail";
        const info = e instanceof Unknown ? { reason: e.message } : failureInfo(e);
        p.record("step-stopped", info);
        console.log(
          `${id}：${p.report.steps[id].status} ${JSON.stringify(info)}（无消息/跳过子项不代表不支持；凭据检查 file-symlink/owner/mode/size 分别表示符号链接/归属/权限/体积不安全）。`,
        );
      }
      for (const c of p.sockets) c.close();
    }
  } catch (error) {
    code = p.signal.aborted ? 130 : 1;
    const info = p.signal.aborted ? { reason: "interrupted" } : failureInfo(error);
    p.record("probe-stopped", info);
    console.error(
      `探针停止：${JSON.stringify(info)}。凭据检查 file-symlink/owner/mode/size 分别表示符号链接/归属/权限/体积不安全。使用 --steps P1 注册或 --reuse 复用。`,
    );
  } finally {
    p.close();
    p.report.finishedAt = new Date().toISOString();
    try {
      const stamp = p.report.startedAt.replace(/[:.]/g, "-");
      reportPath = await writePrivate("report-" + stamp + ".json", p.report);
    } catch {
      console.error("无法安全写入报告（要求目录归当前用户且 0700）。");
      code = code === 130 ? 130 : 1;
    }
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  console.log("\n租户事实汇总（unknown/skipped 必须补测；pass 表示获得观察，非平台保证）：");
  for (const [id, question] of Object.entries(QUESTIONS)) {
    const fact = p.report.facts[id]!;
    const observed = JSON.stringify(fact.observations);
    console.log(
      `${id} ${question}: ${fact.status} ${observed.length <= 1800 ? observed : observed.slice(0, 1800) + "…（完整观察见 JSON）"}`,
    );
  }
  console.log("步骤：" + STEPS.map((id) => `${id}=${p.report.steps[id].status}`).join(" "));
  if (reportPath) console.log("脱敏报告：" + reportPath);
  if (p.report.interrupted) code = 130;
  if (code === 0 && STEPS.some((id) => p.report.steps[id].status === "fail")) code = 1;
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2));
  // Native WebSocket's closing handshake can otherwise keep a CLI alive for 30s.
  // All application timers/listeners/sockets have been closed; flush the final output first.
  process.stdout.write("", () => {
    process.exit(code);
  });
}
