// Generates fixtures/demo-<lang>.json — a fully synthetic dev-hub scenario (no real data).
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = process.env.README_SHOTS_DIR ?? `${process.env.HOME}/readme-shots`;
mkdirSync(`${OUT}/fixtures`, { recursive: true });
const T0 = Date.parse("2026-10-18T09:12:00Z");
const now = Date.now();
for (const lang of ["zh", "en"]) {
  const zh = lang === "zh";
  const t = (zh1, en1) => (zh ? zh1 : en1);
  const mk = (key, cwd, name, extra = {}, status = {}, kind = "tui") => ({
    agentKey: key,
    kind,
    pid: 40000 + key.length * 7 + name.length,
    cwd,
    state: "live",
    pluginVersion: "0.6.0",
    outdated: false,
    control: true,
    epoch: `epoch-${key}`,
    prompts: [],
    session: {
      sessionId: `0192f3a1-${key.length}b7c-7d2e-9a41-5c8e1f0b6a${key.length}d`,
      name,
      cwd,
      reason: "user",
      leafId: `${key}-e8`,
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      thinkingLevel: "medium",
      mode: kind,
      ...extra,
    },
    status: { leafId: `${key}-e8`, busy: false, pending: false, ...status },
  });
  const quota = {
    v: 1,
    at: now,
    providers: [
      {
        id: "zai-coding-cn",
        plan: "max",
        level: 1,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 54, level: 1, resetAt: now + 2.1 * 3600e3, etaMs: 3.2 * 3600e3 },
          { scope: "week", usedPct: 31, level: 0, resetAt: now + 4.4 * 86400e3 },
        ],
      },
      {
        id: "kimi-coding",
        level: 0,
        stale: false,
        windows: [
          { scope: "5h", usedPct: 18, level: 0, resetAt: now + 3.6 * 3600e3 },
          { scope: "week", usedPct: 22, level: 0, resetAt: now + 5.2 * 86400e3 },
        ],
      },
    ],
  };
  const agents = [
    mk(
      "agent-alpha",
      "/home/demo/projects/acme-api",
      t("重构订单服务并补测试", "Refactor order service + tests"),
      {},
      {
        busy: true,
        contextUsage: { tokens: 118000, contextWindow: 200000, percent: 59 },
        costUsd: 3.84,
        subagentCostUsd: 1.62,
        quota,
      },
    ),
    mk(
      "agent-beta",
      "/home/demo/projects/web-dashboard",
      t("修复图表在移动端溢出", "Fix chart overflow on mobile"),
      {},
      { contextUsage: { tokens: 42000, contextWindow: 200000, percent: 21 }, costUsd: 0.92 },
    ),
    mk(
      "agent-gamma",
      "/home/demo/projects/infra-scripts",
      t("夜间依赖升级巡检", "Nightly dependency audit"),
      { reason: "cron", mode: "rpc" },
      { costUsd: 0.18 },
      "rpc",
    ),
    mk(
      "agent-delta",
      "/home/demo/projects/docs-site",
      t("文档站点迁移到新主题", "Migrate docs site to new theme"),
      {},
      { contextUsage: { tokens: 71000, contextWindow: 200000, percent: 36 }, costUsd: 1.37 },
    ),
  ];
  const code = [
    "```ts",
    "export async function placeOrder(cart: Cart, pay: Port) {",
    "  const draft = await priceCart(cart);      // pure",
    "  const charge = await pay.authorize(draft.total);",
    "  return commitOrder(draft, charge);        // 1 tx",
    "}",
    "```",
  ].join("\n");
  const entries = [
    {
      id: "a1",
      u: t(
        "订单服务里下单逻辑和支付耦合得太紧了，帮我拆开，再补上单测。",
        "Order placement is tightly coupled to payment. Split it up and add unit tests.",
      ),
    },
  ];
  const E = [];
  const ts = (i) => new Date(T0 + i * 15000).toISOString();
  const msg = (i, role, content, extra = {}) => ({
    id: `al-${i}`,
    parentId: i === 1 ? null : i === 4 ? "al-1" : `al-${i - 1}`,
    type: "message",
    timestamp: ts(i),
    message: { role, timestamp: T0 + i * 15000, content, ...extra },
  });
  E.push(msg(1, "user", entries[0].u));
  E.push(
    msg(4, "assistant", [
      {
        type: "text",
        text: t(
          "定价、扣款、落库三件事混在一个方法里。我把它拆成三个纯函数 + 一个 `PaymentPort`，并行派发两个子代理：一个补单测，一个做回归验证。",
          "Pricing, charging and persistence are tangled in one method. I'll split it into three pure functions plus a `PaymentPort`, and dispatch two subagents in parallel: one for unit tests, one for regression checks.",
        ),
      },
      {
        type: "toolCall",
        id: "c3",
        name: "Agent",
        args: {
          subagent_type: "dev",
          description: t("为新拆分的订单函数补单测", "Unit tests for the new order functions"),
        },
      },
      {
        type: "toolCall",
        id: "c4",
        name: "Agent",
        args: { subagent_type: "verifier", description: t("回归验证结账链路", "Regression-check the checkout flow") },
      },
    ]),
  );
  E.push(
    msg(
      5,
      "toolResult",
      t("已在后台启动 run_id=r_7Kq2…（完成后自动通知）", "Started in background run_id=r_7Kq2… (you will be notified)"),
      { toolCallId: "c3" },
    ),
  );
  E.push(
    msg(
      6,
      "toolResult",
      t("已在后台启动 run_id=r_9Xd4…（完成后自动通知）", "Started in background run_id=r_9Xd4… (you will be notified)"),
      { toolCallId: "c4" },
    ),
  );
  E.push(
    msg(7, "assistant", [
      {
        type: "text",
        text:
          t("拆分后的核心流程如下：\n\n", "The refactored core flow:\n\n") +
          code +
          "\n\n" +
          t(
            "两个子代理正在跑，进度见右侧**代理树**。",
            "Two subagents are running — see the **agent tree** on the right.",
          ),
      },
    ]),
  );
  const last = E[E.length - 1].id;
  const tail = E.slice(-2).map((e) => e.message);
  const history = {
    "agent-alpha": {
      agentKey: "agent-alpha",
      fromSeq: 1,
      hasMore: false,
      oldestEntryId: "al-1",
      source: "file",
      entries: E,
      tailMessages: tail,
    },
  };
  for (const a of agents.slice(1)) {
    const k = a.agentKey;
    history[k] = {
      agentKey: k,
      fromSeq: 1,
      hasMore: false,
      oldestEntryId: `${k}-e1`,
      source: "file",
      entries: [
        {
          id: `${k}-e1`,
          parentId: null,
          type: "message",
          timestamp: ts(1),
          message: { role: "user", timestamp: T0, content: a.session.name },
        },
        {
          id: `${k}-e8`,
          parentId: `${k}-e1`,
          type: "message",
          timestamp: ts(2),
          message: {
            role: "assistant",
            timestamp: T0 + 15000,
            content: [{ type: "text", text: t("已完成，改动见 diff。", "Done — see the diff.") }],
          },
        },
      ],
      tailMessages: [],
    };
  }
  agents[0].session.leafId = last;
  agents[0].status.leafId = last;
  const run = (o) => ({ highlight: "none", terminal: false, phaseMs: 8000, ...o });
  const fleet = [
    run({
      runId: "r-root",
      label: "main",
      type: "general",
      status: "running",
      phaseLabel: t("编排中", "orchestrating"),
      elapsedMs: 412000,
      costUsd: 1.62,
    }),
    run({
      runId: "r-dev",
      parentRunId: "r-root",
      label: "order-tests",
      type: "dev",
      model: "cr-kimi/k3-256k",
      thinking: "medium",
      status: "running",
      phaseLabel: t("编码", "coding"),
      elapsedMs: 188000,
      phaseMs: 21000,
      costUsd: 0.54,
      toolTrail: "read,grep,edit,bash,edit,bash",
      streamLine: t(
        "正在为 priceCart 补边界用例（空购物车、折扣叠加）",
        "Adding edge cases for priceCart (empty cart, stacked discounts)",
      ),
    }),
    run({
      runId: "r-ver",
      parentRunId: "r-root",
      label: "verify-checkout",
      type: "verifier",
      model: "cr-openai/gpt-5.6-sol",
      thinking: "high",
      status: "thinking",
      phaseLabel: t("思考", "thinking"),
      elapsedMs: 96000,
      phaseMs: 14000,
      costUsd: 0.47,
      streamLine: t("对照验收清单逐条核对结账链路…", "Walking the acceptance checklist for the checkout flow…"),
    }),
    run({
      runId: "r-exp",
      parentRunId: "r-root",
      label: "explore-payments",
      type: "explorer",
      model: "cr-kimi/k3-256k",
      status: "completed",
      phaseLabel: t("完成", "done"),
      elapsedMs: 58000,
      phaseMs: 0,
      costUsd: 0.12,
      toolTrail: "grep,read,read,grep",
      terminal: true,
    }),
    run({
      runId: "r-wf",
      parentRunId: "r-root",
      label: "regression-suite",
      type: "workflow",
      model: "cr-anthropic/claude-sonnet-5",
      status: "running",
      phaseLabel: t("跑测试", "running tests"),
      elapsedMs: 74000,
      phaseMs: 9000,
      costUsd: 0.21,
      toolTrail: "bash,bash,read",
      streamLine: t("工作流阶段 2/3：集成测试 38/52 通过…", "workflow stage 2/3: integration tests 38/52 passed…"),
    }),
    run({
      runId: "r-lint",
      parentRunId: "r-root",
      label: "lint-fix",
      type: "dev",
      model: "cr-kimi/k3-256k",
      status: "completed",
      phaseLabel: t("完成", "done"),
      elapsedMs: 41000,
      phaseMs: 0,
      costUsd: 0.06,
      toolTrail: "bash,edit,bash",
      terminal: true,
    }),
    run({
      runId: "r-ver0",
      parentRunId: "r-root",
      label: "verify-schema",
      type: "verifier",
      model: "cr-openai/gpt-5.6-sol",
      thinking: "high",
      status: "completed",
      phaseLabel: t("完成", "done"),
      elapsedMs: 83000,
      phaseMs: 0,
      costUsd: 0.31,
      toolTrail: "read,bash,read",
      terminal: true,
    }),
  ];
  const script = [
    { atMs: 300, event: "fleet", agentKey: "agent-alpha", data: { agentKey: "agent-alpha", runs: fleet } },
  ];
  writeFileSync(
    `${OUT}/fixtures/demo-${lang}.json`,
    JSON.stringify(
      {
        ctl: Object.fromEntries(
          agents.map((a) => [a.agentKey, { epoch: a.epoch, sessionId: a.session.sessionId, items: [] }]),
        ),
        hubState: {
          caps: ["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1", "cmd.v1", "dialog.v1", "command.v1", "ctl.v2"],
          state: "running",
        },
        agents,
        history,
        script,
      },
      null,
      1,
    ),
  );
}
