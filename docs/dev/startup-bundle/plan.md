# 单体 bundle 根治 pi 启动加载慢（startup-bundle）

> 状态：设计定稿 **r3**（r2 吸收评审 r_65MKCAXW 的 8 条；r3 吸收复审残留 5 条 + 用户拍板的
> 「本机 local-path 也走 bundle」与陈旧检测）。处置见 §9。范围：包入口形态 + 构建产物 + 外部模块身份 +
> 新鲜度检测 + 分发与门禁。
> 前置实测：pi 对所有扩展统一 `jiti.import`，慢因是 jiti 逐模块探测解析（643 文件、约 24 万次 `statSync`
> \+ `NodeError` 构造），activate 本体仅 43ms；懒加载已被 Spike 证伪（微任务瀑布宏任务零让出）。

---

## 1. 背景与目标

### 1.1 问题

`pi.extensions` → `./index.ts`（TS 源），pi 用 jiti 逐模块加载。本仓 `src/index.ts` 的静态值导入
闭包是 **643 文件 / 8.5 MB**，pi 启动时把这些文件全部走一遍 jiti 的解析/探测/转换路径，
实测 **9.9–11.6 s**（§2.4），其中与功能无关的模块图加载占绝大部分。

已排除的路径（不再讨论）：

| 方向                              | 结论                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 让 pi 原生加载 dist JS            | pi 对**所有**扩展路径一视同仁 `jiti.import(extensionPath, { default: true })`（`loader.js:480-484`），无「已是 JS 就放行」的分派 |
| 懒加载 / `void import()` 后台求值 | Spike 实测 jiti 微任务瀑布**宏任务零让出**，总 CPU 不减，首回合更糟                                                              |
| off 裁掉静态图                    | 用户实际配置几乎全开，收益≈0                                                                                                     |
| 上游修 jiti 解析                  | 不在本仓可控范围                                                                                                                 |
| bundle 改名 `.ts` 让 jiti 转换    | **实测否决**：4.6 MB 单文件过 jiti 转换+alias 仍要 10.2–11.5 s（§2.4），收益归零                                                 |

### 1.2 目标

| 指标                                                   | 现状（实测） | 目标                    | 实测可达                                                           |
| ------------------------------------------------------ | ------------ | ----------------------- | ------------------------------------------------------------------ |
| 经真实 pi loader 的模块加载 + activate（热 jiti 缓存） | 9.9–11.6 s   | ≤ 1.5 s                 | **1.03–1.14 s**（dispatcher + 解析钩子，§2.4）                     |
| 对外可见行为                                           | —            | 逐字节不变              | 待 §7 三路径 7 profile 验收证明                                    |
| 宿主模块身份（`instanceof` / schema）                  | 与宿主同一份 | 不得分裂                | `registerHooks` 方案实测 `Container`/`Type` 均 === 宿主（§2.4 E5） |
| 构建耗时                                               | —            | ≤ 5 s                   | **0.17 s**                                                         |
| 构建可复现                                             | —            | 两次构建 byte-identical | 是（同 sha256）                                                    |

### 1.3 约束（来自 AGENTS.md，不可违反）

- **I2 assembly only**：`src/index.ts` 只做注册；本方案不改其内容。
- **I4 无模块级可变状态**：新增的根目录解析不得用模块级 memo 缓存（`/reload` 同进程重激活）。
- **I8 pi-free 边界**：`src/core/*` 不得 import pi；**`src/web-hub/{protocol,hub}/**` 只能 import
  `node:*`、`@sinclair/typebox(/...)` 和留在 `{protocol,hub}` 内的相对路径**（`tests/web-hub/boundary.test.ts`）。
  ⇒ 任何 `protocol/` 代码**不得**值导入 `src/core/*`，必须走镜像（§3.4）。
- **I9 off ⇒ byte-identical** / **I11 secure 强制关闭**：只改「谁被求值」，不改任何 gate 判断。
- **零 runtime dependencies**：esbuild 只能进 `devDependencies`。
- 三种安装形态都要能跑且**身份正确**：release zip（含 `dist/`，无 `node_modules`）、git 安装
  （无 `dist/`）、**local-path 安装（源码目录就地生效，`node_modules/` 里有一套 dev peers）**。
- **（用户拍板 2026-11-03）只要 bundle 存在就走 bundle，local-path 也在内**——本机开发也享受提速；
  配套「改源码未重建 ⇒ 跑旧代码」的启动告警（§6.1.1），不静默。

---

## 2. 现状摘要

### 2.1 入口与构建现状（文件坐标）

