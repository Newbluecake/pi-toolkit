/**
 * #12 legacy-dir（plan §3.3）：默认路径 `homedir()/.pi/agent/records/traffic.db`（#54 起跟随
 * PI_CODING_AGENT_DIR 的根目录规则，未设变量时与该公式逐字节一致）；旧 `dumps/` 不再自动搬迁——
 * 未迁移 / 半迁移拒绝打开并给人工步骤，绝不开空库；legacy 检测在选中的根上成对判定。
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

describe("legacy-dir 检测", () => {
  const P = () => defaultRecordPaths();

  it("两者皆无 ⇒ 正常新建", () => {
    expect(detectLegacyLayout(P().dbPath, P().legacyDbPath)).toBeNull();
    const db = openDb(P().dbPath);
    db.close();
    expect(existsSync(P().dbPath)).toBe(true);
  });

  it("records 不存在而 dumps/traffic.db 存在 ⇒ 拒绝（未迁移），给人工步骤，不创建 records 目录 / 空库", async () => {
    mkdirSync(join(home, ".pi", "agent", "dumps"), { recursive: true });
    seed(P().legacyDbPath, "legacy");
    expect(() => openDb(P().dbPath)).toThrow(LegacyLayoutError);
    try {
      openDb(P().dbPath);
    } catch (err) {
      expect((err as LegacyLayoutError).code).toBe("E_LEGACY_UNMIGRATED");
      expect(String(err)).toContain("wal_checkpoint(TRUNCATE)");
      expect(String(err)).toContain("关闭所有 pi");
    }
    expect(existsSync(join(home, ".pi", "agent", "records"))).toBe(false);
    // 经命令同样拒绝（只本命令失败）。
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true });
    const c = ctx();
    await command()("on", c);
    expect(c.notes.join("\n")).toContain("不再自动搬迁");
    expect(peekEngine()).toBeUndefined();
    expect(existsSync(join(home, ".pi", "agent", "records"))).toBe(false);
  });

  it("records 不存在、dumps 只剩非空 -wal ⇒ 拒绝（状态不完整）", () => {
    mkdirSync(join(home, ".pi", "agent", "dumps"), { recursive: true });
    writeFileSync(`${P().legacyDbPath}-wal`, "x");
    const refusal = detectLegacyLayout(P().dbPath, P().legacyDbPath);
    expect(refusal?.code).toBe("E_LEGACY_HALF_MIGRATED");
    expect(() => openDb(P().dbPath)).toThrow(/WAL/);
  });

  it("records 存在且 dumps 仍有 traffic.db ⇒ 半迁移，拒绝打开", () => {
    mkdirSync(join(home, ".pi", "agent", "records"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "dumps"), { recursive: true });
    seed(P().dbPath, "new");
    seed(P().legacyDbPath, "old");
    const refusal = detectLegacyLayout(P().dbPath, P().legacyDbPath);
    expect(refusal?.code).toBe("E_LEGACY_HALF_MIGRATED");
    expect(() => openDb(P().dbPath)).toThrow(/半迁移/);
  });

  it("records 存在且 dumps 只剩非空 -wal（主库已搬走、WAL 未 checkpoint）⇒ 半迁移，拒绝（不静默打开缺 WAL 的库）", () => {
    mkdirSync(join(home, ".pi", "agent", "records"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "dumps"), { recursive: true });
    seed(P().dbPath, "new");
    writeFileSync(`${P().legacyDbPath}-wal`, "uncheckpointed");
    expect(() => openDb(P().dbPath)).toThrow(/非空 traffic\.db-wal/);
  });

  it("records 存在、dumps 只有空 -wal / -shm（checkpoint 已完成的残留）⇒ 正常打开", () => {
    mkdirSync(join(home, ".pi", "agent", "records"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "dumps"), { recursive: true });
    seed(P().dbPath, "new");
    writeFileSync(`${P().legacyDbPath}-wal`, "");
    writeFileSync(`${P().legacyDbPath}-shm`, "");
    const db = openDb(P().dbPath);
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "new" }]);
    db.close();
    // 检测是只读的：旧目录原样保留。
    expect(readdirSync(join(home, ".pi", "agent", "dumps")).sort()).toEqual(["traffic.db-shm", "traffic.db-wal"]);
  });

  it("非默认 dbPath（测试注入）不检测默认 dumps/", () => {
    mkdirSync(join(home, ".pi", "agent", "dumps"), { recursive: true });
    seed(P().legacyDbPath, "legacy");
    const db = openDb(join(home, "custom.db"));
    db.close();
    expect(existsSync(join(home, "custom.db"))).toBe(true);
  });
});
