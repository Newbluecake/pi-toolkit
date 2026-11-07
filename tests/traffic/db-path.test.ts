/**
 * #12 db-path（plan §3.1 / §3.3）+ #54 §3.5：默认路径 `homedir()/.pi/agent/records/traffic.db`；
 * 设了 PI_CODING_AGENT_DIR 时按根目录规则选择（P 有库 ⇒ P；否则 H 有库 ⇒ 继承 H）。
 * 旧 `dumps/` 不再自动搬迁——未迁移 / 半迁移拒绝打开并给人工步骤，绝不开空库。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LegacyLayoutError,
  defaultRecordPaths,
  detectLegacyLayout,
  openDb,
  SqliteUnavailableError,
} from "../../src/traffic/db.js";
import { peekEngine } from "../../src/traffic/engine.js";
import { wireTraffic } from "../../src/traffic/index.js";
import { teardownEngine } from "./helpers/engine.js";

let home: string;
const savedHome = process.env.HOME;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function fakePi() {
  let command!: (args: string, ctx: any) => Promise<void>;
  const pi = {
    on: () => undefined,
    registerCommand: (_n: string, o: { handler: (args: string, ctx: any) => Promise<void> }) => {
      command = o.handler;
    },
  };
  return { pi: pi as any, command: () => command };
}

function ctx(): any {
  const notes: string[] = [];
  return {
    mode: "print",
    model: { api: "anthropic-messages", baseUrl: "https://api.example.test/v1", id: "m", provider: "p" },
    ui: { notify: (m: string) => notes.push(m) },
    sessionManager: { getSessionId: () => "s" },
    cwd: process.cwd(),
    notes,
  };
}

function seed(path: string, sessionId: string): void {
  const db = openDb(path, { legacyDbPath: null });
  db.prepare("INSERT INTO sessions (id, started_at, last_seen) VALUES (?, 't', 't')").run(sessionId);
  db.prepare(
    "INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at) VALUES ('keep', 1, 1, '.', 't', 't')",
  ).run();
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-traffic-home-"));
  process.env.HOME = home;
});

afterEach(async () => {
  await teardownEngine(peekEngine());
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(home, { recursive: true, force: true });
});

describe("db-path", () => {
  it("默认路径调用时计算 = homedir()/.pi/agent/records/traffic.db", () => {
    const paths = defaultRecordPaths();
    expect(paths.root).toBe(join(home, ".pi", "agent"));
    expect(paths.source).toBe("default");
    expect(paths.dbPath).toBe(join(home, ".pi", "agent", "records", "traffic.db"));
    expect(paths.legacyDbPath).toBe(join(home, ".pi", "agent", "dumps", "traffic.db"));
  });

  it("非默认 PI_CODING_AGENT_DIR 且 P 无库 ⇒ 继承 H 的库（inherited）：历史、规则、计数可读", async () => {
    const paths = defaultRecordPaths();
    mkdirSync(join(home, ".pi", "agent", "records"), { recursive: true });
    seed(paths.dbPath, "old-session");
    const otherAgent = join(home, "elsewhere-agent");
    process.env.PI_CODING_AGENT_DIR = otherAgent;
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true }); // 无 dbPath 注入：走默认路径
    const c = ctx();
    await command()("status", c);
    const text = c.notes.join("\n");
    expect(text).toContain(paths.dbPath);
    expect(text).toContain("（继承 ~/.pi/agent）");
    expect(text).toContain("0 请求 / 0 消息 / 1 会话");
    expect(text).toContain("改写规则: 1 启用 / 1 总计");
    expect(existsSync(otherAgent)).toBe(false);
    // status 是短连接：不建容器 engine。
    expect(peekEngine()).toBeUndefined();
  });

  it("node:sqlite 不可用 ⇒ 只本命令失败，给出 Node 版本提示；不留 engine / wrapper", async () => {
    const native = globalThis.fetch;
    const { pi, command } = fakePi();
    const loadSqlite = (): never => {
      throw new SqliteUnavailableError(new Error("no sqlite"));
    };
    wireTraffic(pi, { enabled: true, dbPath: join(home, "t.db"), legacyDbPath: null, loadSqlite });
    const c = ctx();
    await command()("on", c);
    expect(c.notes.join("\n")).toMatch(/Node ≥22\.13/);
    expect(peekEngine()).toBeUndefined();
    expect(globalThis.fetch).toBe(native);
    expect(existsSync(join(home, "t.db"))).toBe(false);
  });
});