| 坐标                                           | 现状                                                                      | 对本方案的意义                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json` `pi.extensions: ["./index.ts"]` | pi 唯一入口，TS 源                                                        | **必须保留**（`.js` 入口无法回落 TS 源，§2.4 E2）                                                                                          |
| `index.ts`（包根）                             | `export * from "./src/index.js"` + `export { default }`                   | 位置决定 pi 资源列表显示名（`createExtension` 用 `dirname(resolvedPath)` 的 basename）。**`export *` 是静态边**，bundle 化后必须删（§3.2） |
| `index.js`（包根）                             | `export * from "./dist/index.js"`，给纯 Node 消费者；pi 从不读            | 与 `pi.extensions` 无关，原样保留                                                                                                          |
| `tsconfig.build.json`                          | tsc 7 → `dist/`（逐文件）                                                 | 保留；npm 消费者仍用它                                                                                                                     |
| `scripts/release/package.sh:36`                | `cp -r dist "$STAGE_DIR/dist"`                                            | bundle 落进 `dist/` 即自动进 release zip                                                                                                   |
| `package.json` `files`                         | 含 `"dist"`                                                               | **仅对 npm pack 有效**；对 local-path / git 安装不参与（§2.2）                                                                             |
| `.gitignore`                                   | `dist/` 忽略                                                              | 影响分发选项（§5 D3）                                                                                                                      |
| `tests/governance/activate-trace.json`         | 冻结契约（注册顺序 + phase2 外部调用）                                    | **7 个 profile**（非 5）：`default`/`minimal`/`max`/`child`/`compat-failure`/`thread-main`/`thread-child`                                  |
| `tests/helpers/activation-trace.ts`            | `traceActivation(activate, opts)`，**同步调用 `activate(pi)` 且不 await** | 无法录制异步 dispatcher；需可 await 的接缝（§3.7）                                                                                         |
| `src/web-hub/agent/launcher.ts:48`             | `createRequire(fromPackageJson).resolve(req)`，`argv1` 作锚点             | 解析宿主模块的**既有模式**，本方案复用（§3.3）                                                                                             |

### 2.2 三种安装形态的真实机制（评审第 5 条修正）

| 形态                                                            | pi 的实际动作（坐标）                                                                                                                                         | 包内有什么                                     | dev peers 可见？                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| **local-path**（本机现状：`packages: ["../../ai/pi-toolkit"]`） | `parseSource` 判定 `isLocalPath` ⇒ `{type:"local", path: source}`（`package-manager.js:1183-1185`），**直接解析原目录，不做 npm install**，`files` 完全不参与 | 仓库目录本体（含 `node_modules/`、`dist/`）    | **是** ⇒ `@earendil-works/pi-*`、`@sinclair/typebox` 各有一份仓库副本 |
| **git 安装**                                                    | `npm install --omit=dev --legacy-peer-deps`（`package-manager.js:1483-1499`）                                                                                 | 仓库快照，无 `dist/`（不跑 build），无 devDeps | 否                                                                    |
| **release zip / npm pack**                                      | 解包到独立目录                                                                                                                                                | `dist/`（含 bundle）+ `src/` + `skills/`       | 否（零 runtime deps）                                                 |

**实测补充**：git 安装的 `prepare` 脚本**会执行**，但执行时 `node_modules/esbuild` 不存在
（探测结果为 `false`）⇒ 「git 装时自动 build」不可行（§5 D3）。

> **结论**：**local-path 是本机主场景，且是唯一有本地 peers 副本的形态** ⇒ 「bundle 的 bare import
> 被 Node 原生解析到仓库副本」不是边缘情况，而是默认情况（评审第 3 条，§2.4 E4）。

### 2.3 方案可行性的实测证据

环境：Node v22.22.1（`typeof module.registerHooks === "function"`），pi 1.4.0（npm 安装版，
`dist/` 形态 ⇒ `isTypeScriptSourceRuntime=false` ⇒ jiti 用 `alias: getAliases()`）。

| 实验                                                                       | 结果                                                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 打包 `src/index.ts`                                                        | 643 个输入**全部是 `src/`**（零 node_modules 混入）；4,663,799 B；`--minify --keep-names` 2,678,191 B；构建 **0.17 s**；两次构建 sha256 相同 |
| 打包后残留动态 import                                                      | **0**（`memory/tidy` 的 `await import("./apply.js")` 已内联）                                                                                |
| `.js` bundle 经真实 loader（无本地 peers 的隔离目录）                      | 0 错误，**850–930 ms**；`Container`/`Type` === 宿主                                                                                          |
| `.js` bundle 经真实 loader（**有本地 peers**：仓库目录 / local-path 安装） | 0 错误、**850 ms**，但 `Container`/`Type` **≠ 宿主**（拿到仓库副本）                                                                         |
| `.ts` 命名的 bundle（让 jiti 转换）                                        | identity 正确，但 **10.2–11.5 s**（4.6 MB 与 2.7 MB 版几乎同耗时）⇒ 收益归零                                                                 |
| `registerHooks` 把 bare specifier 重定向到宿主副本后加载 `.js` bundle      | 0 错误、**1032–1140 ms**，`Container` === 宿主                                                                                               |
| src 路径的 identity 基线                                                   | `Container` === 宿主；`Type` === 宿主（jiti alias 生效）                                                                                     |
| `traceActivation` 是否 await                                               | **否**（源码 `activate(pi);` 无 await）⇒ 异步入口录不到任何 call                                                                             |

### 2.4 「external」不等于「走 jiti alias」（评审第 3 条，本轮新证据）

这是本方案**最关键的新认知**：

- 当前 `src/*.ts` 路径：jiti 必然转换 TS ⇒ **所有** bare specifier 都由 jiti 的 `alias: getAliases()`
  重写到宿主副本 ⇒ identity 天然正确。
- bundle `.js` 路径：jiti 先尝试 native import（`type: module` 的 `.js` 可被原生加载）⇒ **成功即接管**，
  之后该模块图里的 bare specifier 全部由 **Node 原生解析**，从 bundle 所在目录向上找 `node_modules`
  ⇒ local-path 形态下找到**仓库副本**。

实测数值（同一进程内用宿主 `require` 结果作参照）：

| 加载形态                                          | 耗时        | `Container === 宿主` | `Type === 宿主`             |
| ------------------------------------------------- | ----------- | -------------------- | --------------------------- |
| `src/index.ts`（现状，jiti alias）                | 9.9–11.6 s  | ✅                   | ✅                          |
| `dist/bundle/index.js`（`.js`，**有**本地 peers） | 0.85 s      | ❌                   | ❌                          |
| `dist/bundle/index.js`（`.js`，**无**本地 peers） | 0.85–0.93 s | ✅                   | ✅                          |
| `dist/bundle/index.ts`（jiti 转换）               | 10.2–11.5 s | ✅                   | ✅                          |
| `.js` bundle + `registerHooks` 重定向（§3.3）     | 1.03–1.14 s | ✅                   | ✅（映射按宿主 alias 口径） |

风险后果（不是理论问题）：仓库 devDep 是 `@sinclair/typebox@0.34.52`，宿主 alias 指向 `typebox@1.3.27`
——两份 schema 语义不同；`@earendil-works/pi-tui` 的 `Container` 有 `instanceof` 判定，两份类会导致
`instanceof` 恒假。当前 `src/` 无 `constructor.name` 依赖，但 `instanceof` 依赖存在（TUI 渲染路径）。

**⇒ 结论：bundle 的 bare import 必须被显式钉到宿主副本，不能靠「native 恰好失败」。**

---

## 3. 总体设计

### 3.1 形态

```
pi.extensions ──> <pkg>/index.ts          （TS，jiti 加载，资源表显示名不变）
                     │
                     ├─ 无 dist/bundle/index.js ──> await import("./src/index.js")   ← 现状路径（慢，正确）
                     │
                     └─ 有 ──> ① 安装 bare-specifier → 宿主副本 的解析钩子
                                ② await import(<bundle 绝对 URL>)   ← 原生加载单文件，快
                                        └─> export default activate(pi)
```

- 入口仍是 `./index.ts`：实测 `.js` 引导**无法**回落 TS 源（jiti 不重写 `.js` 里的动态 specifier），
  而 `.ts` 引导两条路径都成立（§2.3）。
- bundle 用 `.js` + 原生加载（快），并用解析钩子消除 identity 分裂（§3.3）。
- bundle 内**没有**动态 import（已实测为 0），所以钩子只需覆盖 bundle 首层静态 specifier，
  代价是一次 `registerHooks` + 一次 `import`。

### 3.2 入口 `index.ts`（dispatcher）契约

```ts
/**
 * pi 唯一入口（package.json pi.extensions）。
 *
 * 不可变项：
 *   - 默认导出仍是 activate(pi)，返回 Promise<void>；
 *   - 不带任何来自 ./src/** 的静态值依赖（静态边会把整棵源码图拉回启动路径 —— 评审第 1 条）；
 *   - 位置不动 ⇒ 资源表显示名仍是 "pi-toolkit/index.ts"。
 *
 * 顺序（每步都有原因，不要合并）：
 *   1. 无 bundle ⇒ 走源码（现状语义，逐字节等价）
 *   2. 有 bundle ⇒ 先装解析钩子，再 import bundle（顺序颠倒会先加载到仓库副本）
 *
 * 错误约定：bundle 存在但加载失败 ⇒ 抛出，不静默降级（坏产物必须显式可见）。
 */
export default async function activate(pi: ExtensionAPI): Promise<void>;

