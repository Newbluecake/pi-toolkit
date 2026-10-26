/**
 * #54 T-TR1：traffic.db 根目录选择（plan §3.5）——跟随 PI_CODING_AGENT_DIR：
 * P 有库 ⇒ P；否则 H 有库 ⇒ 继承 H；外部 recorder 仍装着 ⇒ 固定 H；都没有 ⇒ P。
 * 未设 / 默认等价时与改动前字面公式恒等且零 fs 探测（T-ID1 的 traffic 部分）。
 * legacy dumps/ 检测始终在选中的根上成对判定；/record status 数据库行带来源后缀（默认时无后缀）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRecordPaths, LegacyLayoutError, openDb, type RecordPathOptions } from "../../src/traffic/db.js";
import { createTrafficEngine, peekEngine } from "../../src/traffic/engine.js";
import { wireTraffic } from "../../src/traffic/index.js";
import { teardownEngine } from "./helpers/engine.js";

const HOME = "/home/t";
const H = join(HOME, ".pi", "agent");
const P = join(HOME, "custom-agent");

const base: RecordPathOptions = { home: HOME, env: { PI_CODING_AGENT_DIR: P } };

function withExisting(existing: string[]): (path: string) => boolean {
  const set = new Set(existing);
  return (path) => set.has(path);
}

function mustNotProbe(): boolean {
  throw new Error("default 分支不得做任何 fs 探测");
}

describe("T-TR1 根目录五分支（纯函数，注入 home/env/exists）", () => {
  it("未设 / 空串 / 默认等价 ⇒ default，逐字节等于旧固定公式，且零 fs 探测（T-ID1）", () => {
    const envs: Array<Record<string, string>> = [
      {},
      { PI_CODING_AGENT_DIR: "" },
      { PI_CODING_AGENT_DIR: "~/.pi/agent" },
      { PI_CODING_AGENT_DIR: H },
      { PI_CODING_AGENT_DIR: `${H}/` },
    ];
    for (const env of envs) {
      const paths = defaultRecordPaths({ home: HOME, env, exists: mustNotProbe });
      expect(paths).toEqual({
        root: H,
        source: "default",
        recordDir: join(H, "records"),
        dbPath: join(H, "records", "traffic.db"),
        legacyDir: join(H, "dumps"),
        legacyDbPath: join(H, "dumps", "traffic.db"),
      });
    }
  });

  it("外部 recorder 仍装着 + 默认等价变量 ⇒ 仍是 default（未设变量时逐字节不变优先，零探测）", () => {
    const paths = defaultRecordPaths({ home: HOME, env: {}, externalRecorder: true, exists: mustNotProbe });
    expect(paths.source).toBe("default");
    expect(paths.dbPath).toBe(join(H, "records", "traffic.db"));
  });

  it("P 有 records/traffic.db ⇒ agentDir", () => {
    const paths = defaultRecordPaths({ ...base, exists: withExisting([join(P, "records", "traffic.db")]) });
    expect(paths).toEqual({
      root: P,
      source: "agentDir",
      recordDir: join(P, "records"),
      dbPath: join(P, "records", "traffic.db"),
      legacyDir: join(P, "dumps"),
      legacyDbPath: join(P, "dumps", "traffic.db"),
    });
  });

  it("P 只有 dumps/ 目录也算有库 ⇒ agentDir（legacy 检测必须在同一个根上判）", () => {
    const paths = defaultRecordPaths({ ...base, exists: withExisting([join(P, "dumps")]) });
    expect(paths.root).toBe(P);
    expect(paths.source).toBe("agentDir");
  });

  it("P 与 H 都有 records/traffic.db ⇒ P 优先（has(P) 先于 has(H)）", () => {
    const paths = defaultRecordPaths({
      ...base,
      exists: withExisting([join(P, "records", "traffic.db"), join(H, "records", "traffic.db")]),
    });
    expect(paths.root).toBe(P);
    expect(paths.source).toBe("agentDir");
    expect(paths.dbPath).toBe(join(P, "records", "traffic.db"));
  });

  it("P 无库、H 有 records/traffic.db ⇒ inherited（已设变量的老用户继续用原来的库）", () => {
    const paths = defaultRecordPaths({ ...base, exists: withExisting([join(H, "records", "traffic.db")]) });
    expect(paths.root).toBe(H);
    expect(paths.source).toBe("inherited");
    expect(paths.dbPath).toBe(join(H, "records", "traffic.db"));
    expect(paths.legacyDbPath).toBe(join(H, "dumps", "traffic.db"));
  });

  it("P 无库、H 只有 dumps/ 旧库 ⇒ inherited（legacy 库同样留住老用户）", () => {
    const paths = defaultRecordPaths({ ...base, exists: withExisting([join(H, "dumps")]) });
    expect(paths.root).toBe(H);
    expect(paths.source).toBe("inherited");
  });

  it("P 与 H 都没有 ⇒ agentDir（新建在 P）", () => {
    const paths = defaultRecordPaths({ ...base, exists: withExisting([]) });
    expect(paths.root).toBe(P);
    expect(paths.source).toBe("agentDir");
  });

  it("外部 recorder 仍装着 ⇒ 固定 H（external-recorder），即使 P 有库", () => {
    const paths = defaultRecordPaths({
      ...base,
      externalRecorder: true,
      exists: withExisting([join(P, "records", "traffic.db")]),
    });
    expect(paths.root).toBe(H);
    expect(paths.source).toBe("external-recorder");
  });
});

describe("T-TR1 legacy 检测在选中的根上成对判定（真实 fs 沙箱）", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-traffic-root-"));
  });
  afterEach(async () => {
    await teardownEngine(peekEngine());
    rmSync(home, { recursive: true, force: true });
  });

  it("P 下只有 dumps/ 旧库 ⇒ 选 P，engine 的 legacy 指向 P/dumps 并拒绝打开（不碰 H）", async () => {
    const agent = join(home, "agent2");
    mkdirSync(join(agent, "dumps"), { recursive: true });
    writeFileSync(join(agent, "dumps", "traffic.db"), "x");
    const paths = defaultRecordPaths({ home, env: { PI_CODING_AGENT_DIR: agent } });
    expect(paths.source).toBe("agentDir");
    const engine = createTrafficEngine({ recordPaths: paths });
    expect(engine.dbPath).toBe(join(agent, "records", "traffic.db"));
    expect(engine.legacyDbPath).toBe(join(agent, "dumps", "traffic.db"));
    // 拒绝发生在加载 node:sqlite 之前；检测只读 stat，不创建 records/ 或空库。
    expect(() => openDb(engine.dbPath, { legacyDbPath: engine.legacyDbPath })).toThrow(LegacyLayoutError);
    expect(existsSync(join(agent, "records"))).toBe(false);
    expect(existsSync(join(home, ".pi"))).toBe(false);
    await engine.close("test");
  });

  it("P 空、H 只有 dumps/ 旧库 ⇒ inherited，legacy 指向 H/dumps 并拒绝打开", async () => {
    const agent = join(home, "agent2");
    const dumps = join(home, ".pi", "agent", "dumps");
    mkdirSync(dumps, { recursive: true });
    writeFileSync(join(dumps, "traffic.db"), "x");
    const paths = defaultRecordPaths({ home, env: { PI_CODING_AGENT_DIR: agent } });
    expect(paths.source).toBe("inherited");
    const engine = createTrafficEngine({ recordPaths: paths });
    expect(engine.dbPath).toBe(join(home, ".pi", "agent", "records", "traffic.db"));
    expect(engine.legacyDbPath).toBe(join(dumps, "traffic.db"));
    expect(() => openDb(engine.dbPath, { legacyDbPath: engine.legacyDbPath })).toThrow(LegacyLayoutError);
    expect(existsSync(agent)).toBe(false);
    await engine.close("test");
  });
});

describe("T-TR1 /record status 数据库行后缀", () => {
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

  function seed(path: string): void {
    const db = openDb(path, { legacyDbPath: null });
    db.close();
  }

  /** 数据库行（按行匹配，不依赖 sqlite 新库的实际大小）。 */
  function dbLine(text: string): string {
    return text.split("\n").find((line) => line.startsWith("数据库: ")) ?? "";
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-traffic-status-"));
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

  it("默认（未设变量）⇒ H 路径，无后缀（输出与改动前一致）", async () => {
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true });
    const c = ctx();
    await command()("status", c);
    const text = c.notes.join("\n");
    expect(dbLine(text)).toMatch(/^数据库: .+ \([\d.]+ KB\)$/);
    expect(dbLine(text)).toContain(join(home, ".pi", "agent", "records", "traffic.db"));
    expect(text).not.toContain("（agentDir）");
    expect(text).not.toContain("（继承 ~/.pi/agent）");
    expect(text).not.toContain("（外部 recorder 共用 ~/.pi/agent）");
    expect(peekEngine()).toBeUndefined();
  });

  it("P 空、H 有库 ⇒ 继承 H，数据库行带（继承 ~/.pi/agent）", async () => {
    seed(join(home, ".pi", "agent", "records", "traffic.db"));
    process.env.PI_CODING_AGENT_DIR = join(home, "agent2");
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true });
    const c = ctx();
    await command()("status", c);
    const text = c.notes.join("\n");
    const line = dbLine(text);
    expect(line.startsWith(`数据库: ${join(home, ".pi", "agent", "records", "traffic.db")} (`)).toBe(true);
    expect(line.endsWith("（继承 ~/.pi/agent）")).toBe(true);
    expect(existsSync(join(home, "agent2"))).toBe(false);
    expect(peekEngine()).toBeUndefined();
  });

  it("P 与 H 都没有库 ⇒ 新建在 P，数据库行带（agentDir）", async () => {
    const agent = join(home, "agent2");
    process.env.PI_CODING_AGENT_DIR = agent;
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true });
    const c = ctx();
    await command()("status", c);
    const text = c.notes.join("\n");
    const line = dbLine(text);
    expect(line.startsWith(`数据库: ${join(agent, "records", "traffic.db")} (`)).toBe(true);
    expect(line.endsWith("（agentDir）")).toBe(true);
    expect(existsSync(join(agent, "records", "traffic.db"))).toBe(true);
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(peekEngine()).toBeUndefined();
  });

  it("外部 recorder 仍装着 ⇒ 钉在 H，数据库行带（外部 recorder 共用 ~/.pi/agent）", async () => {
    const agent = join(home, "agent2");
    seed(join(agent, "records", "traffic.db")); // P 有库也被 externalRecorder 压过
    process.env.PI_CODING_AGENT_DIR = agent;
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true, externalRecorder: true });
    const c = ctx();
    await command()("status", c);
    const text = c.notes.join("\n");
    const line = dbLine(text);
    expect(line.startsWith(`数据库: ${join(home, ".pi", "agent", "records", "traffic.db")} (`)).toBe(true);
    expect(line.endsWith("（外部 recorder 共用 ~/.pi/agent）")).toBe(true);
    expect(peekEngine()).toBeUndefined();
  });

  it("注入 dbPath 的调用不带后缀（测试注入路径不参与根目录来源标注）", async () => {
    process.env.PI_CODING_AGENT_DIR = join(home, "agent2");
    const injected = join(home, "injected", "traffic.db");
    const { pi, command } = fakePi();
    wireTraffic(pi, { enabled: true, dbPath: injected, legacyDbPath: null });
    const c = ctx();
    await command()("status", c);
    const text = c.notes.join("\n");
    expect(dbLine(text).startsWith(`数据库: ${injected} (`)).toBe(true);
    expect(text).not.toContain("（agentDir）");
    expect(peekEngine()).toBeUndefined();
  });
});
