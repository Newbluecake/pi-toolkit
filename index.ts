/**
 * pi 唯一入口（package.json `pi.extensions: ["./index.ts"]`）。
 *
 * 两条路径（startup-bundle plan r3 §3.1/§3.2）：
 *   - 有 `dist/bundle/index.js` ⇒ 先装宿主模块解析钩子，再原生 import 单文件 bundle（~1 s）；
 *   - 无（git 安装 / 未构建）或 `PI_TOOLKIT_ENTRY=src` ⇒ 转发 `./src/index.ts`（慢但正确，现状语义）。
 *
 * 不可变项（改动前先读 docs/dev/startup-bundle/plan.md）：
 *   - 默认导出仍是 `activate(pi)`，返回 Promise<void>；
 *   - 本文件**没有**来自 `./src/**` 的静态值依赖：静态边会实例化整棵源码图，bundle 路径就白跑了。
 *     所以连 bundle 判定逻辑也是 `activate` 内的一次动态 import（两个小文件，不是业务图）；
 *   - 位置不动 ⇒ pi 资源表显示名不变；
 *   - 只保留 `export default`：任何命名 re-export 都是静态边（评审 Blocker 1）。命名导出在
 *     `src/index.ts` 层继续存在，那里才是对外契约。
 *
 * 错误约定：`existsSync` 为假才走源码；bundle 存在但加载失败 ⇒ 抛错，绝不静默降级。
 * 逃生阀：`PI_TOOLKIT_ENTRY=src pi`（见 plan §6.1.2，settings.json 无法设置它）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 动态 import 的源码入口。字面量 ⇒ 类型可解析；jiti 把 `.js` 后缀解析到 `.ts`。 */
const SOURCE_ENTRY = "./src/index.js";

export default async function activate(pi: ExtensionAPI): Promise<void> {
  // 只在 activate 里求值：保持本文件的静态图为零（见文件头）。
  const entry = await import("./src/core/bundle-entry.js");

  /** 源码路径：现状语义，逐字节不变。 */
  const runSource = async (): Promise<void> => {
    const source = await import(SOURCE_ENTRY);
    await source.default(pi);
  };

  if (entry.sourceEntryForced()) return runSource();
  if (!entry.bundleAvailable()) return runSource();

  const hooks = entry.installBundleHooks();
  if (!hooks.installed && hooks.reason !== undefined && !hooks.reason.includes("already installed")) {
    // 无 registerHooks（Node < 22.15）：慢路径，但功能完整 ⇒ 降级 + 留痕（plan §3.3.2 #4）。
    if (hooks.reason.includes("registerHooks is unavailable")) {
      console.warn(`[pi-subagent] ${hooks.reason}; falling back to the TypeScript source entry`);
      return runSource();
    }
    // 宿主模块解析不出来 ⇒ bundle 不可用。宁可不启动也不半重定向（§3.3.2 #3）。
    throw new Error(`[pi-subagent] cannot pin host modules for the bundle: ${hooks.reason}`);
  }

  // 计算式 specifier：干净 checkout 没有 dist/，字面量会让 typecheck 报 TS2307（plan §3.6）。
  const bundleUrl: string = entry.bundleUrl();
  const bundle = await import(bundleUrl);
  await entry.pickBundleFactory(bundle)(pi);
}