/** 开发/排障逃生阀：PI_TOOLKIT_ENTRY=src 强制源码路径（与 bundle 产物无关）。 */
```

**命名导出兼容（评审第 1 条）**：

- 包根 `index.ts` 现在有 `export * from "./src/index.js"` 与
  `export { mentionAutocompleteEntries } from "./src/index.js"`（`src/index.ts:105` 也 re-export 了它）。
  两者都是**静态值边** ⇒ ESM 会实例化并求值整个 `src/index.ts` 闭包 ⇒ bundle 路径白跑（加载两套）。
- 消费者核实：`mentionAutocompleteEntries` 的唯一外部消费者是
  `tests/integration/mention-autocomplete-wiring.test.ts:5`，且它 import 的是 **`src/index.js`**（不是包根
  `index.ts`）。包根的这两个 re-export **无任何消费者**（`index.js` 仅供纯 Node `main`/`exports`）。
- ⇒ **包根 `index.ts` 只保留 `export default`**，删除 `export *` 与所有命名 re-export。
  `src/index.ts:105` 的命名导出保留（`src/` 层契约不变，测试继续用它）。
- 另核：`mentionAutocompleteEntries` 本身也不是纯函数叶子 —— `src/mention/wire.ts` 值导入了
  `../holder.js`、`./autocomplete.js`、`./mention.js`、`./session.js`。所以「从 dispatcher 静态转发它」
  无论怎么转都会拉图；只能删。

### 3.3 外部模块身份钉定（评审第 3 条 + 复审第 1 条）

在 dispatcher 里，**加载 bundle 之前**安装一次解析钩子，把 bundle 的 bare specifier 映射到**宿主**
（pi 自己的）模块副本，口径与 pi 的 `getAliases()` 一致。

#### 3.3.1 宿主锚点必须走 launcher 的三步链（复审第 1 条）

**不能**直接 `createRequire(process.argv[1])`。实测（本机 `~/.nvm/.../bin/pi` 是符号链接）：

```
argv1  = /home/bluecake/.nvm/versions/node/v22.22.1/bin/pi            ← 符号链接
real   = .../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
createRequire(argv1).resolve("@earendil-works/pi-tui")   → ❌ Cannot find module
createRequire(real).resolve("@earendil-works/pi-tui")    → ✅ .../pi-coding-agent/node_modules/.../dist/index.js
createRequire(<pi>/package.json).resolve("@earendil-works/pi-tui") → ✅ 同上
```

⇒ **复用 `src/web-hub/agent/launcher.ts` 的既有三步链**，不另写一套：

```ts
// src/core/host-modules.ts（pi-free：只用 node:fs / node:path / node:module）
// 1) realpath(argv1)                     —— 解开 bin 符号链接
// 2) findPiPackageJson(real, exists)     —— 从 real 的目录向上找
//        <dir>/@earendil-works/pi-coding-agent/package.json，或 <dir>/node_modules/@earendil-works/pi-coding-agent/package.json
// 3) createRequire(piPackageJson)        —— 以**宿主包的 package.json** 为锚点解析
export function hostRequire(argv1: string | undefined): ((spec: string) => string) | undefined;
```

`findPiPackageJson` 与 `resolveJitiCli` 里的实现**逐字复用**：本轮把 `findPiPackageJson` 从
`launcher.ts` 提到 `src/core/host-modules.ts` 并让 `launcher.ts` 改为 import 它（`launcher.ts:20` 已经在
从 `../hub/ports.js` 取类型；`src/web-hub/agent/**` **允许**值导入 `../../core/*`，实测既有 4 处，
`agent → hub` 的值导入才是禁区）。方向是 `agent → core`（单向），不新增循环。

解析失败的处理：**不静默**。`hostRequire` 返回 `undefined` ⇒ `installBundleHooks` 抛错 ⇒ 见 §6.1.2 的
显式降级开关（`PI_TOOLKIT_ENTRY=src`），而不是「猜一个能用的」。

#### 3.3.2 映射表与安装

```ts
// 伪代码骨架（实现放 src/core/bundle-entry.ts，pi-free）
const req = hostRequire(process.argv[1]);   // 见 §3.3.1：realpath → pi package.json → createRequire
const map = {
  "@earendil-works/pi-coding-agent": req.resolve("@earendil-works/pi-coding-agent"),
  "@earendil-works/pi-tui": req.resolve("@earendil-works/pi-tui"),
  "@earendil-works/pi-ai": <pi-ai compat 入口，见下条>,
  "@sinclair/typebox": req.resolve("typebox"),           // 注意：宿主 alias 指向 typebox 1.x，不是 @sinclair/typebox
  "@sinclair/typebox/value": req.resolve("typebox/value"),
};
if (typeof registerHooks === "function") {
  registerHooks({ resolve(spec, ctx, next) {
    const hit = map[spec];
    return hit ? { url: pathToFileURL(hit).href, shortCircuit: true } : next(spec, ctx);
  }});
}
```

要点（每条都有实测依据）：

1. **`@sinclair/typebox` 必须映射到 `req.resolve("typebox")`**，不是 `@sinclair/typebox`：pi 的 alias 就是
   这么写的（`loader.js:80-85`），且 `@sinclair/typebox` 在 pi 的安装树里**解析不到**（实测
   `Cannot find module`）。这正是仓库既有踩坑记录「测运行时行为要 `import "typebox"`」的同一根因。
2. **`@earendil-works/pi-ai` 走 compat 入口**（`getAliases()` 明确用它作为 pi-ai 根，是核心入口的严格超集）。
   注意 `pi-ai` 的 `exports` 里没有 `./compat` 子路径键时要用文件路径构造，不要指望 `require.resolve`。
3. **解析失败时不要静默跳过**：任一宿主模块解析不出来 ⇒ 视为 bundle 不可用 ⇒ 报错（或按 §6 的
   `PI_TOOLKIT_ENTRY=src` 显式降级），绝不「部分重定向」——那样会得到一半宿主一半仓库的混合图，
   比全错更难查。
4. **`registerHooks` 可用性**：Node 22.15+ 提供。`engines: >=22` 含更早的 22.x ⇒ 启动时探测，
   不可用则走 §6 的源码路径（**慢但正确**），并在 debug 日志留一行。**不得**改用「让它 native 解析」
   这种「恰好能用」的路径。
5. **钩子是进程级、一次性的**：`/reload` 会再次 activate ⇒ 用 `Symbol.for("pi-subagent:bundle-hooks")`
   标记已安装（I4 允许的跨激活共享方式），避免重复注册；重复注册本身无害但会累积闭包。
6. 钩子**只在 bundle 分支安装**：源码分支不装（jiti alias 已经正确），保持 off/on 边界干净。

### 3.4 `packageRoot` 的放置（评审第 2 条 + I8）

bundle 后所有模块共享同一个 `import.meta.url`，相对层级不可再用。需要一个包根解析器，
但**位置有硬约束**：

- `src/web-hub/protocol/paths.ts` 是 `src/web-hub/protocol/**`，**值导入 `src/core/*` 会让
  `tests/web-hub/boundary.test.ts` 变红**（该测试只允许 `node:*`、`@sinclair/typebox(/...)`、
  以及留在 `{protocol,hub}` 内的相对路径）。
- 仓库既有解法是**镜像**：`src/core/agent-dir.ts` ↔ `src/web-hub/protocol/agent-dir.ts`
  （后者首行注明 `// Mirror of ... — parity: tests/config/agent-dir-parity.test.ts.`，
  该 parity 测试用一张契约表同时驱动两个实现 + `src/secure/bin/helper.mjs` 的第三份实现）。

⇒ **按同一模式**：

| 文件                                       | 角色                                               | 允许的 import                      |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------- |
| `src/core/package-root.ts`                 | 权威实现（agent 侧、HUD/Feishu/secure/traffic 用） | `node:fs`、`node:path`、`node:url` |
| `src/web-hub/protocol/package-root.ts`     | 镜像（protocol/hub 侧用）                          | 同上（均在 `node:*` 白名单内）     |
| `tests/config/package-root-parity.test.ts` | 契约表驱动两份实现 + 三种布局                      | —                                  |

**契约**（两份同签名、同返回字节形态）：

```ts
/**
 * @param from 起点（默认调用方 import.meta.url）；测试注入。
 * @returns 最近祖先目录的绝对路径，**无尾斜杠**；向上最多 8 层。
 * @throws  找不到时抛错（不静默返回 cwd）。调用方按各自的既有降级语义包裹 try/catch。
 */
export function packageRoot(from?: string | URL): string;
```

锚点判定：目录内存在 `package.json` 且其 `name === "pi-toolkit"`。**不得缓存**（I4）。
边界测试**不扩 allowlist**：`protocol/package-root.ts` 落在 `{protocol,hub}` 内，零白名单改动；
`SYSLOAD_FILE_CLOSURE` 之类闭包表也不需要改（首提交必须跑 `tests/web-hub/boundary.test.ts` 为证）。

**`packageUiDistDir()` 的返回形态不得变**（评审第 7 条）：现有测试断言
`dir.endsWith("/dist/web-hub-ui/")`（`tests/web-hub/protocol/paths-trusted.test.ts:42`）⇒ 实现必须
**保留尾 `/`**，不能写成 `join(packageRoot(), "dist", "web-hub-ui")`（`join` 去尾斜杠）。
`packageRootDir()` 原本就剥尾斜杠，两函数形态不同，别合并。

**必须修的站点与降级语义**（`../..` 类从 `dist/bundle/` 出发仍等于包根，但依赖巧合，统一改掉）：

| 站点                                | 现语义                                             | 从 bundle 出发             | 处置                                             | 调用方降级语义（必须保留）             |
| ----------------------------------- | -------------------------------------------------- | -------------------------- | ------------------------------------------------ | -------------------------------------- |
| `src/feishu-notify/index.ts:54`     | 包根                                               | 巧合正确                   | `packageRoot()`                                  | `try/catch` ⇒ `""`                     |
| `src/hud/plugin-info.ts:37`         | 包根                                               | 巧合正确                   | `packageRoot()`                                  | `try/catch` ⇒ `undefined`              |
| `src/secure/command.ts:259`         | 包根                                               | 巧合正确                   | `packageRoot()`                                  | 无 try/catch（保持）                   |
| `src/traffic/dup-detect.ts:31`      | 包根                                               | 巧合正确                   | `packageRoot()`                                  | 保持                                   |
| `src/web-hub/protocol/paths.ts:180` | `<根>/dist/web-hub-ui/`（**带尾斜杠**）            | ❌ 指到包根父目录          | 镜像 `packageRoot()` + 手工补尾 `/`              | 保持                                   |
| `src/web-hub/protocol/paths.ts:189` | 包根（剥尾斜杠）                                   | ❌ 包根父目录              | 镜像 `packageRoot()`                             | 保持                                   |
| `src/web-hub/agent/index.ts:585`    | `<根>/src/web-hub/hub/main.ts`                     | ❌ `<根>/dist/hub/main.ts` | `join(packageRoot(), "src/web-hub/hub/main.ts")` | 保持（hub 起不来要报错，不静默）       |
| `src/traffic/page.ts:19-44`         | 模块同级 `web/` → `../../src/traffic/{web,vendor}` | 巧合正确                   | `join(packageRoot(), "src/traffic/...")`         | `firstExisting` 抛错并列出候选（保持） |

### 3.5 构建配置

```js
// scripts/build-bundle.mjs
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/bundle/index.js",
  bundle: true,
  format: "esm", // 必须 ESM：import.meta.url 在 CJS 下为空
  platform: "node",
  target: "node22",
  charset: "utf8",
  packages: "external", // 等价实测：与显式 external 列表产出 sha256 相同
  sourcemap: process.env.BUNDLE_SOURCEMAP === "1" ? "external" : false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});
