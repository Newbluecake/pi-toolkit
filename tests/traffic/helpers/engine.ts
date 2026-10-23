/**
 * traffic 测试夹具：每个用例一个独立 engine（T2a：无模块级状态，engine 持有全部运行时状态）。
 */
import { join } from "node:path";
import { resetTrafficGlobalForTest, peekTrafficGlobal } from "../../../src/traffic/container.js";
import { createTrafficEngine, type CreateEngineOptions, type TrafficEngine } from "../../../src/traffic/engine.js";
import { retireTap } from "../../../src/traffic/tap.js";

export function makeEngine(dir: string, opts: CreateEngineOptions = {}): TrafficEngine {
  return createTrafficEngine({
    dbPath: join(dir, "traffic.db"),
    legacyDbPath: null,
    role: "host",
    mode: "tui",
    ...opts,
  });
}

/** 关闭 engine、退役 tap、删除进程容器（还原 globalThis.fetch 由 tap 退役负责）。 */
export async function teardownEngine(engine: TrafficEngine | undefined): Promise<void> {
  if (engine) {
    retireTap(engine);
    await engine.close("test-teardown");
  }
  const g = peekTrafficGlobal();
  if (g?.engine) await g.engine.close("test-teardown");
  resetTrafficGlobalForTest();
}