```

- **不 minify**：实测无速度收益（887 vs 917 ms，噪声内），却牺牲栈可读性。体积 4.66 MB 可接受；
  若将来压体积用 `--minify --keep-names`（2.68 MB，已验证可行，且**仍走原生加载**）。
- **sourcemap 默认关**（12.2 MB），`BUNDLE_SOURCEMAP=1` 本地生成，不入包。
- **不拆 chunk**：单文件是收益来源；`splitting` 会把文件数拉回 N，jiti 每模块固定成本随之回来。
- **不加 `--inject` 之类的构建期绝对路径注入**：会让产物不可移植（每个安装目录路径不同）。
- 位置 `dist/bundle/`：release 与 npm 自动带上（`package.sh` 的 `cp -r dist` / `files`）。

`package.json` 增量：

```jsonc
"scripts": {
  "build:bundle": "node scripts/build-bundle.mjs",
  "build": "node node_modules/typescript-7/bin/tsc -p tsconfig.build.json && npm run build:bundle"
},
"devDependencies": { "esbuild": "0.21.5" }   // 与 vite 传递依赖同版，避免两份二进制
```

### 3.6 类型解析（评审第 6 条）

干净 checkout 下 `dist/bundle/index.js` **不存在**，且 `npm run typecheck` 在 `build` 之前跑。

- ❌ 字面量 `import("./dist/bundle/index.js")` ⇒ **实测 `TS2307: Cannot find module`**（`tsc --ignoreConfig` 复现）。
- ✅ **计算式 specifier**：`const url = new URL("./dist/bundle/index.js", import.meta.url).href; await import(url)`
  —— TS 不做模块解析，typecheck 通过；运行期 `existsSync` 已先判定存在。
  （实测该写法在 bundle 存在时正常加载；在 jiti 下**绕过 jiti** 走原生 —— 这正是我们要的，
  因为身份由 §3.3 的钩子负责。）
- 对外类型不靠预生成 `.d.ts`：dispatcher 的 `activate` 类型直接来自
  `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`（peer，类型随宿主）。
  bundle 产物本身**不需要**类型声明——它是内部实现，没有任何 TS 消费者 import 它。
- **禁止**全局 `// @ts-expect-error`、`declare module "./dist/bundle/*"`、或把 `dist` 加进 `exclude`
  来「解决」——那会把真实错误一起吞掉。

### 3.7 依赖方向与模块划分

```
bundle 内（643 个 src/ 文件，全部内联）
  ├─ src/index.ts（activate，全部子系统装配）
  ├─ src/stack.ts / src/runtime / src/service / src/core / ...
  └─ src/vendor/qrcodegen.ts（纯 TS，随包内联）

bundle 外（bare specifier —— 由 §3.3 钩子钉到宿主副本）
  ├─ @earendil-works/pi-coding-agent · pi-tui · pi-ai
  ├─ @sinclair/typebox(/value)
  └─ node:*（含 node:sqlite 的 createRequire 惰性路径）

完全不在运行时路径（无需处理）
  ├─ src/web-hub/ui/**（Vue，vite → dist/web-hub-ui/；@logic/*、@protocol/* 是 vite alias）
  ├─ src/traffic/web/**、src/traffic/vendor/**（静态资源，按文件路径读）
  └─ skills/**（pi 直读目录）

不参与 bundle
  └─ src/secure/bin/pi-secure（bash）+ helper.mjs（独立 bin）
```

新增模块（全部 pi-free、无模块级可变状态）：

| 文件                                   | 职责                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| `src/core/package-root.ts`             | 包根解析权威实现                                           |
| `src/web-hub/protocol/package-root.ts` | 协议侧镜像（I8）                                           |
| `src/core/bundle-entry.ts`             | §3.3 解析钩子安装 + bundle 探测/加载（被 `index.ts` 调用） |

---

## 4. 接口契约

### 4.1 `src/core/package-root.ts`

```ts
/**
 * @param from 起点（默认 import.meta.url）。
 * @returns 含 name === "pi-toolkit" 的 package.json 的最近祖先目录，绝对路径，无尾斜杠。
 * @throws  向上 8 层仍未找到时抛错。
 * 约束：不缓存（I4）；不 import pi；纯同步 fs（调用点都是冷路径）。
 */
export function packageRoot(from?: string | URL): string;
```

`src/web-hub/protocol/package-root.ts`：**逐字同实现**，首行注释指向 parity 测试（照 `agent-dir.ts` 模式）。

### 4.2 `src/core/bundle-entry.ts`

```ts
export interface BundleEntryDeps {
  /** 测试注入：宿主模块解析器（默认走 §3.3.1 三步链：realpath(argv1) → pi package.json → createRequire）。 */
  resolveHost?: (spec: string) => string | undefined;
  /** 测试注入：钩子安装器（默认 module.registerHooks）。 */
  installHooks?: (map: Record<string, string>) => void;
  /** 测试注入：bundle 路径探测。 */
  bundlePath?: () => string;
  /** 测试注入：argv1（默认 process.argv[1]）。 */
  argv1?: string;
}

/** 探测 bundle 是否存在（纯 fs，无副作用）。 */
export function bundleAvailable(deps?: BundleEntryDeps): boolean;

/**
 * 安装身份钉定钩子（幂等，Symbol.for("pi-subagent:bundle-hooks")）。
 * @throws 宿主模块解析失败（任一必需 specifier）—— 不静默部分重定向。
 * @returns 是否真的安装了（Node < 22.15 无 registerHooks ⇒ false）
 */
export function installBundleHooks(deps?: BundleEntryDeps): boolean;

/**
 * 加载 bundle 的 default 导出（调用方负责先 installBundleHooks）。
 * @throws 语法错误 / 加载期异常 —— **不**回落到源码（§3.2 错误约定、§7.1 断言）。
 */
export function importBundle(deps?: BundleEntryDeps): Promise<{ default: (pi: unknown) => void | Promise<void> }>;
```

### 4.3 产物契约

| 项           | 值                                                                    |
| ------------ | --------------------------------------------------------------------- |
| 路径         | `dist/bundle/index.js`（唯一文件；sourcemap 仅 `BUNDLE_SOURCEMAP=1`） |
| 格式         | ESM，`export default activate`，**内部零动态 import**                 |
| 外部依赖     | 仅 §3.7「bundle 外」三类                                              |
| 确定性       | 同输入两次构建 byte-identical（CI 断言 sha256）                       |
| 体积预算     | ≤ 6 MB（当前 4.66 MB）；超预算 CI 失败                                |
| 构建耗时预算 | ≤ 5 s（当前 0.17 s）                                                  |

---

## 5. 关键决策

### D1 入口：保留 `./index.ts` 做 dispatcher

- 备选 A（选）：`index.ts` dispatcher，`export default` only。两路径都通，`pi.extensions`/显示名不动。
- 备选 B（弃）：`pi.extensions: ["./index.js"]`。**.js 引导无法回落 TS 源**（实测 `Cannot find module`）。
- 备选 C（弃）：双条目 `["./dist/bundle/index.js", "./index.ts"]`。pi 对存在的条目**全部**加载 ⇒ 重复 activate。
- 备选 D（弃）：bundle 作唯一入口。git 安装无 `dist/` ⇒ `existsSync` 静默丢弃 ⇒ **扩展完全不加载**。

### D2 打包工具：esbuild，不 minify，不 splitting

已在依赖树（vite 传递 0.21.5），0.17 s；webpack/rollup 更慢且无收益；tsc 不做单文件。

### D3 分发策略（**维持已拍板 b**）

| 选项                             | local-path      | git 安装        | release/npm | 代价                                                       |
| -------------------------------- | --------------- | --------------- | ----------- | ---------------------------------------------------------- |
| a) bundle 入库                   | 快              | 快              | 快          | +4.7 MB/次提交；`dist/` 已 ignore 的约定被破；产物漂移风险 |
| **b) 仅构建产物（已选）**        | 本地 build 后快 | **慢（≈基线）** | 快          | git 用户无收益；本地开发有新鲜度问题（§6.1）               |
| c) git 装时 `prepare` 自动 build | —               | —               | —           | **实测不可行**：`prepare` 跑但 esbuild 不存在              |

**本次修订不改分发决策**（评审未要求重拍）。因 §3.3 的钩子，b) 的收益对 local-path 与
release 两种形态都成立；git 安装仍回落源码（正确但慢）。

### D4 身份钉定用 `registerHooks`，而不是「指望 native 失败」

- 备选 A（选）：`registerHooks` 重定向（1.03–1.14 s，identity 正确，Node 22.15+）。
- 备选 B（弃）：bundle 改 `.ts` 让 jiti 转换 ⇒ 10.2–11.5 s，收益归零。
- 备选 C（弃）：把 peers 打进 bundle（`--packages=node` 方向）⇒ 内含两份 `Container`，
  `instanceof` 恒假，且 typebox 0.34 与宿主 1.x 语义不同。
- 备选 D（弃）：靠「native 解析失败回落到 jiti alias」⇒ 只在无本地 peers 时成立；
  local-path（本机主场景）恰好有 peers ⇒ **默认失效**。

### D5 不拆包、不做构建期常量替换

拆包把 jiti 每模块固定成本带回来；`define` 掉 off 分支会让 on/off 产物不一致，破坏 I9 可证明性。

### D6 一致性门禁放 CI，不放 pre-commit

pre-commit 自动改写 `dist/` 会与 `.githooks` 的「prettier --write 后 git add 整文件」行为叠加，
易把半成品带进提交（既有踩坑）。

---

## 6. 实施要点

### 6.1 新鲜度政策：local-path 也走 bundle + 陈旧检测（用户拍板 2026-11-03）（**告警部分已于 2026-11-06 撤销**，见下）

#### 6.1.1 决策与机制

**（用户拍板）只要有 `dist/bundle/index.js` 就走 bundle，local-path 安装也在内**——本机日常开发同样
享受 ~1 s 启动。代价是「改了 `src/` 但没重建 ⇒ 跑旧代码」，原设计曾配套陈旧检测与告警（**历史设计，已撤销**），
不能静默。

**陈旧判定**（`src/core/bundle-entry.ts` 的 `staleness()`，纯 fs、无缓存、不阻塞）：

```ts
export interface Staleness {
  readonly state: "fresh" | "stale" | "unknown";
  readonly bundleMtimeMs: number;
  readonly newestSrcMtimeMs: number;
  readonly newestSrcPath: string;
}
/**
 * 比较 `dist/bundle/index.js` 的 mtime 与 `src/**/*.ts` 的最新 mtime。
 * - 无 bundle ⇒ "unknown"（调用方走源码分支，无需告警）
 * - 无 src（release/npm 安装）⇒ "fresh"（无源可比，产物即唯一真源）
 * - src 更新 ⇒ "stale"
 * 成本：实测 1078 个 .ts 文件 glob + statSync ≈ 28–33 ms（3 次样本），相对 1 s 启动可接受；
 * 只统计 **.ts**（bundle 的输入就是 TS 源；skills/、web 静态资源不参与编译）。
 */
export function staleness(deps?: BundleEntryDeps): Staleness;
```

**告警形态**（复用仓库既有 stderr 标记，见 `src/index.ts:404`/`src/stack.ts:443` 的
`console.warn(\`[pi-subagent] ...\`)`）：

```
[pi-subagent] bundle is stale (src updated 2026-11-03T07:12:44Z > bundle built 2026-11-03T06:29:08Z);
               running OLD code — run `npm run build:bundle` (or set PI_TOOLKIT_ENTRY=src)
```

- **（2026-11-06 用户令：启动期陈旧告警已移除）** `index.ts` 不再调用 `staleness()`/`staleWarning()`、不再 `console.warn`、不扫描源码；陈旧时仍静默用 bundle，不自动重建。helper 仍留在 `bundle-entry.ts`（`tests/core/bundle-entry.test.ts` 覆盖）。以下告警形态与 §7 的 stale 验收行为为历史设计，**不再生效**。
- ~~只 warn，不 throw、不自动重建~~：陈旧仍以旧代码运行。
- `stale` 时不改变行为（仍用 bundle）；**当前政策：无任何告警、不扫描 src**。
- src 比 bundle **旧**（常见：刚 build 完）⇒ 静默，不刷屏。
- release/npm 安装没有 `src/` 或没有 `.ts` ⇒ `"fresh"`，**零输出**（I9：off/无关形态 byte-identical）。

#### 6.1.2 `PI_TOOLKIT_ENTRY` 的唯一有效设置方式（复审第 5 条）

**它只是进程环境变量，`settings.json` 无法设置它**（`src/config/settings.ts` 只读
`PI_CODING_AGENT_DIR` 等既有的几个环境变量，没有任何「settings 里注入 env」的机制）。

因此文档只给真实可执行的两种方式：

```sh
# ① 当前 shell（一次性）
PI_TOOLKIT_ENTRY=src pi

# ② 长期（写进 shell 配置，pi 从该 shell 启动才生效）
export PI_TOOLKIT_ENTRY=src     # ~/.bashrc / ~/.zshrc
```

用途：临时绕过坏 bundle、或需要在「改了源码且不想重建」时立刻验证源码路径。
**不是**日常默认（拍板：默认走 bundle）。

#### 6.1.3 父 pi 与 hub 的新鲜度不同步（复审第 5 条，删除错误保证）

- 父 pi 进程执行的是**启动时**加载的模块图；重建 bundle **不会**影响已运行的父 pi。
- `/reload` 的实际语义（ESM 模块缓存 + `registerHooks` 已装标记共同决定它是否重读 bundle 文件）
  **本轮未实测**，因此文档不把它当作"能更新"的手段：**恢复一律以重启 pi 为准**。
  该行为列为 §7.3 的待验收项（`/reload` 行），验收结论回填本节。
- `web-hub` 的 hub 子进程按 `packageRoot()/src/web-hub/hub/main.ts` 用 jiti 启动 ⇒ 它读的是
  **当时的 `src/` 源码**，与父 pi 跑的 bundle **可能不同代**。
- **`/webhub restart` 只重启 hub 子进程**（于是 hub 拿到最新源码），**不能**让执行旧 bundle 的父 pi
  变新。原 r2 文案「restart 后一致」**是错的，已删除**。
- `self-version.ts` 只比 `package.json` 的 **version 字符串**，**不识别同版本的源码改动** ⇒ 它
  **不能**用来判定 bundle 是否陈旧；陈旧判定只有 §6.1.1 的 mtime 比较。

⇒ **恢复步骤（各自独立，写清给运维）**：

| 想要                   | 操作                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 父 pi 用上新代码       | `npm run build:bundle` 后**重启 pi**（不依赖 `/reload`，其重读语义未实测）；或 `PI_TOOLKIT_ENTRY=src` 重启             |
| hub 用上新源码         | `/webhub restart`（hub 本来就 jiti 读源码，不需重建）                                                                  |
| 两者都对且同代         | 先 `npm run build:bundle`，再重启 pi，再 `/webhub restart`                                                             |
| 只想确认当前跑的是哪份 | （陈旧告警已移除）启动 ~1 s ⇒ 跑 bundle，不保证新鲜；改源码后需 `npm run build:bundle` 重启，或 `PI_TOOLKIT_ENTRY=src` |

---

### 6.2 落地顺序

1. **`src/core/package-root.ts` + `src/web-hub/protocol/package-root.ts` + parity 测试**，
   改写 §3.4 表里 8 个站点（**保持每个调用方的降级语义与返回字节形态**）。
   此步不引 bundle，`npm test`（含 `tests/web-hub/boundary.test.ts`、
   `paths-trusted.test.ts`、`hub/self-version.test.ts`）必须全绿。
2. `scripts/build-bundle.mjs` + `build:bundle` + `esbuild@0.21.5`。
3. `src/core/bundle-entry.ts`（钩子 + 探测 + 加载，全可注入）。
4. `index.ts` → dispatcher（**只留 `export default`**）+ `PI_TOOLKIT_ENTRY` 逃生阀。
5. 测试：§7 三路径 harness + 单元（钩子映射/幂等/解析失败报错）。
6. CI 门禁（§6.3）+ release（`package.sh` 无需改）。
7. 真机验收（§7.3）。

### 6.3 门禁

| 门禁                    | 位置                | 断言                                                  |
| ----------------------- | ------------------- | ----------------------------------------------------- |
| 干净 checkout typecheck | CI（在 build 之前） | `npm run typecheck` 必须过（无 `dist/bundle`）        |
| 构建可复现              | CI                  | 两次 `build:bundle` sha256 相同                       |
| 体积预算                | CI                  | ≤ 6 MB                                                |
| 构建耗时                | CI                  | ≤ 5 s                                                 |
| 纯 src 输入             | CI                  | metafile 的 `inputs` key 全部以 `src/` 开头           |
| 零动态 import           | CI                  | 产物中 `import(` / `__require(` 计数为 0              |
| 行为等价                | CI                  | §7.1 三路径 × 7 profile，**不得 skip**                |
| 边界                    | CI                  | `tests/web-hub/boundary.test.ts` 绿（allowlist 不变） |

### 6.4 性能测量口径（评审第 8 条）

- **起止**：`loadExtensions([entry], cwd)` 的**整段**（模块加载 + factory 执行），
  即 pi 自己的 `loader.js` 入口，不用 `activate()` 单独计时。
- **样本**：5 次，报**中位数 + 极差**；每次独立进程（避免模块缓存污染）。
- **缓存态**：两种都测并分别记录。**`JITI_CACHE` 是布尔开关，不是目录设置**（源码：
  `_booleanEnv("JITI_CACHE", !0)`）⇒ 冷态无法用 `JITI_CACHE=<dir>` 表达。经核实的正确控制方式是
  **`TMPDIR` + `JITI_RESPECT_TMPDIR_ENV=1`**（jiti 只在后者为真时才读 `TMPDIR`，缓存目录是
  `$TMPDIR/jiti`）：
  ① 热：默认路径（`/tmp/jiti` 已预热）
  ② 冷：`TMPDIR=$(mktemp -d) JITI_RESPECT_TMPDIR_ENV=1 <cmd>`，实测该临时目录下会新建 `jiti/`
  子目录（本轮已验证：`/tmp/sp/coldA/jiti` 出现，且 `/tmp/jiti` 未被复用）
- **证明冷样本真的没复用缓存**（不能只看「设置了环境变量」）：
  测试在冷样本前记录目标 `$TMPDIR/jiti` 不存在，运行后断言它**由本次运行创建**（mtime ≥ 起点），
  并在报告里打印**实际生效的缓存根路径**；若该路径与热态路径相同 ⇒ 该样本作废（fail，不静默降级）。
- 门槛只对**热**态设（冷态受 tmpfs/开机影响，只记录不设限）。
- **对照组**：`src/index.ts` 直载（基线）、`dist/bundle/index.js` 直载（bundle 裸速）、
  `index.ts` dispatcher（真实路径）。

---

## 7. 验收矩阵

### 7.1 行为等价：三路径 × 7 profile

**基建问题（评审第 4 条）**：`traceActivation` 是**同步**调用 `activate(pi)`（源码 `activate(pi);`
无 await），而 dispatcher 是 async ⇒ 录制为空。`loadExtensions` 自建 API，无法注入录制 pi。
⇒ 需要两条接缝，且**必须新增**而不是「复用现有」：

| 接缝                 | 做法                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 可 await 的录制器 | 新增 `tests/helpers/activation-trace-async.ts`：`await activate(pi)`，其余逻辑逐字复用现有 `describe`/Proxy。**不改**现有 `activation-trace.ts`（它被 secure-off golden 等既有测试固定使用） |
| B. 三路径隔离        | **每个路径一个子进程**（`node -e` / 临时 .mjs），进程内只加载一个入口并打印 JSON 指纹。进程边界天然隔离 `HOST_KEY`、secure domain、`process.env`、模块缓存，无需手工 reset                   |
| C. 无 bundle 布局    | 临时目录造完整包布局：`package.json` + `index.ts`（复制）+ `src/`（符号链接到真实 `src/`）+ 可选 `dist/bundle/`。这才能真正测到「无 bundle ⇒ 回落源码」                                      |

**指纹**（每 profile）：`tools` 名字序列、`commands` 名字序列、每个 event 的 handler 数量、
`activate-trace.json` 的 `calls` 数组全等、phase2 外部调用数组（`sendMessage`/`appendEntry`/
`setStatus`/`setWidget`/`addAutocompleteProvider`/`notify`）。

**phase2 适用性**：跑全部 7 个 profile 的 **phase1**；phase2 只在 trace fixture 里存在 phase2 记录的
profile 上比对（`child`/`thread-child` 等子会话 profile 按 fixture 现状对齐，不强行要求全有）。

**额外断言（评审第 1 条）**：

- **bundle 分支未求值源码入口**：测试 harness 自身安装一个记录型 `resolve` 钩子，
  收集所有被解析的 URL，断言其中**没有** `<pkg>/src/index.ts`，且**有** `<pkg>/dist/bundle/index.js`。
  这比「看耗时不慢」可靠得多。
- **包根 `index.ts` 只有 `default` 导出**：`expect(Object.keys(await import(rootEntry))).toEqual(["default"])`
  —— 防止有人将来把命名 re-export 加回来（会静默毁掉收益）。

**坏 bundle 必须报错、不得回落源码（复审第 2 条）**——新增矩阵行：

| 场景                          | 输入                                                                                                        | 断言                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bundle 文件存在但**语法错误** | 临时包布局 + `dist/bundle/index.js` 内容为 `export default async function (`, `export default (` 等非法片段 | `loadExtensions([rootEntry])` 返回 `errors.length === 1`，error 文案含 `Failed to load extension`；`tools`/`commands` 为**空**（证明没有走源码 fallback 悄悄起来） |
| bundle 存在但**加载期抛异常** | bundle 首行 `throw new Error("boom-bundle")`                                                                | 同上，且 error 文案含 `boom-bundle`                                                                                                                                |
| bundle 存在但**缺失宿主模块** | 注入 `resolveHost` 全部返回 `undefined`                                                                     | `errors.length === 1`，error 文案指向宿主解析失败（不是静默降级）                                                                                                  |
| 对照：**无** bundle           | 同一临时布局，删除 `dist/bundle/`                                                                           | `errors.length === 0`，指纹 === `src` 路径基线（证明「无 bundle 才回落」）                                                                                         |

**off / secure 契约经 bundle 路径执行（复审第 4 条）**——7 个 profile 里 `minimal` **不是**全 off
（它是 `BASELINE`），且**没有 secure profile**。因此 off/secure 契约**不能**只靠 7 profile 覆盖，
必须补三类显式输入：

| 契约                                     | 载体（现有测试，不新增 golden）                                                                                                       | bundle 路径怎么跑                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| secure-off（I11/D8）                     | `tests/secure/off-golden.test.ts` + `tests/fixtures/secure-off-golden.json`（三个 off 场景：无 `secure` 段 / `enabled:false` / 空段） | harness 用**同一组 settings 输入**在「子进程 + bundle 入口」下重跑，断言 `domainKind`、`guardsNeeded`、`secureCommandRegistered`、`envDelta`、`tracesIdenticalAcrossScenarios` 与 golden 全等 |
| fabric xs off                            | `tests/fixtures/fabric-xs-off-golden.json`、`fabric-wake-off-golden.json`、`fabric-xs-reply-off-golden.json`                          | 同上（off 输入 ⇒ 与 golden 逐字节一致）                                                                                                                                                       |
| schedule off                             | `tests/fixtures/schedule-off-golden.json`                                                                                             | 同上                                                                                                                                                                                          |
| thread off                               | `tests/fixtures/thread-off-golden.json`、`thread-rebind-off-golden.json`                                                              | 同上                                                                                                                                                                                          |
| **全 off**（补 `minimal` 之外的真·全关） | 新增**输入**（不新增 fixture 文件）：一个 settings 对象把所有可关的子系统显式设为 `false`                                             | 断言：与「把同一 settings 喂给 `src` 路径」的指纹**完全相同**；且工具/命令集合等于该配置下 `src` 路径的集合（I9 的 bundle 侧证明）                                                            |

> 说明：这些都是**把现有 fixture 的输入再喂一遍 bundle 路径**，不产生任何新 golden、不改
> `activate-trace.json`；`minimal` 仍按原样作为 7 profile 之一。

### 7.2 身份与模块图（评审第 3 条）

| 断言                                 | 场景                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Container === 宿主 Container`       | local-path（有本地 peers）与隔离目录（无 peers）**两类都测**                                                                                                    |
| `Type === 宿主 Type`                 | 同上（宿主口径 = `require.resolve("typebox")` 的 1.x，**不是** `@sinclair/typebox` 0.34）                                                                       |
| 工具参数 schema 可用                 | 真实 `registerTool` 的 `parameters` 能被宿主 typebox 校验（跑一次 `Value.Check`）                                                                               |
| 解析失败即报错                       | 注入 `resolveHost` 返回 `undefined` ⇒ `installBundleHooks` 抛错（不静默部分重定向）                                                                             |
| 钩子幂等                             | 连续两次 `installBundleHooks` ⇒ 第二次返回 false/不重复注册                                                                                                     |
| 无 `registerHooks` 时                | 注入 `installHooks: undefined` ⇒ 走源码路径，功能完整（证明降级可用）                                                                                           |
| **真实 CLI 启动锚点**（复审第 1 条） | 用**真实 `pi` 可执行文件**启动（`bin/pi` 符号链接原样，**不改** `process.argv[1]`），在扩展里读身份；断言 `Container`/`Type` === 宿主。有/无本地 peers 两类都跑 |
| 陈旧：stale 仍加载 bundle            | 造 bundle（mtime 旧）+ 触碰 `src/index.ts` 到更晚                                                                                                               | stderr **无** `bundle is stale`；仍用 bundle 起来（`tools` 非空）；启动不扫描 src（`dispatcher.test.ts` 已覆盖） |
| 陈旧：fresh                          | 先 `build:bundle` 再启动                                                                                                                                        | stderr 无 stale 行（同样无该告警）                                                                               |
| 陈旧：无 src                         | release 形态目录（只有 `dist/` + `index.ts`）                                                                                                                   | 无 stale 行、无异常输出（I9）                                                                                    |

### 7.3 运维面冒烟（评审第 8 条，补 §6.3 缺口）

| 面                                  | 动作                                                                                               | 断言                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub 进程                            | `/webhub` 启动                                                                                     | 子进程 argv 结尾是 `<pkg>/src/web-hub/hub/main.ts`（不是 `dist/hub/...`），且 `hub.json` 出现                                                                                     |
| UI 目录                             | `packageUiDistDir()`                                                                               | 返回**带尾 `/`** 的 `<pkg>/dist/web-hub-ui/`；`build-info.json` 存在时 UI 能加载                                                                                                  |
| traffic 页                          | `/record on` 后取页面                                                                              | `app.js` 与 `vendor/vue.global.prod.js` 都成功读出（非候选全空抛错）                                                                                                              |
| HUD                                 | 启动后 footer                                                                                      | 版本/分支非空（`pluginRoot()` 未返回 undefined）                                                                                                                                  |
| Feishu                              | 配置存在时                                                                                         | `ownPackageRoot()` 非空（降级分支未被触发）                                                                                                                                       |
| 子会话                              | `pi install <repo>` 正规装配（隔离 HOME），**禁用 `pi -e`**                                        | 子会话工具/命令集合与「允许集合」相等（不是「零注册」——子会话本来就注册 bash/traffic 等；比对现状 `src` 路径的同一集合）                                                          |
| **改源码未重建**（复审第 5 条）     | 已有 bundle → 触碰 `src/**`（不重建）→ 重启 pi                                                     | ① stderr **无** `bundle is stale` 行（告警已移除）；② 启动仍 ~1 s（跑 bundle）；③ 新代码**未生效**（预先埋一个可观测差异，如工具描述串）——用户需自行 `build:bundle`               |
| 陈旧后重建                          | 接上条，`npm run build:bundle` 后重启 pi                                                           | 新代码生效                                                                                                                                                                        |
| `/reload`（含精确语义，**待实测**） | 已有 bundle 会话内改 `settings.json` 后 `/reload`；再在**重建 bundle 后**（文件内容已变）`/reload` | ① 设置生效（重激活）② 钩子未重复安装（`Symbol.for` 标记）③ **记录**重建后 `/reload` 是否读到新 bundle（ESM 缓存行为，未定论）⇒ 结论回填 §6.1.3；无论结果如何，恢复手段仍是重启 pi |
| 父/hub 代差（复审第 5 条）          | 父 pi 跑 bundle；hub 由 `/webhub` 启动                                                             | hub 子进程 argv 指向 `<pkg>/src/web-hub/hub/main.ts`（jiti 读源码）；文档明确 **`/webhub restart` 只更新 hub、不更新父 pi**，不写「restart 后一致」                               |

### 7.4 现有 golden

`tests/fixtures/**` 的 A/A′/B 级文件全部不动。`activate-trace.json` 若因 §3.4 重构而变，
说明「注册顺序」被改了 ⇒ **是实现 bug，不是刷新 golden**。

---

## 8. 风险表

| #   | 风险                             | 触发                                           | 影响                                                      | 缓解                                                                                   |
| --- | -------------------------------- | ---------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| R1  | 静态边把源码图拉回               | 有人加回命名 re-export                         | bundle 路径白跑（两套图）                                 | §7.1「根入口只有 default」断言；§3.2 契约                                              |
| R2  | 身份分裂                         | 钩子未装/映射错/解析失败静默跳过               | `instanceof` 恒假、schema 语义错                          | §3.3 全部映射按宿主 alias 口径；§7.2 两类 peers 场景 + 解析失败即抛                    |
| R3  | `import.meta.url` 深度           | 漏改 §3.4 任一站点                             | hub 起不来 / UI 404 / traffic 500 / HUD 空                | 步骤 1 独立 commit + 现有测试；§7.3 冒烟                                               |
| R4  | 返回形态被改                     | 用 `join()` 实现 `packageUiDistDir`            | 现有测试红（`endsWith("/dist/web-hub-ui/")`）             | 契约明写保留尾 `/`；parity 测试覆盖三布局                                              |
| R5  | 干净 checkout typecheck 红       | 用字面量 import bundle                         | CI 在 build 前失败                                        | §3.6 计算式 specifier；禁止全局屏蔽                                                    |
| R6  | 本地开发跑旧 bundle              | 改源码未重建（local-path 也走 bundle，已拍板） | 「新代码不生效」且**无启动告警**（2026-11-06 用户令移除） | 重建 `npm run build:bundle` 后重启，或 `PI_TOOLKIT_ENTRY=src`；§7.3 验收行已改为无告警 |
| R14 | 宿主锚点解析失败                 | 直接用 `createRequire(argv1)`（符号链接）      | 宿主模块解析不到 ⇒ 身份分裂或钩子装不上                   | §3.3.1 强制 realpath → pi package.json → createRequire；§7.2「真实 CLI 启动」行        |
| R15 | （已随告警移除）陈旧检测拖慢启动 | 启动不再扫描 src                               | 无                                                        | `staleness()` helper 仅保留未调用                                                      |
| R7  | 坏 bundle 静默降级               | try/catch-import 兜底                          | 问题被掩盖                                                | 契约：只在 `existsSync` 为假时走源码；加载失败抛                                       |
| R8  | I8 边界被破                      | protocol 值导入 `src/core/*`                   | boundary 测试红（评审已抓到一次）                         | §3.4 镜像 + parity；allowlist 不扩                                                     |
| R9  | Node < 22.15                     | 无 `registerHooks`                             | 只能走慢路径                                              | 启动探测 + 显式降级（正确但慢），debug 留痕                                            |
| R10 | parity 测试静默 skip             | 缺 bundle 时 `describe.skip`                   | 门禁形同虚设                                              | CI 先 build 再测；缺失即 fail（不 skip）                                               |
| R11 | 耗时口径漂移                     | 用 `activate()` 单独计时                       | 数字好看但假                                              | §6.4 统一 `loadExtensions` 整段 + 5 样本中位数                                         |
| R12 | 打包卷进 node_modules            | 将来加 runtime dep 未 external                 | 体积暴涨/双实例                                           | metafile「inputs 全 `src/`」断言                                                       |
| R13 | 双份代码误导排障                 | 有人改 `dist/bundle/index.js`                  | 被下次构建覆盖                                            | 产物在 `.gitignore` 内；唯一来源是 `build:bundle`                                      |

---

## 9. 评审处置（r_65MKCAXW，8 条逐条）

| #   | 评审意见                                                                 | 核实结果                                                                                                                                                                                                                                                                                                                                                                                                        | 处置                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Blocker**：dispatcher 静态 re-export 把慢路径引回                      | **成立**。`index.ts` 的 `export * from "./src/index.js"` 与 `export { mentionAutocompleteEntries }` 都是静态值边 ⇒ 求值整个闭包。另核：`mention/wire.ts` 值导入 `holder.js`/`autocomplete.js`/`mention.js`/`session.js`，**不是叶子**；`mentionAutocompleteEntries` 的唯一消费者是 `tests/integration/mention-autocomplete-wiring.test.ts`，且它 import 的是 `src/index.js` 而非包根 ⇒ 包根命名导出**零消费者** | §3.2：包根只留 `export default`，删 `export *` 与全部命名 re-export；`src/index.ts:105` 保留。§7.1 新增「根入口只有 `default`」与「bundle 分支未解析 `src/index.ts`」（用记录型 resolve 钩子，非靠计时）                                                                                                    |
| 2   | **Blocker**：`protocol/paths.ts` 导入 `src/core/package-root.ts` 违反 I8 | **成立**。`boundary.test.ts` 只允许 `node:*`、`@sinclair/typebox(/...)`、`{protocol,hub}` 内的相对路径；仓库既有解法是 `core/agent-dir.ts` ↔ `protocol/agent-dir.ts` 镜像 + `tests/config/agent-dir-parity.test.ts` 契约表                                                                                                                                                                                      | §3.4：新增 `src/web-hub/protocol/package-root.ts` 镜像 + `tests/config/package-root-parity.test.ts`；**allowlist 不扩**；首提交（步骤 1）即覆盖 boundary 测试                                                                                                                                               |
| 3   | **Major**：external ≠ 必经 jiti alias                                    | **成立且比评审描述的更严重**：local-path 是**本机主场景**，`isLocalPath` 直接解析原目录、不做 install、`files` 不参与 ⇒ 本地 peers **默认存在**。实测有 peers 时 `Container`/`Type` 均 ≠ 宿主；无 peers 时才正确；仓库 devDep typebox 0.34.52 vs 宿主 1.3.27。另发现 `@sinclair/typebox` 在 pi 安装树里**解析不到**（pi 只 alias 到 `typebox`）                                                                 | §2.4 新增证据表；§3.3 用 `registerHooks` 按宿主 `getAliases()` 口径钉定（实测 1.03–1.14 s 且 identity 正确）；D4 记录四种备选与弃用理由；§7.2 覆盖**有/无本地 peers 两类** + `Container`/`Type` 身份 + schema 可校验 + 解析失败即抛 + 无 `registerHooks` 的降级                                             |
| 4   | **Major**：parity 基建不能直接复用                                       | **成立**。`traceActivation` 源码是 `activate(pi);`（无 await）⇒ 异步 dispatcher 录不到；`loadExtensions` 自建 API 无法注入录制 pi                                                                                                                                                                                                                                                                               | §7.1：新增**可 await 录制器**（不改现有文件）+ **每路径一个子进程**（隔离 HOST_KEY/secure/env/模块缓存）+ **完整临时包布局**测无 bundle 分支；坏 bundle 报错改由 **§7.1 的 4 行矩阵**覆盖（r2 误记为 §7.2，r3 已更正）；R10：CI 不得 skip                                                                   |
| 5   | **Major**：local-path 机制描述错误 + 产物漂移                            | **成立**。`package-manager.js:1183` `isLocalPath ⇒ {type:"local", path}`，无 npm install、`files` 不参与。原文档「先 build 可覆盖本机，但改源码未重建时功能正确」**是错的**：实际是执行**旧 bundle**（新代码不生效）。hub 子进程跑 `src/.../main.ts`，可与父进程不同代                                                                                                                                          | §2.2 重写三种形态机制表；§6.1（r3 整节重写，见 §10.1）**取消**「默认走源码」——拍板为 local-path 也走 bundle，改用 mtime 陈旧检测 + warn；§6.1.3 删除错误的「restart 后一致」，改为父 pi / hub 各自恢复步骤，并写明 `self-version.ts` 只比 version、不能判定 bundle 陈旧；§7.3 增「改源码未重建」等 4 行场景 |
| 6   | **Major**：字面量 bundle import 的类型解析                               | **成立**。`tsc` 复现 `TS2307`；计算式 specifier 通过（实测可运行，且绕过 jiti 走原生 —— 与 §3.3 的钩子设计自洽）                                                                                                                                                                                                                                                                                                | §3.6：统一计算式 specifier（`new URL(...).href`），显式**禁止** `@ts-expect-error` / `declare module` / `exclude`；门禁把 `typecheck` 放在 build 之前并断言干净 checkout 通过                                                                                                                               |
| 7   | **Minor**：路径重构改变返回契约                                          | **成立**。`paths-trusted.test.ts:42` 断言 `endsWith("/dist/web-hub-ui/")`；`join()` 会去尾斜杠                                                                                                                                                                                                                                                                                                                  | §3.4：明写 `packageUiDistDir()` **保留尾 `/`**、`packageRootDir()` 仍剥尾斜杠、两函数不合并；parity 测试覆盖 `src/` / tsc `dist/` / bundle 三布局；逐站点列出现有降级语义（HUD→`undefined`、Feishu→`""`、traffic→抛错列候选）                                                                               |
| 8   | **Major**：验收矩阵不闭合                                                | **成立**。trace 是 **7** 个 profile（`default`/`minimal`/`max`/`child`/`compat-failure`/`thread-main`/`thread-child`）；治理测试直接 import 源码，证明不了 bundle 的 I3/I9；原 §6.3 无 hub/UI/traffic 冒烟；子会话应比「允许集合」                                                                                                                                                                              | §7.1 三路径 × 7 profile（phase1 全跑，phase2 按 fixture 适用）；§7.3 新增 hub argv / UI 目录 / traffic 资源 / HUD / Feishu / `/reload` / 子会话**允许集合**比对；§6.4 定义口径（`loadExtensions` 整段、5 样本中位数+极差、冷/热两态、三对照组）                                                             |

**未改动的已拍板方向**：bundle 构建（D2）、dispatcher 形态（D1）、分发策略 b（D3）。

---

## 10. 复审处置（r3，残留 4 Major + 1 Minor）+ 用户拍板

### 10.1 用户拍板（2026-11-03，替换 r2 的"待决"标注）

> **本机 local-path 也走 bundle**：只要 `dist/bundle/index.js` 存在就走它，享受 ~1 s 启动；
> 需配「改源码未重建 ⇒ 跑旧代码」的提示/检测（启动时比较 `src` 最新 mtime 与 bundle 构建时间，
> 陈旧则 warn）。

→ 落进 §6.1（整节重写为「新鲜度政策」）：§6.1.1 决策 + `staleness()` 契约 + 告警形态（只 warn、
不自动重建、release 形态零输出）、§6.1.2 `PI_TOOLKIT_ENTRY` 的真实设置方式、§6.1.3 父 pi 与 hub
的各自恢复步骤。验收见 §7.2 三行（stale/fresh/无 src）与 §7.3 两行（改源码未重建、陈旧后重建）。

**r2 §9 的两处「需知情」已作废**：②「本机开发不享受提速」不再成立（已改为走 bundle）；
①（`registerHooks` 需 Node ≥ 22.15）仍有效，保留在 §3.3.2 要点 4 与 R9。

### 10.2 残留 5 条逐条

| #   | 复审意见                                                                   | 核实结果                                                                                                                                                                                                                                                       | 处置                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Major**：宿主解析锚点未走 launcher 链，argv1 是符号链接                  | **成立，且已实测**：`createRequire(argv1)` 对 `@earendil-works/pi-tui` 报 `Cannot find module`；`createRequire(realpath(argv1))` 与 `createRequire(<pi>/package.json)` 均成功。r2 的实验确实人为把 argv1 改成了包内 `dist/cli.js`，**没证明**正常 CLI 启动路径 | §3.3.1 新增：强制 `realpath(argv1)` → `findPiPackageJson` → `createRequire(pi package.json)` 三步链；`findPiPackageJson` 从 `launcher.ts` 提到 `src/core/host-modules.ts`（`agent → core` 单向，实测既有 4 处同类导入，不新增循环）；§4.2 增 `argv1` 注入口；§7.2 新增「真实 CLI 启动锚点」行（**不改** `argv1`、有/无 peers 两类都跑） |
| 2   | **Major**：坏 bundle 测试未入矩阵，§9 覆盖声明不实                         | **成立**：r2 的 §7.2 只有「宿主解析失败」，没有「bundle 语法/加载错」，而 §9 却声称已覆盖                                                                                                                                                                      | §7.1 新增 4 行矩阵（语法错 / 加载期抛 / 缺宿主模块 / 无 bundle 对照），断言 **`errors.length===1` 且 tools 为空**（证明没悄悄回落）；§3.2 与 §4.2 的错误约定同步写死；§9 的对应声明已在 r3 修正（见上方第 4 条处置列的"§7.2 覆盖坏 bundle 报错"改为 §7.1）                                                                              |
| 3   | **Major**：新鲜度保证错误（restart / self-version / settings.json 设 env） | **三条全部成立**：① `/webhub restart` 只重启 hub 子进程，父 pi 仍执行启动时加载的 bundle；② `self-version.ts` 只比 `package.json` 的 version 字符串，不识别同版本源码改动；③ `settings.json` 无任何注入环境变量的机制，`PI_TOOLKIT_ENTRY` 只能由进程环境设置   | §6.1.3 **删除**「restart 后一致」保证，改为「父 pi / hub 各自恢复步骤」表；§6.1.2 只给 `PI_TOOLKIT_ENTRY=src pi` 与 `export` 两种真实方式；§6.1.1 用 mtime（不用 version）判定；§7.3 新增「改源码未重建」「陈旧后重建」「`/reload` 精确语义」「父/hub 代差」四行                                                                        |
| 4   | **Major**：bundle 的 off/secure 验收未明确                                 | **成立**：7 个 profile 里 `minimal` 是 `BASELINE` 而非全 off，且**没有 secure profile**（`secure-off` 由 `tests/secure/off-golden.test.ts` + fixture 独立承载）                                                                                                | §7.1 新增「off / secure 契约经 bundle 路径执行」表：secure-off（三个 off 场景）、fabric-xs/wake/reply off、schedule off、thread off、以及**真·全 off**（新输入、不新增 golden）逐一在 bundle 路径重跑并与 golden 全等。**不加新产品范围**：只复用现有 fixture 输入                                                                      |
| 5   | **Minor**：冷缓存不可断言（`JITI_CACHE` 是布尔）                           | **成立**：源码 `_booleanEnv("JITI_CACHE", !0)`；真正控制目录的是 `TMPDIR` + `JITI_RESPECT_TMPDIR_ENV=1`（实测 `$TMPDIR/jiti` 被创建、`/tmp/jiti` 未被复用）                                                                                                    | §6.4 改写冷/热口径：冷样本用 `TMPDIR=$(mktemp -d) JITI_RESPECT_TMPDIR_ENV=1`；**证明未复用**的方法（运行前断言目标目录不存在、运行后断言由本次创建并打印实际缓存根；与热态路径相同则样本作废 fail）                                                                                                                                     |

### 10.3 最终状态

- r3 起**不再有"待决"标注**：local-path 走 bundle 已拍板，机制与验收均已落文。
- 本轮未改动实现代码（只改本文件）；§8 风险表新增 R14（锚点解析）、R15（陈旧检测开销），
  R6 的缓解改为「mtime 检测 + warn」。
- 已实测支撑的数字：源路径 9.9–11.6 s；bundle 裸载 0.85 s；dispatcher + 钩子 1.03–1.14 s；
  构建 0.17 s；陈旧扫描 28–33 ms / 1078 文件。
