# web-hub 前端 Vue 重写 — L2 实施方案 v2（todo #26 施工口径）

> 状态：**v2**（2026-09-27，回应评审第 1 轮 7 条打回 + 用户决策），待复审。只描述施工；视觉/交互以 `ui-design.md`（含 §6 移动端、§17.1
> 用户拍板）为准，样稿 `ui-mockups/` 是像素参照。本文与 `ui-design.md` 冲突处以本文 §0.3「对设计稿的修订」为准。v1→v2 逐条处置见
> §7。

## 0. 摘要

### 0.1 车道

打分：文件数 +2（>5）· 模块边界 +1（hub static ↔ 前端 ↔ 构建/CI）· 契约 +1（新增 reducer 本地事件、static 新根目录，兼容）· 设计选择 +2（git 安装路径、旧前端切换、渲染调度）· 风险面 +1（发版/打包、CSP、包外 UI 根的安全校验）= 7 ⇒ **L2 标准**；命中「发版与部署」一票升级，本就是 L2。

### 0.2 已定决策（用户拍板，不再讨论）

Vue 3 SFC + Vite；产物不进 git（npm 包 / release zip 携带，本地 `npm run build:web`）；缺产物显示「未构建」页、不做运行时下载；浅色默认 + 暗色，三态主题（localStorage）；手写 CSS 沿用 `tokens.css`，不引组件库；CSP `script-src 'self'` 不放宽 ⇒ 只用预编译 SFC + runtime-only Vue；teal 主色；≥768 分栏；文案跟随浏览器语言（zh/en 小词典）；移动端一等公民。

**2026-09-27 追加拍板**：

- **P7 本期必做**（W5）：release 额外产出独立的 `pi-toolkit-web-ui-<ver>.zip`，hub 按版本查找包外 `~/.pi/agent/web-hub-ui/<ver>/`；安装方式为用户手工解压（不做 install 命令）。
- 新增约 25 MB devDependencies 同意（§1.4）。
- 旧前端在 P5b **一次性删除**（不加运行时开关）。
- 未构建页返回 **200**；语言**只自动检测**（无手动切换）；对话流**窗口化上限 300** 个挂载条目（不做虚拟滚动）。
- todo #29（release 总 zip 不能作为 pi 扩展安装）**并入本期 P7**：总 zip 必须携带 pi 的 jiti 源码入口、`src/` 与 `skills/`，并可按 README 步骤本地安装；P7 同时产出独立 UI zip。

### 0.3 对设计稿的修订（实现口径，覆盖 ui-design.md 对应句）

| ui-design 原文                            | 实现口径                                                                                                                                                                              | 原因                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| §3.6 / app.css 断点 481 / 1025，平板单栏  | 手机 ≤480（16px 正文、无头像）；481–767 单栏 + 卡片网格；**≥768 分栏**（侧栏 260px）；≥1025 侧栏 288；≥1280 侧栏 340                                                                  | §17.1-2 用户拍板                                                                                   |
| §6.6「渲染用 requestAnimationFrame 合批」 | **禁用 rAF**；Vue 调度（微任务）+ 自写 `renderGate`（可见时 100ms 节流；隐藏时任何优先级都不写 DOM，回前台同步 flush），见 §3.5                                                       | #25 根因：隐藏 tab 中 rAF 挂起 ⇒ 状态已变但 DOM 永不追上（wh2-merge 1792278 的补丁）               |
| §12「contract.js 原样复用」               | 前端改为**直接 import `src/web-hub/protocol/http-contract.ts`**（Vite 能打包 TS），手抄镜像 `contract.js` 只留 `API` 路径 / `SILENCE_MS` / `HISTORY_LIMIT_MAX` 这几个协议未导出的常量 | 消除「两边手抄、测试比对」的漂移源；http-contract.ts 对 messages.ts 只有 type import，打包后零依赖 |
| §13「ESLint `vue/no-v-html`」             | 不引 ESLint，用静态扫描测试（§4.3）                                                                                                                                                   | 仓库无 ESLint，为一条规则引一套工具链不划算                                                        |
| §12「reducer 原样复用」                   | 加一个**兼容性**本地事件 `route`（§3.3）：路由为选中态的唯一来源，关闭 `withSelection` 的自动选中；旧 UI 不派发它，行为不变                                                           | 手机列表页不能偷偷订阅第一个 agent；深链 key 在 `agents` 帧到达前需暂存                            |
| §6.6「首屏只渲染最近 80/200 条」          | 纯客户端窗口：hub 快照照旧返回尾部 400 条（`DEFAULT_TAIL_ENTRIES`，不动协议），前端只挂载窗口内条目                                                                                   | 不改 hub 协议即可达成手机 DOM 上限；协议级 `limit` 留作以后                                        |

### 0.4 前置条件

- `wh2-merge` 分支上的 `fix(web-hub): render fallback when rAF is suspended and cap history payload bytes`（v1 写的 a367d7f 已被 rebase，当前为 **1792278**，`git log master..wh2-merge` 仅此一个提交，尚未进 master）须先合入 master，P0 从含它的 HEAD 起步（P0 要改 `app.js`，否则必冲突）。
- P0 合入后主会话在主工作树跑一次 `npm install`（新增 devDeps），之后各 worktree 通过 `node_modules` 软链复用。

## 1. 目录与构建

### 1.1 目录

v2 口径：**P0 只落最小骨架**（下表标 `P0`）；组件与样式文件由 P3/P4 各自**独占新建**（标 `P3`/`P4`），P0 不再建组件存根。唯一例外是两个「接缝」文件：`App.vue`（P0 占位 → P3 接管）与 `components/body/DetailBody.vue`（P0 占位 → P4 接管）——P3 的 `AgentDetail.vue` 需要 import 对话流区域才能编译，接缝让 P3 ∥ P4 各自独立构建。完整独占清单见 §5.2。

```
src/web-hub/ui/                      # Vue 源码（进 git；npm 包因 files:["src"] 也会带上，便于 npm 用户自行重建）
  index.html                         # P0 Vite 入口；<html data-auth-mode="__AUTH_MODE__">（serveIndex 占位符必须原样保留）
  vite.config.ts                     # P0 冻结；含 csp-probe 模式（§4.4.1）
  build-info-plugin.ts               # P0 冻结；closeBundle 写 build-info.json（§1.2）
  aliases.ts                         # P0 冻结；@logic / @protocol 别名，vite.config.ts 与根 vitest.config.ts 共用
  tsconfig.json                      # P0 冻结；独立 tsconfig（Bundler 解析 + DOM lib），vue-tsc 检查
  env.d.ts                           # P0；*.vue 模块声明 + __PWH_UI_BUILD__ 常量声明
  csp-probe/                         # P0；只在 `vite build --mode csp-probe` 下作为入口，不进正式产物
    index.html  main.ts  Probe.vue  negative.html  negative.ts
  public/
    theme-init.js                    # P0 同步小脚本（非 module）：读 localStorage 在首帧前给 <html> 加 theme-* 类
    favicon.svg                      # P0
  src/
    main.ts                          # P0 冻结；import "./styles/tokens.css"; createApp(App).mount("#root")
    App.vue                          # 接缝：P0 占位（只渲染 IconSprite + 空壳）→ P3 独占接管
    build-info.ts                    # P0；读 __PWH_UI_BUILD__（version / proto / commit）
    types.ts                         # P0 冻结；视图模型类型（§3.2 末）
    contracts.ts                     # P0 冻结；§3.2 全部组件的 Props / Emits 接口（组件内 defineProps<XxxProps>() 直接引用）
    styles/
      tokens.css                     # P0 冻结；原样拷贝 ui-mockups/tokens.css（删去 #mock-dark 样稿专用段）
      base.css primitives.css notices.css shell.css agents.css detail.css dock.css login.css states.css  # P3 独占新建；由 App.vue 首批 import（先于任何子组件 import）
      fleet.css transcript.css       # P4 独占新建；分别由 FleetPanel.vue / Transcript.vue import
    icons/                           # P0 冻结（P3/P4 共用）
      IconSprite.vue                 # 33 个 <symbol>（照搬样稿），App 顶层渲染一次
      AppIcon.vue                    # <svg class="icon" aria-hidden="true"><use :href="`#i-${name}`"/></svg>
      names.ts                       # IconName 联合类型
    transport/
      types.ts                       # P0 冻结；HubTransport / PasswordTransport 接口（§3.4）
      token.ts  password.ts          # P1
    composables/
      useHashRoute.ts                # P0；#/ 与 #/agent/<key>（§3.7）
      useI18n.ts                     # P0；navigator.languages → zh|en；t(key, params)
      useHub.ts renderGate.ts usePasswordAuth.ts useTheme.ts useTicker.ts useClipboard.ts
      useAnnouncer.ts useTranscriptWindow.ts useFollowScroll.ts useMedia.ts visual-state.ts   # P1
    i18n/
      index.ts                       # P0 冻结；import.meta.glob("./{en,zh}/*.ts", { eager: true }) 合并命名空间 ⇒ 各包加文件不改它
      en/errors.ts  zh/errors.ts     # P1（登录错误 / 连接态）
      en/{shell,login,agents,detail,notices,common}.ts  zh/{同上}.ts   # P3
      en/{fleet,transcript}.ts  zh/{同上}.ts                          # P4
                                     # 每个 zh 文件 `satisfies Messages<typeof import("../en/xxx").default>` ⇒ 缺 key 即类型错误
    format.ts                        # P1；Intl.NumberFormat / DateTimeFormat；保留 formatUsd「<$1 显示 4 位」规则
    components/
      shell/ agents/ detail/         # P3 独占新建（§3.2）
      body/DetailBody.vue            # 接缝：P0 占位（props 冻结，渲染空 <section>）→ P4 独占接管（内含 FleetPanel + Transcript）
      fleet/ transcript/             # P4 独占新建
src/web-hub/protocol/ui-manifest.ts  # P0 冻结；build-info.json 的类型 / 纯函数 parse+validate / 路径白名单 / UiStatus 类型（hub、构建插件、check 脚本共用）
dist/web-hub-ui/                     # 构建产物（dist/ 已 gitignore、已在 package.json files、已被 release 总 zip 整体拷贝）
  index.html  theme-init.js  favicon.svg  assets/index-<hash>.js  assets/index-<hash>.css
  build-info.json                    # §1.2；hub 解析 UI 根时逐文件校验的唯一依据
```

**产物目录选 `dist/web-hub-ui/` 的理由**：`dist/` 已在 `.gitignore`、`.prettierignore`、`package.json#files` 里，`scripts/release/package.sh` 本就 `cp -r dist`——零配置改动即可同时满足「不进 git」「进 npm 包」「进 release 总 zip」。包内根用 `new URL("../../../dist/web-hub-ui/", import.meta.url)` 解析（`src/web-hub/{hub,protocol}/` 下深度相同，均落到包根；hub 永远经 jiti 从 `src/web-hub/hub/` 跑，`agent/index.ts` 的 `hubMainPath` 指向 `../hub/main.ts`）。tsc 的 `outDir: dist` 只写 `dist/<模块>/`，不会与 `dist/web-hub-ui/` 冲突；Vite `emptyOutDir: true` 只清自己的 outDir。

`.gitignore`：无需改（`dist/` 已覆盖）；csp-probe 输出到 `node_modules/.cache/pwh-csp-probe/`（已被 `node_modules/` 覆盖）。

### 1.2 Vite 配置（`src/web-hub/ui/vite.config.ts`，要点逐条写死）

```ts
export default defineConfig({
  root: here, // src/web-hub/ui
  base: "/", // 产物引用 /assets/…（与旧前端一致；LAN 反代按 origin 不按子路径）
  publicDir: "public",
  plugins: [vue()], // @vitejs/plugin-vue：SFC 模板构建期编译 ⇒ runtime-only
  resolve: { alias: uiAliases }, // @logic → src/web-hub/web（P5b 改指 src/web-hub/ui/src/logic）；@protocol → src/web-hub/protocol
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    __PWH_UI_BUILD__: JSON.stringify({ version: pkg.version, proto: PROTO.major, commit }), // commit 与 build-info.json 同源
  },
  build: {
    outDir: resolve(here, "../../../dist/web-hub-ui"),
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false, // 不产 map，也不留 sourceMappingURL 注释
    assetsInlineLimit: 0, // 不把资源内联成 data:（行为可预测，便于白名单）
    cssCodeSplit: false, // 单一 CSS 文件（不走 JS 动态插 <link>）
    modulePreload: { polyfill: false }, // 单 chunk，不需要 polyfill
    rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } }, // 单 JS chunk
    reportCompressedSize: false,
  },
});
```

- `vue` 解析到 `vue.runtime.esm-bundler.js`（Vite 默认），**禁止**别名到 `vue/dist/vue.esm-bundler.js`（完整版含模板编译器 ⇒ 需要 `unsafe-eval`）。组件里禁止 `template:` 字符串选项（扫描测试兜底）。
- `index.html` 里 `<script src="/theme-init.js"></script>`（`public/`，非 module，同步，在 CSS 之前）：Vite 会对非 module 脚本给出 "can't be bundled" 提示并原样保留——这正是要的效果。它是外链同源脚本，满足 `script-src 'self'`。
- 产物守卫脚本 `scripts/web-hub/check-ui-dist.ts`（CI 必跑，§1.5）逐条断言：`index.html` 含 `data-auth-mode="__AUTH_MODE__"`；无内联 `<script>`（每个 `<script>` 都有 `src`）；无 `on*=` 属性、无 `style=` 属性、无 `<style>`；所有引用的 `/assets/*` 文件存在且文件名带 ≥8 位哈希；无 `.map` 文件、无 `sourceMappingURL`；JS 中无 `eval(`、`new Function(`、`Function("`（Vue 运行时的 `insertStaticContent` 会用 `innerHTML` 插**编译期静态**模板，所以产物层不禁 `innerHTML`，源码层禁，见 §4.3）；无 `http://` / `https://` 外链资源引用（字符串常量中的文档 URL 例外名单写在脚本里）；体积预算 JS ≤ 120 KiB gzip、CSS ≤ 25 KiB gzip（Vue runtime ≈ 25 KiB gzip，余量给业务）。
- **SFC 内禁止 `<style>` 块**（扫描测试兜底）：全部样式在 `styles/*.css`，按包独占，避免 scoped 哈希与 dev 模式注入 `<style>`。
- **build-info.json**（`build-info-plugin.ts`，`closeBundle` + `enforce: "post"`，在 public 拷贝之后执行）：遍历 outDir（排序、跳过自身），遇软链或非普通文件直接让构建失败；写入

  ```ts
  // src/web-hub/protocol/ui-manifest.ts（P0 冻结）
  export interface UiBuildInfo {
    v: 1;
    version: string; // package.json version（= hub 的 config.pluginVersion）
    proto: { major: number }; // PROTO.major
    builtAt: string; // ISO；设了 SOURCE_DATE_EPOCH 则用它（可复现）
    commit: string; // git rev-parse HEAD 前 12 位，工作树脏加 "-dirty"；非 git 目录 / 超时 2s ⇒ "unknown"
    files: { path: string; bytes: number; sha256: string }[]; // 不含 build-info.json 自身
  }
  export const UI_MAX_FILES = 64;
  export const UI_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
  export function parseUiBuildInfo(json: unknown): { ok: true; info: UiBuildInfo } | { ok: false; error: string };
  export function isAllowedUiPath(p: string): boolean; // 顶层白名单 {index.html, theme-init.js, favicon.svg} ∪ ^assets/[A-Za-z0-9._-]+\.(js|css|svg)$
  ```

  `parseUiBuildInfo` 同时校验：`files` 每项 `isAllowedUiPath`、不重复、含 `index.html`、`sha256` 为 64 位小写 hex、`bytes` 为非负整数、条数与总字节不超上限。`__PWH_UI_BUILD__` 与它同源（`{ version, proto, commit }`）。

- `check:web` 改为 `tsx scripts/web-hub/check-ui-dist.ts`（可直接 import `ui-manifest.ts`）：在 v1 守卫条目之外，断言 `build-info.json` 可解析、清单与目录**逐一对应**（不多不少）、每项 bytes/sha256 复算一致；并扫描编译后 JS 中的字符串字面量：出现 `<tag … style=` / `<tag … on<x>=` / `<style` / `<script` 片段即失败——覆盖 Vue 静态提升（`createStaticVNode` 把 ≥20 个连续静态节点字符串化后经 `innerHTML` 插入，其中的 style 属性会被 CSP 静默丢弃）。P5b 起再加一步：对 `dist/web-hub-ui` 跑 hub 的 `verifyUiRoot`（§2.1），保证 CI 产物一定能被 hub 接受。

### 1.3 tsconfig 关系

- 根 `tsconfig.json` 与 `tsconfig.build.json` 的 `exclude` 加 `src/web-hub/ui/**`（build 的 `exclude` 是覆盖不是合并，两处都要写）。根 tsc 是 NodeNext + 无 DOM lib，不能也不该检查 SFC。
- `src/web-hub/ui/tsconfig.json`（独立，不 extends 根）：`target ES2022`、`module ESNext`、`moduleResolution Bundler`、`lib [ES2022, DOM, DOM.Iterable]`、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`isolatedModules`、`verbatimModuleSyntax`、`allowJs: true`（@logic 下的 JSDoc JS 通过 JSDoc 推断出类型给 TS 调用方）、`checkJs: false`（不在本期给旧 JS 补类型）、`types ["vite/client", "node"]`（后者仅供 vite.config.ts）、`paths` 与 `aliases.ts` 一致；`include: ["src/**/*.ts", "src/**/*.vue", "env.d.ts", "vite.config.ts", "aliases.ts"]`。
- `npm run typecheck` 追加 `&& vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json` ⇒ 自动进 CI（CI 已跑 typecheck）。
- 根 `vitest.config.ts`：`plugins: [vue()]`、`resolve.alias: uiAliases`；环境仍默认 `node`，组件测试文件头写 `// @vitest-environment happy-dom`。`include` 不变（`tests/**/*.test.ts`）。

### 1.4 package.json

```jsonc
"scripts": {
  "build:web": "vite build --config src/web-hub/ui/vite.config.ts",                  // 产物 + build-info.json（插件）
  "dev:web":   "vite build --watch --config src/web-hub/ui/vite.config.ts",          // 配合 dev:hub 看真实 CSP 下的效果
  "check:web": "tsx scripts/web-hub/check-ui-dist.ts",
  "probe:csp": "tsx scripts/web-hub/csp-probe.ts",                                    // P0 浏览器级 CSP 探针（本机，§4.4.1）
  "dev:hub":   "tsx scripts/web-hub/dev-hub.ts",                                      // 假数据 hub（§4.5，P2 实现）
  "visual:web":"tsx scripts/web-hub/visual.ts",                                       // 截图 + ui-design §6 断言（本机，§4.4.2）
  "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json",
  "prepack":   "npm run build && npm run build:web && npm run check:web"             // npm pack / publish 必带产物
}
```

- 全部 script 入口在 P0 一次写定（指向的文件由后续包新建），之后 `package.json` 冻结，避免各包争改。
- Playwright 加载：`scripts/web-hub/lib/playwright.ts`（P0）的 `loadPlaywright()` 先以 `npm_config_offline=true npx -y -p playwright@1.62.1 node -p "require.resolve('playwright')"` 解析本机 npx 缓存里的模块路径，再 `import(pathToFileURL(...))`；浏览器用 `~/.cache/ms-playwright/chromium-1243`（本机已缓存）。离线失败才允许联网重试一次；都失败 ⇒ 脚本以退出码 2 报「浏览器不可用」（与断言失败的 1 区分）。
- **不加** `prepare` / `postinstall`（理由见 §1.7 方案 C）。`prepack` 只在 `npm pack` / `npm publish` / npm 自己安装 git 依赖时触发，pi 的 git 安装走 `npm install --omit=dev`（触发的是 `prepare` 不是 `prepack`），不受影响。
- `files` 不改（`dist` 已在列）。
- 新增 devDependencies（全部 MIT；体积为 npm 报告的 unpacked，含主要传递依赖估算；**用户 2026-09-27 已同意**）：

| 包                   | 版本                             | 体积（约）                                                                 | 用途                                    |
| -------------------- | -------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| `vue`                | `^3.5.43`                        | 2.5 MB，连 `@vue/compiler-sfc`（postcss、@babel/parser）≈ 9 MB             | 运行时 + SFC 编译（构建期）             |
| `@vitejs/plugin-vue` | `~5.2.4`                         | 0.2 MB                                                                     | peer `vite ^5 \|\| ^6`                  |
| `vite`               | `~5.4.21`                        | 0（已作为 vitest 2.1.9 的依赖存在于 node_modules，显式声明以锁版本、去重） | 构建                                    |
| `vue-tsc`            | `^3.3`（peer TS ≥5，本仓 5.9.3） | ≈ 3 MB（@volar/\*、@vue/language-core）                                    | SFC 类型检查                            |
| `happy-dom`          | `^20`                            | 8.4 MB（+ ws、entities）                                                   | 组件测试 DOM（20.x 修复了 VM 逃逸 CVE） |
| `@vue/test-utils`    | `^2.4.x`                         | 1.5 MB + js-beautify ≈ 1 MB                                                | 组件挂载                                |

合计约 +25 MB node_modules（现 333 MB，≈ +8%），**不进用户安装**（pi git 安装 `--omit=dev`；npm 包不含 devDeps）。**不作为 devDep 引入**：Playwright（13 MB core + 浏览器）与 `axe-core`（MPL-2.0）只在本机脚本里经 `scripts/web-hub/lib/playwright.ts` 从 npx 缓存加载 `playwright@1.62.1`（本机已有，浏览器 chromium-1243 已缓存）。P0 须验证 vitest 2.1.9 + happy-dom 20 兼容；不兼容则退 `happy-dom ~15.11`（≥15.10.2 已修 RCE；VM 逃逸只影响执行不可信脚本，测试场景可接受——写入 P0 报告）。

### 1.5 CI（`.github/workflows/ci.yml`）

```yaml
- run: npm ci
- name: Format check
  run: npm run format:check
- name: Typecheck # 已含 vue-tsc
  run: npm run typecheck
- name: Build web UI # 新增：必须在 Test 之前，dist 测试依赖产物
  run: npm run build:web && npm run check:web
- name: Test
  run: npm test
  env:
    PWH_REQUIRE_UI_DIST: "1" # 产物相关测试在 CI 缺产物时失败而非跳过
- name: Build
  run: npm run build
```

### 1.6 release（`scripts/release/package.sh`，P7）

- `npm run build` 之后追加 `npm run build:web && npm run check:web`；总 zip 的 `cp -r dist` 自动带上 `dist/web-hub-ui/`。
- **todo #29 已并入 P7**：总 zip 追加 `index.ts`、`index.js`、`src/`、`skills/` 及 `package.json` 声明的 pi 装配文件；README 改为解压后 `npm install --omit=dev`、`pi install .`，并由结构测试验证可安装内容。
- **UI zip（本期必做）**：新脚本 `scripts/release/package-web-ui.sh <version> [outDir]`（package.sh 调用；独立成文件以便测试直接驱动，测试用 `PWH_UI_DIST` 覆盖产物目录）：
  1. 读 `dist/web-hub-ui/build-info.json`，`version` ≠ `<version>` ⇒ 退出 1；`find dist/web-hub-ui -type l` 非空 ⇒ 退出 1（软链不进 zip）。
  2. 暂存 `release/stage-ui/web-hub-ui/<version>/` ← `cp -R dist/web-hub-ui/.`；`chmod -R u=rwX,go=rX`（解压后天然满足 hub 的「非 group/world 可写」校验）。
  3. `(cd release/stage-ui && zip -qrX ../pi-toolkit-web-ui-<version>.zip web-hub-ui)`（`-X` 去掉 uid/gid 等扩展属性）；`sha256sum pi-toolkit-web-ui-<version>.zip > pi-toolkit-web-ui-<version>.zip.sha256`；删暂存。
- zip 内部顶层固定为 `web-hub-ui/<version>/`，因此安装就是 `unzip -o pi-toolkit-web-ui-<ver>.zip -d ~/.pi/agent/` ⇒ 落到 hub 查找的 `~/.pi/agent/web-hub-ui/<ver>/`（§2.1 候选 2）。按版本分目录：多版本并存互不覆盖，hub 只认与自己版本一致的那个；旧版本目录用户可手删。
- package.sh 头注释与结尾 `echo ✅` 列出两个新产物；`gh release create` 须附上 `release/pi-toolkit-web-ui-<ver>.zip{,.sha256}`（写进 package.sh 结尾提示行）。
- 安装为**手工解压**，不做 `/webhub install` 之类命令（用户决策）；步骤出现在未构建页（§2.1）、`/webhub status`（§2.3）和 README（P7）。

### 1.7 `pi install git:…` 路径

**事实（读 pi 0.87.1 `dist/core/package-manager.js`）**：

1. 首次安装：`git clone` → `npm install --omit=dev`（在克隆目录里）。任一步抛错 ⇒ `rmSync(targetDir)` 整个安装回滚。
2. 每次 `pi update`（HEAD 变化时）：`git reset --hard` → **`git clean -fdx`** → `npm install --omit=dev`。即：**任何 gitignored 的本地构建产物（含 `dist/web-hub-ui/`）和手装的 devDeps 都会在每次更新时被清掉**。
3. 用户本人当前以本地路径安装（`~/.pi/agent/settings.json` `packages: ["../../ai/pi-toolkit"]`），且包尚未发布到 npm（`npm view pi-toolkit` 404）——眼下真正受影响的是「未来的 git 安装用户」，本机开发者跑一次 `npm run build:web` 即可。

**对策（v2：A + B 本期都做）**：

| 方案                                                                                                                      | 可行性 / 风险                                                                                                                                                                                                                                    | 结论                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **A 提示页 + 命令**：未构建页与 `/webhub status`/`open` 给出源码构建命令并注明 `pi update` 会清掉产物                     | 零新机制；代价是每次更新后手动一次，且 `--include=dev` 会装上全部 devDeps（下次 update 的 `--omit=dev` 会裁掉）                                                                                                                                  | **采用（P5b）**                                                       |
| **B release 附件**：`pi-toolkit-web-ui-<ver>.zip` + hub 查找包外 `~/.pi/agent/web-hub-ui/<ver>/`（不受 `git clean` 影响） | 用户手动下载 ≠ 运行时下载，符合决策；安全靠 §2.1 的统一校验（属主/模式/软链/清单哈希/版本协议）                                                                                                                                                  | **采用：查找+校验 P5a/P5b，打包+文案 P7（用户 2026-09-27 定为必做）** |
| **C `prepare`/`postinstall` 构建**                                                                                        | pi 用 `--omit=dev` ⇒ vite/vue 不存在，只能静默跳过 ⇒ 对 git 用户**无效**；若脚本出错，pi 会**回滚整个安装**；若把 vite/vue 挪进 `dependencies`，每个用户每次 update 都多装 ~40 MB（含 esbuild 原生二进制）并构建 ~10 s，且把构建失败变成安装失败 | 否决                                                                  |
| **D 产物进 git**（孤儿分支 / tag 附带）                                                                                   | 违反已定决策                                                                                                                                                                                                                                     | 不采纳                                                                |
| **E 发布到 npm**                                                                                                          | `pi install npm:pi-toolkit` 天然带产物（prepack 保证）；首发时机由用户决定                                                                                                                                                                       | 长期主路径，本期不做                                                  |

## 2. hub 侧改动（P5a 新增模块 → P5b 接线 → P7 补 release 文案）

### 2.1 UI 根解析与服务（`src/web-hub/hub/ui-root.ts` 新增，`static.ts` 改写）

**候选根（顺序固定，先到先得）**：

1. `package`：`packageUiDistDir()` = `fileURLToPath(new URL("../../../dist/web-hub-ui/", import.meta.url))`（新加在 `src/web-hub/protocol/paths.ts`，pi 侧 `/webhub status` 共用）。
2. `external`：`webHubUiDir(home)/<hubVersion>/`，`webHubUiDir(home) = ${home}/.pi/agent/web-hub-ui`（同样加在 `paths.ts`，紧挨现有 `webHubStateDir`；`home` = `HubConfig.home`，与 hub 状态目录同源——hub 一律用 `<home>/.pi/agent`，不读 `PI_CODING_AGENT_DIR`，这里保持同一口径）。`hubVersion` = `config.pluginVersion`（agent 侧 `packageVersionSync()` 读 package.json 得来），须匹配 `^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$` 且不含 `..`，否则跳过该候选（`version-unsafe`），防路径注入。

**每根统一校验 `verifyUiRoot(dir, expect, deps)`**——任一不过即记 `{ kind, dir, reason, detail }`、弃该根试下一个；全不过 ⇒ 未构建页：

| #   | 检查                                                                                                                                                                                                     | reason                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | 根目录 `lstat`：存在、是目录、**本身不是软链**；随后取 `realRoot = realpath(dir)`                                                                                                                        | `missing` / `symlink` / `not-directory`                                  |
| 2   | 信任：根目录、其父目录（`package` 为 `dist/`，`external` 为 `web-hub-ui/`）、根下每个子目录（`assets/`）：属主 ∈ {当前 uid, 0} 且 `(mode & 0o022) === 0`                                                 | `owner-mismatch` / `mode`                                                |
| 3   | `build-info.json`：`open(O_RDONLY \| O_NOFOLLOW)` + `fstat` 为普通文件、≤64 KiB、属主/模式同 #2；`parseUiBuildInfo` 通过                                                                                 | `build-info`                                                             |
| 4   | `info.version === hubVersion` 且 `info.proto.major === PROTO.major`                                                                                                                                      | `version-mismatch` / `proto-mismatch`                                    |
| 5   | 清单逐项：路径段逐级 `lstat` 无软链；`open(O_NOFOLLOW)` + `fstat` 普通文件、属主/模式同 #2；读入 Buffer 后 `bytes`、`sha256` 与清单一致；`realpath(file)` 在 `realRoot` 内；累计条数/字节不超 `UI_MAX_*` | `symlink` / `not-file` / `size` / `hash` / `escape` / `too-large` / `io` |
| 6   | 根内存在但清单未列的文件：**不服务**（只记 debug，不致命）                                                                                                                                               | —                                                                        |

- 整个解析 single-flight，外包 `withDeadline(3s)`（`timeout`）；hub 进程 umask 077 不影响只读校验。
- **复用现有私有目录校验**：`paths.ts` 新增只查不修的 `checkTrustedEntry(path, kind: "dir" | "file", deps)`，复用该文件的 `FsDeps`（可注入 `lstat/stat/realpath/getuid`，测试靠它模拟他人属主）、`PrivateDirError` 与 `PrivateDirReason` 词表（`symlink` / `not-directory` / `owner-mismatch` / `mode` / `io`），写法照 `ensureXdgSocketDir`（`lstat` 不跟随软链 → 类型 → 属主 → 模式）。**不直接调用 `ensurePrivateDir`**：其 check-only 口径（XDG）要求 `mode & 0o077 === 0`，会误拒 0755/0644 的正常产物（UI 是公开内容，要的是完整性不是保密性）；其 STATE/TMP 口径会 `mkdir`/`chmod` 修复——UI 根必须只查不改。
- **属主放行 uid 0**：系统级安装（`sudo npm i -g` 后 root 属主、0755）也能用包内根；root 本就能改 hub 代码本身，放行它不扩大信任面（同 sshd `StrictModes` 口径）。group/world 可写一律拒。
- 父目录只查一层：`package` 根再往上就是包根，包根能被他人写 ⇒ hub 代码本身已不可信，多查无益；`external` 的 `~/.pi/agent` 同理（设置、token 都在里面）。

**TOCTOU：解析时校验并缓存字节，服务只出内存**

- 第 5 步读入并算过 sha256 的 Buffer 直接缓存；之后所有请求只从内存出字节，服务路径**零磁盘 I/O**——校验与服务之间不存在可被替换的窗口，比「服务时再比对 realpath+size+sha」更强，也更便宜（每请求 0 次 syscall）。`index.html` 的占位符替换在缓存 Buffer 上做（两种 authMode 各缓存一份）。
- 代价：常驻内存 ≤ `UI_MAX_TOTAL_BYTES`（4 MiB 硬上限，超出即 `too-large`；预计实际 ≈ 0.5 MiB）；一次解析 ≈ 十来次 lstat/open + 读 ≤4 MiB + sha256，毫秒级。
- （v2.1，复审 v2-2）口径：4 MiB 是**产物清单字节预算**（build-info 清单中文件 bytes 之和）。实际驻留上界 = 换代过渡期新旧两代缓存并存 ×（清单字节 + 两种 auth 模式各一份改写后的 index.html）≤ 2 × (4 MiB + 2 × index 上限 64 KiB) ≈ 8.3 MiB；新代解析成功并原子切换后旧代立即释放引用，测试断言切换后只持有一代。
- **换代检测（重新构建/解压后无需重启 hub）**：缓存记录每个候选 `build-info.json` 的 `lstat` 指纹 `{dev, ino, size, mtimeMs, ctimeMs}`（不存在也是一种指纹）。只有 `/`、`/index.html` 请求触发探测，且距上次探测 ≥1s：两次 `lstat`，指纹变化 ⇒ 重新解析（single-flight，≤3s），`/` 等待新结果，期间其他请求继续出旧缓存；新结果原子替换。资源请求从不触发探测。已打开的旧页面引用的旧哈希资源在换代后 404，刷新即可（`index.html` 为 `no-cache`）。
- 启动：hub 在写 hub.json 前 `await ui.refresh()`（≤3s，超时按未构建上报、后台继续）。

**诊断**：

- `UiStatus`（`ui-manifest.ts` 导出）：`{ state: "ok"; source: "package" | "external"; version; commit; builtAt; candidates } | { state: "unbuilt"; candidates }`，`candidates[]` = `{ kind, dir, reason?, detail? }`。
- 状态变化时写 hub 日志：`log.info("web-hub: ui root", {source, version, commit})` / 每个被拒候选 `log.warn("web-hub: ui root rejected", {kind, dir, reason, detail})`。
- `hub-json.ts` 新增 `patchUi(ui)`（完全仿 `patchLan`：首次 `write()` 前排队、seal 后 no-op），`HubRecord` 加可选字段 `ui?: UiStatus`；hub.json 是 0600 本机文件，含绝对路径无妨。pi 侧读取见 §2.3。

**URL 映射**（收紧；旧前端的 `/assets/<p>` → `<root>/<p>` 双路回退与任意顶层 `.js` 一并删除）：

- 先过现有 `safeRelativePath`（百分号解码失败 ⇒ 404；拒 `..`/NUL/反斜杠/点开头段；扩展名白名单）。
- `/`、`/index.html` → 缓存的 index（按 authMode 替换占位符）。
- 其余路径必须 `isAllowedUiPath` **且在当前清单内** ⇒ 出缓存；否则 404。
- MIME 不变；缓存头：`assets/` 下且文件名匹配 `-[A-Za-z0-9_-]{8,}\.(js|css|svg)$` ⇒ `public, max-age=31536000, immutable`；`index.html`、`theme-init.js`、`favicon.svg` ⇒ `no-cache`。`X-Content-Type-Options: nosniff` 由 http.ts 统一加；HEAD 沿用 Node 自动省略 body。

**接线**：`static.ts` 导出 `createUiServer({ candidates, hubVersion, log, deps? }): UiServer`，`UiServer = { serve(urlPath, res, { authMode, acceptLanguage }): Promise<boolean>; refresh(): Promise<UiStatus>; status(): UiStatus }`；删除 `webRoot()` 与旧 `serveStatic(root, …)`。`FrontendDeps`（`ports.ts:392`）加可选 `ui?: UiServer`——缺省时 `createHttpFrontend` 自建（`config.home` + `config.pluginVersion`），所以现有测试 helpers 无需改；`hub.ts` 自建并注入，以便把 `status()` 变化 `patchUi` 进 hub.json。http.ts 三处：`:1201` `const root = webRoot()` → `const ui = deps.ui ?? createUiServer(…)`、`:1241` 的 `root` 字段换成 `ui`、`:1010`（LAN）/`:1506`（回环）改 `ui.serve(path, res, { authMode, acceptLanguage: req.headers["accept-language"] })`。

**未构建页**（`src/web-hub/hub/unbuilt.ts`，纯函数 `renderUnbuiltPage({ lang, version, mode, pkgDir?, rejected? })`，HTML 转义所有插值）：

- **200**（用户已定；`lan-host.test.ts` 等断言 `/` 为 200，健康语义在 `/healthz`）+ `Cache-Control: no-store` + `X-PWH-UI: unbuilt`；语言按 `Accept-Language`（`zh*` ⇒ 中文，否则英文）；无脚本、无样式（满足 `style-src 'self'`）；纯语义 HTML。
- 内容：标题 + 原因一句 + 两种安装方式：
  - **方式一 release 附件**（git/zip 安装用户推荐，不受 `pi update` 的 `git clean -fdx` 影响）：release 页 `https://github.com/Newbluecake/pi-toolkit/releases/tag/v<ver>`（URL 由 package.json `repository` 推出，构建期常量）下载 `pi-toolkit-web-ui-<ver>.zip` 与 `.sha256` → `sha256sum -c pi-toolkit-web-ui-<ver>.zip.sha256` → `unzip -o pi-toolkit-web-ui-<ver>.zip -d ~/.pi/agent/` → 刷新本页（无需重启）。
  - **方式二 源码构建**：`cd <包目录> && npm install --include=dev --no-audit --no-fund && npm run build:web`；注明 `pi update` 会清掉包内产物，更新后需重跑。
- **token（回环）模式**额外显示包目录绝对路径与各候选的 `kind: reason`（不含 detail）。**password（LAN）模式不含任何绝对路径与拒绝原因**（未鉴权的局域网访问者也能拿到此页）：命令里包目录写成「包目录（在主机上运行 `/webhub status` 查看）」，外部目录只写字面量 `~/.pi/agent/`，并提示在主机上运行 `/webhub status` 看诊断。
- 未构建时 `/assets/*` 及其它一切静态路径 404（不回退）。

### 2.2 CSP 核对

`CSP` 常量（http.ts:82）**一字不改**：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`。Vue 侧对应约束：

| 约束                 | 落实                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无内联脚本 / eval    | runtime-only Vue + SFC 预编译；`theme-init.js` 外链；产物守卫 + P0 浏览器探针（§4.4.1）+ visual 断言 `securitypolicyviolation` 为 0                                                                                                                                                                                                                |
| 无内联样式           | SFC 禁 `<style>` 块；模板**禁止静态 `style="…"`**（会进静态提升的 `innerHTML` 字符串而被 CSP 丢弃；源码扫描 + 产物字符串扫描双重兜底）；动态值只允许 `:style` **对象**绑定（Vue 走 CSSOM `style.setProperty`）——是否真的不受 `style-src 'self'` 限制由 P0 探针在真实 Chromium 里判定，判不过即全面禁用 `:style`，改用类名 + `<meter>`/`<progress>` |
| 无外部资源           | 系统字体、SVG sprite 同文档 `<use href="#i-…">`；favicon 同源                                                                                                                                                                                                                                                                                      |
| `connect-src 'self'` | fetch/EventSource 只打同源 `/api/*`（两个 client 不变）                                                                                                                                                                                                                                                                                            |

### 2.3 pi 侧提示（`/webhub status` / `open`）

- `src/web-hub/agent/index.ts` 的 `readHubJsonRecord` 增解析 `ui`（结构校验失败当作缺失）；新增纯函数模块 `src/web-hub/agent/ui-status.ts`：`formatUiStatusLines(ui, { pkgDir, version, releaseUrl })`：
  - `ok` ⇒ 一行 `ui=ok source=package|external v<ver> commit=<c> builtAt=<t>`（info）。
  - `unbuilt` ⇒ warning：每个候选一行 `ui candidate <kind> <dir>: <reason> (<detail>)`，随后给出 §2.1 的两种安装方式（主机本地，绝对路径照常显示）。
  - hub.json 无 `ui`（hub 未运行或旧 hub）⇒ 回退为本地检查 `existsSync(<packageUiDistDir()>/build-info.json)`，缺失时给出同样的安装方式并注明「hub 未上报 UI 状态」。
- `src/commands/webhub.ts`：`runStatus` 追加这些行；`open` 在 `unbuilt` 时追加同样的 warning（仍照常打开浏览器——未构建页本身也给步骤）。
- 分工：P5b 落 `ui` 上报链路 + 方式二文案；方式一（release 附件）文案与 README 由 P7 补（P7 在 P5b 之后串行，改同一批文件不冲突）。

### 2.4 旧前端删除：P5b 一次性切换（用户已定）

- P0–P4、P5a、P6 期间：hub **继续服务旧前端**（`src/web-hub/web/`，不改 static.ts / http.ts），新 UI 只在 `dev:hub` 下预览 ⇒ 这些包各自可独立合入、线上零可见变化。
- P5b 一个提交内完成：`ui-root` 接线 + 未构建页 + 删除旧 UI 的 DOM 层文件 + 迁移纯逻辑 + 迁移/删除旧测试 + 文档。回滚 = revert 这一个提交（P5a 的纯新增模块不接线时惰性，可留）。
- 不做 `webHub.ui: legacy|vue` 运行时开关：要维护两套 static 映射与测试，且旧 UI 的纯逻辑已被新 UI 复用、DOM 层没有保留价值。

## 3. 前端架构

### 3.1 纯逻辑复用（`@logic` 别名）

`@logic` 在 P0–P4 指向 `src/web-hub/web/`，P5b `git mv` 到 `src/web-hub/ui/src/logic/` 后只改别名目标——UI 代码零改动。

| 旧文件                                                          | 处置                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.js`                                                      | 保留；P1 加 `route` 事件（§3.3）                                                                                                                            |
| `contract.js`                                                   | 保留 `API`、`SILENCE_MS`、`HISTORY_LIMIT_MAX`；新 UI 的 `SSE_EVENTS`/`API_ERRORS`/负载类型从 `@protocol/http-contract.js` 直接 import                       |
| `app.js` 的 `createClient`、`readHashToken`、`TOKEN_KEY` 等     | **P0 抽到 `token-client.js`**（旧 `app.js` 改为 import 它，行为不变）。原因：`app.js` 末尾有「存在 `#app` 就自动挂载旧 UI」的副作用，新 UI 绝不能 import 它 |
| `password-client.js`                                            | 原样保留                                                                                                                                                    |
| `render/fleet.js`                                               | 保留 `fleetTree`；`renderFleet` 在 P5b 删                                                                                                                   |
| `render/tools.js`                                               | 保留 `toolView`/`summarizeArgs`/`safeJson`；`renderToolCard`/`pre` P5b 删                                                                                   |
| `render/agents.js`                                              | 保留 `agentCardModel`/`shortCwd`/`costLabel`；`renderAgentList` P5b 删                                                                                      |
| `render/banner.js`                                              | 保留 `bannerText`；`renderBanner` P5b 删                                                                                                                    |
| `render/markdown.js`                                            | 保留 `parseMarkdown`/`isSafeHref`；`toDom`/`renderMarkdown` P5b 删                                                                                          |
| `render/transcript.js`                                          | 保留 `messageText`/`itemRenderKey`/（导出 `indexTools`）；`renderTranscript`/`renderItem` 等 P5b 删                                                         |
| `render/dom.js`                                                 | `formatUsd`/`formatDuration`/`clip` 迁到 `format.ts`（P1 先复制并加 Intl 版，P5b 删原文件）；`el`/`appendAll` P5b 删                                        |
| `render/login.js`、`index.html`、`style.css`、`app.js` 余下部分 | P5b 删                                                                                                                                                      |

### 3.2 组件树 → 文件（`src/web-hub/ui/src/components/`；Props/Emits 接口冻结在 P0 的 `contracts.ts`，组件文件由 P3/P4 新建）

```
App.vue                    挑 LoginView | TokenGate | DashboardView；持有 useHub()；渲染 IconSprite + Announcer
shell/
  LoginView.vue            props { plaintext: boolean; busy: boolean; error: LoginErrorView | null; initialPasswordHint: boolean }  emits submit({ username, password })
  TokenGate.vue            props { reason: "token-invalid" | "auth-mode-unknown" }
  DashboardView.vue        props { hub: HubHandle; route: Route }                   ⇐ 布局：<768 列表⇄详情，≥768 分栏
  TopBar.vue               props { conn: ConnState; hubVersion: string | null; canSignOut: boolean; theme: ThemePref }  emits signout, update:theme
  ThemeToggle.vue          props { modelValue: ThemePref }  emits update:modelValue    ⇐ 三态分段按钮（system/light/dark），role=radiogroup
  NoticeStack.vue          props { notices: Notice[] }  emits action(id)
  NoticeBanner.vue         props { notice: Notice; compact?: boolean }  emits action
  EmptyState.vue           props { icon: IconName; title: string; body?: string }  slot actions
agents/
  AgentList.vue            props { cards: AgentCardView[]; selectedKey: string | null; filter: string }  emits update:filter
  AgentCard.vue            props { card: AgentCardView; selected: boolean }           ⇐ <a :href="#/agent/…">
detail/
  AgentDetail.vue          props { agent: AgentState; now: number; narrow: boolean }  emits back, retry, load-older
  DetailHeader.vue         props { agent: AgentState; narrow: boolean }  emits back
  SessionInfo.vue          props { session: SessionInfo | undefined; card: AgentCard | undefined }
  CopyButton.vue           props { value: string; label: string }
  ContextMeter.vue         props { percent: number | null; tokens?: number; window?: number; compact?: boolean }
  StatusPill.vue           props { state: RunVisualState; label: string }
  DetailDock.vue           props { following: boolean; newCount: number }  emits update:following, jump
body/                      （接缝：P0 占位 → P4 接管）
  DetailBody.vue           props { agent: AgentState; now: number; following: boolean; narrow: boolean }  emits load-older, update:following, new-count(n)   ⇐ 内含 FleetPanel + Transcript；P3 的 AgentDetail 只 import 它
fleet/                     （P4）
  FleetPanel.vue           props { rows: FleetRowWire[]; now: number; defaultOpen: boolean }
  FleetNode.vue            props { node: FleetTreeNode; depth: number; now: number }  （递归）
transcript/                （P4）
  Transcript.vue           props { agent: AgentState; following: boolean; narrow: boolean }  emits load-older, update:following, new-count(n)
  TxUser.vue  TxAssistant.vue  TxCustom.vue  TxDivider.vue  TxError.vue  TxHiddenGap.vue
  ThinkingBlock.vue  ToolCard.vue（props { view: ToolView }）  CodeBlock.vue（props { lang: string; text: string }）
  MarkdownView.vue         props { text: string }  —— parseMarkdown() → AST → MdBlock/MdInline 递归渲染；绝不 v-html
  MdBlock.vue  MdInline.vue
```

视图模型类型（`AgentCardView`、`Notice`、`RunVisualState`、`FleetTreeNode`、`LoginErrorView`、`Route`、`ThemePref`、`ConnState`）集中在 `src/web-hub/ui/src/types.ts`（P0 建、冻结；扩展只能加可选字段）；各组件 Props/Emits 接口（如 `AgentCardProps`、`DetailBodyEmits`）集中在 `contracts.ts`（P0 冻结），组件内 `defineProps<AgentCardProps>()` / `defineEmits<DetailBodyEmits>()` 直接引用（Vue ≥3.3 支持导入类型），签名漂移即 `vue-tsc` 报错。`RunVisualState` 映射 ui-design §3.2 的状态表，映射函数 `runVisualState(row | agent)` 在 P1 的 `composables/visual-state.ts`（纯函数，测试穷举 §3.2 每行）。

### 3.3 状态管理（不引 Pinia）

- `useHub(win)`：`let raw = initialState()`（普通变量）；`dispatch(msg)` 同步 `raw = reduce(raw, msg)` 并立即跑副作用（订阅/退订/重同步限速/分页，照搬 `wireFleetUi.effects` 语义）；**视图状态** `const state = shallowRef(raw)` 由 renderGate 决定何时 `state.value = raw`。reducer 本就返回新对象，`shallowRef` 引用变化即可驱动更新，不做深层代理（大会话下省内存省 CPU）。
- 副作用基于 `raw`，不受渲染节流影响——#25 现象中「网络请求照发、DOM 不动」的根因在渲染而非副作用，这一层保持同步。
- **`state.js` 兼容性扩展（P1）**：新增本地事件 `route {agentKey: string | null}`：设 `s.routed = true`、`s.wanted = agentKey`；`routed` 为真时 `withSelection` 不再自动选第一个，而是「`wanted` 存在于 `agents` ⇒ 选中，否则 `selected = null`」；`agents`/`agent_up` 到达时重新评估 `wanted`（深链先于 agents 帧也能落地）。旧 UI 从不派发 `route`，`routed` 恒假，行为逐字节不变（用现有 state.test.ts 全绿 + 新增用例证明）。
- 局部 UI 态（折叠、跟随、过滤词、窗口起点）留在组件内；Fleet 折叠态用 `Map<runId, boolean>` 放 FleetPanel 内，切 agent 时重置。偏好只有主题进 localStorage。

### 3.4 传输层（吸取 #25 教训：两种模式接口用类型 + 测试强制一致）

```ts
// transport/types.ts（冻结）
export type ConnState = "connecting" | "open" | "reconnecting" | "auth";
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export interface TransportHooks {
  onMessage(msg: Msg): void;
  onConn(state: ConnState): void;
}
export interface HubTransport {
  readonly mode: "token" | "password";
  start(): Promise<void>;
  close(): void;
  subscribe(clientId: string, agentKey: string): Promise<{ ok: boolean; error?: string }>;
  unsubscribe(clientId: string, agentKey: string): Promise<void>;
  page(agentKey: string, before: string, limit?: number): Promise<Result<HistoryPayload>>;
}
export interface PasswordTransport extends HubTransport {
  readonly mode: "password";
  login(username: string, password: string): Promise<LoginResult>; // LoginResult = password-client.js 现有返回形状（ok | kind: throttled/invalid/saturated/not-allowed/busy-exhausted/network/…）
  logout(): Promise<void>;
}
```

- `token.ts` / `password.ts` 是薄适配器，返回值以 `satisfies HubTransport` / `satisfies PasswordTransport` 声明 ⇒ JS client 缺方法或签名变了，`vue-tsc` 直接报错（JSDoc 推断出的类型参与检查）。
- 运行时契约测试 `tests/web-hub/ui/transport-contract.test.ts`：`describe.each([token, password])` 跑**同一套**用例（假 fetch / EventSource / 时钟）：方法齐全；`subscribe` 打 `POST /api/subscribe` 带 `X-PWH: 1` 与 JSON；`unsubscribe` 同理；`page` 打 `GET /api/history?agent&before&limit` 且 limit 夹到 `HISTORY_LIMIT_MAX`；401 行为各自符合模式（token：一次静默重登；password：`onConn("auth")`）；`close()` 清掉所有定时器。任一模式缺实现，这套 each 就会红——正是 78dd76b 那次「password client 没有 subscribe/page ⇒ LAN 历史不加载」的回归点。

### 3.5 渲染调度（节流 ≤10/s，不依赖 rAF；隐藏页规则唯一化）

`composables/renderGate.ts`：`createRenderGate({ commit, intervalMs = 100, hiddenPollMs = 1000, setTimeout, clearTimeout, now, doc, win })` 返回 `{ request(priority: "now" | "throttle"), dispose() }`。`commit()` 即 `state.value = raw`（Vue 随后在微任务里 patch DOM）。

**唯一规则：`doc.hidden` 为真时，任何优先级、任何路径都不 `commit`（因而不写 DOM）。** 所有路径汇到一个内部 `tryCommit(reason)`：

```text
tryCommit(reason):
  if doc.hidden:   pending = true; armHiddenPoll(); return      // 不写 DOM
  cancel(throttleTimer, hiddenPoll); pending = false; lastCommit = now(); commit()
```

| 触发                                                                                                                                         | 可见时                                                                           | 隐藏时                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| `request("now")`（`select`/`route`/`conn`/`hello`/`agents`/`history`/`page*`/`subscribe*`/`agent_*`/`session`/`status`/`prompt` 等离散事件） | `queueMicrotask(tryCommit)`（去重）；微任务执行时再判一次 `doc.hidden`           | 只置 `pending` + 挂轮询，不排微任务  |
| `request("throttle")`（`ev` 中的 `message_update`/`tool_execution_update`，以及 `fleet`）                                                    | 距上次 commit ≥ interval ⇒ 立即；否则排一个后沿 `setTimeout`，回调里 `tryCommit` | 同上                                 |
| `visibilitychange` → `visible`、`pageshow`（含 bfcache 恢复）、`window` `focus`                                                              | **同步** `tryCommit`（有 `pending` 时）                                          | —                                    |
| 隐藏轮询 `hiddenPoll`（`hiddenPollMs` = 1s，best-effort）                                                                                    | 发现已可见（可见性事件被漏掉/延迟）⇒ `tryCommit`                                 | 仍隐藏 ⇒ 不写，若仍 `pending` 则重挂 |

- 1s 轮询只是「漏掉可见性事件」的兜底，不是隐藏期渲染：浏览器对隐藏页定时器的节流（≥1s，深度节流可达 1min）只会让它更晚，而回前台的 `visibilitychange`/`pageshow`/`focus` 三路任一都会同步 flush，因此**回前台必 flush、无永久停滞**。
- **无丢更新**：`raw` 是 reducer 的累计状态，`commit` 总是写最新 `raw`；隐藏期间 N 次更新被合并为回前台的一次 commit，不存在被丢弃的中间帧语义。
- 副作用（订阅/分页/重同步）基于 `raw` 同步执行，不受渲染闸门影响（#25 中网络照发、DOM 不动的根因在渲染层）。
- 其它 DOM 写入源同样服从隐藏规则：`useTicker` 隐藏即停表、可见时校正；`useAnnouncer` 隐藏期只排队不写 live region，可见后合并播报一次；本地 UI 态只由用户交互驱动（隐藏期不可能发生）。
- **源码禁用 `requestAnimationFrame`**（扫描测试）；Vue 调度基于 Promise 微任务，不受隐藏 tab 影响；不使用 `<Transition>`（内部用 rAF）。

**验收（P1 `render-gate.test.ts` + `render-gate-property.test.ts`，happy-dom + 假时钟，移植 `mount.test.ts` 的 #25 用例）**：

1. 隐藏状态下连续派发 `now` 与 `throttle` 事件、推进假时钟 10s：`MutationObserver` 记录的 DOM 变更数 = 0。
2. 翻为可见并派发 `visibilitychange`：事件回调返回后 `await nextTick()`（不推进任何定时器）DOM 即为最新；`pageshow`（`persisted: true`）与 `focus` 同样成立。
3. 翻为可见但**不**派发任何事件：推进 ≤ `hiddenPollMs` 后 DOM 为最新（兜底生效）；保持隐藏则永不写 DOM。
4. 属性测试（fast-check，已是 devDep）：随机交错「事件派发 / 隐藏⇄可见切换 / 时钟推进」序列，结束时置可见并派发 `visibilitychange`，断言渲染状态 `===` 依次 reduce 全部事件的结果（无丢更新），且隐藏区间内 DOM 变更数恒为 0。
5. 可见时 100 帧 `message_update` 在 1s 内 commit ≤ 11 次；离散事件不被节流（同一微任务内 commit）。
6. `dispose()` 后无残留定时器与监听器（注入的 `setTimeout`/`addEventListener` 计数归零）。

真实浏览器上的「切后台再切回 DOM 追上」放在 §4.6 真机验收（无头 Chromium 无法可靠模拟 `document.hidden`）。

### 3.6 历史、窗口化、滚动（手机性能）

- `computeWindow({ len, start, cap, pageSize })` 纯函数：默认窗口 = 最后 `N`（`matchMedia("(max-width: 480px)")` ⇒ 80，否则 200）；上限 `cap = 300` 个挂载条目。顶部「N earlier hidden · Show」把 `start` 前移 `N`，超过 cap 时尾部同步收窄并在底部出现「N newer hidden · Jump to latest」（跟随自动关闭）；`start === 0 && hasMore` 时顶部按钮/距顶 `PAGE_TRIGGER_PX` 触发 `hub.loadOlder`（hub 分页 ≤400），前插后 `start` 按前插数平移以保持锚点。
- 滚动锚点：`watch(items, …, { flush: "pre" })` 记录 `scrollHeight/scrollTop/nearBottom`，`flush: "post"` 回调里补偿（等价旧 `prevTop + Δheight`）；跟随开启且 nearBottom ⇒ 贴底。不用 rAF。
- 已定稿条目：`v-for` key = `item.id`，`v-memo="[itemRenderKey(it, idx), toolsVersion]"`；只有 `agent.streaming` 尾部消息每次重解析 markdown（`MarkdownView` 内 `computed(() => parseMarkdown(text))`）。
- `.tx-item { content-visibility: auto; contain-intrinsic-size: auto 120px }`（样稿已有）。
- 工具 partial：展示层只取尾部 200 行 / 16 KiB（`tailLines()` 纯函数），「Show full output」才渲染全量；state 保存全量不变。
- 虚拟滚动不做：agent 列表通常个位数（>50 才需要），transcript 靠窗口化 + content-visibility 已够，且虚拟化与「跟随 + 前插锚点」交互复杂、易出 bug。

### 3.7 路由（hash 深链）

`useHashRoute(win)`：`#/` ⇒ `{ name: "list" }`；`#/agent/<encodeURIComponent(key)>` ⇒ `{ name: "agent", key }`；其他（含 `#t=` 登录令牌）⇒ 不解析、视为 list。**顺序约束**：token 模式下 `token-client` 的 `start()` 先消费 `#t=` 并 `replaceState` 清 hash，路由在 `start()` 返回后才开始监听 `hashchange`（测试覆盖：带 `#t=` 打开不会把令牌当 agentKey，也不会进 history）。卡片是真实 `<a href>`（pushState 语义天然可后退）；详情返回按钮：`history.length > 1 && 来自本应用` ⇒ `history.back()`，否则 `location.replace("#/")`；<768 时 Esc 返回。路由变化 ⇒ `dispatch({ event: "route", data: { agentKey } })`。列表滚动位置在 <768 视图切换时手动记录/恢复（不用 KeepAlive，列表始终挂载、只切 `hidden`）。

### 3.8 i18n

- `detectLang(navigator.languages)`：首个以 `zh` 开头 ⇒ `zh`，否则 `en`；设置 `<html lang="zh-CN|en">`。不提供手动切换（未要求）。
- 词典按命名空间分文件；`zh/*.ts` 以 `satisfies Messages<typeof en.ns>` 约束 key 完全一致 ⇒ 缺/多 key 即 `vue-tsc` 报错；另有 `i18n-parity.test.ts` 在运行时比对 key 集与 `{param}` 占位符集。
- `t(key, params)` 只做 `{name}` 替换，返回纯文本（组件用插值 `{{ }}`，永不当 HTML）。含命令的句子拆成「文本 + `<code>` 片段」两个 key，避免在译文里嵌标记。
- 标识符（路径/模型/命令/sessionId）元素加 `translate="no"`。数字/时间用 `Intl.*` 且 locale 与 lang 一致。
- 登录错误文案从 `app.js` 迁入 `login` 命名空间（中英两套）；`usePasswordAuth` 把 `LoginResult.kind` 映射成 `LoginErrorView { key, params, countdownS? }`。

### 3.9 主题

- `ThemePref = "system" | "light" | "dark"`，localStorage 键 `pwh_theme`（只存偏好，非敏感）；默认 `system`。
- `public/theme-init.js`（≈10 行，try/catch 包裹）在首帧前读偏好，给 `<html>` 加 `theme-light` / `theme-dark`（`system` 不加类，交给 tokens.css 的 `prefers-color-scheme`）；`useTheme()` 运行期切换同一对类，并更新 `<meta name="theme-color">`。
- TopBar 放 `ThemeToggle`（三态分段按钮，44px 命中区，`aria-label`），手机上收进顶栏右侧图标按钮循环切换。

### 3.10 markdown 安全渲染

- 解析沿用 `parseMarkdown`（已测的安全子集）；渲染改为 `MdBlock`/`MdInline` 递归组件：只产出 `p/h1-6(降级为 h3-h6 视觉)/ul/ol/li/code/pre/strong/em/a` 元素 + 文本插值。
- 链接：`isSafeHref(href)` 为真才渲染 `<a :href rel="noopener noreferrer" target="_blank">`，否则渲染为纯文本；图片一律 `[image]` 占位。
- 移植 `markdown.test.ts` 的 XSS 语料到组件测试：挂载后 DOM 中不存在 `script/iframe/img[src]/[on*]/[style]`，所有 `a[href]` 以 `http(s)://` 开头，`textContent` 保留原文。

### 3.11 版本错配

- **硬门在 hub 侧**（§2.1 #4）：`build-info.version ≠ hubVersion` 或 `proto.major` 不一致的根根本不会被服务，直接落到下一候选或未构建页（页上写明原因与重建/下载步骤）。因此 UI 不再需要 v1 的「版本不一致」横幅。
- **软提示在 UI 侧**：`__PWH_UI_BUILD__.commit` 与 `hub` 帧的 `buildId`（`<ver>@<commit>`）commit 部分不同且两边都不是 `unknown` 时，显示 info 横幅「界面构建于 <c1>，hub 为 <c2>，建议重新 `npm run build:web`」——覆盖本地路径安装者同版本号下拉了新提交却忘了重建的情况。

### 3.12 可访问性

照 ui-design §11 落地：skip link、`nav/main/section` 地标、sr-only `h1`、`aria-current="page"`、原生 `<details>`/`button[aria-expanded]`、单一 sr-only `role="status"`（`useAnnouncer`，节流 ≥2s）、transcript 非 live region、装饰 SVG `aria-hidden`、纯图标按钮必带 `aria-label`、`@media (pointer: coarse)` 44px。

## 4. 测试策略

### 4.1 旧测试处置（`tests/web-hub/web/`）

| 文件                                                                                         | 处置                                                                                                                                                  | 包               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `state.test.ts`                                                                              | 保留；P1 追加 `route` 用例；P5b 改 import 路径                                                                                                        | P1 / P5b         |
| `client.test.ts`                                                                             | 保留（改 import 到 `token-client.js`）                                                                                                                | P0 / P5b         |
| `client-password.test.ts`                                                                    | 保留，P5b 改路径                                                                                                                                      | P5b              |
| `contract.test.ts`                                                                           | 保留「reduce 接受全部 SSE 事件」「API 路径」；镜像数组比对改为断言 UI 侧 re-export 与 protocol 为同一引用                                             | P5b              |
| `markdown.test.ts`                                                                           | parse 部分保留；`toDom` 部分迁为 `MarkdownView` 组件测试                                                                                              | P4 / P5b         |
| `render.test.ts`                                                                             | 纯函数（fleetTree/toolView/agentCardModel/bannerText/format）保留；DOM 断言迁为组件测试                                                               | P3/P4 / P5b      |
| `mount.test.ts`                                                                              | 订阅副作用、重同步限速、分页、**#25 rAF 挂起回归** 迁为 `useHub`/`renderGate` 测试                                                                    | P1 / P5b 删      |
| `login.test.ts`                                                                              | 流程（错误 kind → 文案、倒计时、提交后清密码）迁为 `usePasswordAuth` + `LoginView` 测试                                                               | P1/P3 / P5b 删   |
| `auth-mode.test.ts`                                                                          | 三态门迁为 `App.vue` 测试（缺/非法 `data-auth-mode` ⇒ 不读 `#t=`、不碰 localStorage、不发请求、不开 SSE）                                             | P3 / P5b 删      |
| `fake-dom.ts`                                                                                | 随上述删除                                                                                                                                            | P5b              |
| `no-innerhtml.test.ts`                                                                       | 由 `tests/web-hub/ui/source-scan.test.ts` 取代（§4.3）                                                                                                | P0 建 / P5b 删旧 |
| `tests/web-hub/http/static.test.ts`                                                          | 更新映射（去掉 `/assets/<p>` → `<root>/<p>` 回退、顶层白名单）、`uiRoot` 断言、缓存头、未构建页（token 显示路径 / password 不显示 / Accept-Language） | P5b              |
| `tests/web-hub/http/lan-static.test.ts` / `lan-host.test.ts` / `lan-password-client.test.ts` | 保留；后者改 import 路径；`lan-host` 的「/ 为 200 且无占位符」在未构建时依然成立（未构建页 200）                                                      | P5b              |
| `tests/integration/web-hub-*.test.ts`                                                        | 均为协议层（真 socket + 真 hub + 原始 HTTP/SSE 客户端），不碰前端文件 ⇒ **不受影响**，零改动                                                          | —                |

### 4.2 新增测试（`tests/web-hub/ui/`，组件测试文件头 `// @vitest-environment happy-dom`）

- 逻辑：`render-gate.test.ts`、`use-hub.test.ts`（副作用 + 限速 + 分页 + 路由）、`transport-contract.test.ts`（§3.4）、`hash-route.test.ts`、`theme.test.ts`（含 theme-init.js 在 happy-dom 中执行）、`i18n-parity.test.ts`、`visual-state.test.ts`、`transcript-window.test.ts`、`format.test.ts`、`password-auth.test.ts`。
- 组件：`app-gate.test.ts`、`login-view.test.ts`、`agent-list.test.ts`、`detail-header.test.ts`、`notices.test.ts`、`fleet.test.ts`（嵌套/折叠/深度≥3 默认折叠/Show N Finished）、`transcript.test.ts`（窗口 ≤300 个 `.tx-item`、前插锚点、跟随开关、新消息计数）、`markdown-view.test.ts`（XSS 语料）、`tool-card.test.ts`（partial 截尾）。
- 产物：`tests/integration/web-hub-ui-dist.test.ts`——`existsSync(dist/web-hub-ui/index.html)` 为假时：`PWH_REQUIRE_UI_DIST=1` ⇒ 失败，否则 `skip`。用 `createHttpFrontend` + `fakeDeps`（`tests/web-hub/http/helpers.ts`）起真 hub 前端：`GET /` 200、占位符已替换为 `token`、带 CSP 头；index 引用的每个 `/assets/*` 200 + `immutable`；`/theme-init.js` `no-cache`；`/assets/../package.json` 等穿越 404。
- **真实 HTTP 集成回归（P1，`tests/web-hub/ui/hub-http-integration.test.ts`）**——契约测试（§3.4）两边都用假 fetch/EventSource，抓不住「client 与真 hub 字段/标签不一致」这类 78dd76b / LC #6/#7 式回归，故再加一层真链路：
  - 装配：`tests/web-hub/http/lan-helpers.ts` 的 `startLan` + `seedLanUser` 起真 `createHttpFrontend` LAN 监听；registry/history 假件提供 1 个 agent + 450 条历史；前端侧用**真** `createPasswordClient` → `createPasswordTransport` → `useHub`（在 `effectScope` 里跑，无需 DOM）；fetch 适配沿用 `lan-password-client.test.ts` 的 `fetchViaLan`，SSE 适配复用 lan-helpers 现有的原始 `node:http` SSE 读取器（`:245`）包成 client 需要的 `EventSource` 子集（`onopen/onerror/addEventListener/close/readyState`）。定时器经注入的 `setTimeout/clearTimeout/setInterval` 计数。
  - 用例：① 首次订阅：登录 → SSE `agents` 帧 → `route` 到该 agent → 真 `POST /api/subscribe` → 历史快照进入 `raw`（尾部 400 条、`hasMore`）；② 历史分页：`loadOlder` → 真 `GET /api/history?before` → 前插 50 条且 `hasMore=false`；③ 401/auth：服务端使会话失效 → 下一请求 401 → `conn = "auth"`、回到登录态、401 之后请求数 ≤1（无重试风暴）；④ 登出：`logout()` → cookie 失效、SSE 关闭、状态复位、之后零请求；⑤ 重连：服务端断开 SSE → `reconnecting` → 重新 `open` → 重同步且对当前 agent **恰好一次**重新订阅；⑥ 定时器清理：`close()` + scope `stop()` 后注入计数的活跃定时器 = 0、服务端 SSE 连接数 = 0。
  - token 模式用回环 `createHttpFrontend`（`tests/web-hub/http/helpers.ts`）跑同一套 `describe.each`（③ 改为 token 失效后的一次静默重登），password 为必过项。
- **UI 根解析（P5a，`tests/web-hub/hub/ui-root.test.ts`，真 tmp 目录 + 注入 `FsDeps`）**：穿越（清单 path 含 `..`、绝对路径、反斜杠、`assets/a/b.js` 多层、URL `%2e%2e`）；软链（根本身、`assets/` 子目录、文件指向根内与根外、`build-info.json` 软链）；非私有（根 / 父目录 / 子目录 / 文件 `g+w`、`o+w`，注入 `getuid` 模拟他人属主，uid 0 放行）；版本错配（version、proto.major）；错误 hash、bytes 不符、清单漏列（文件不存在）与多余文件（不服务但不拒根）、`too-large`、解析超时；候选回退（package 坏 + external 好 ⇒ external；都坏 ⇒ unbuilt 且 `candidates` 两条原因）；TOCTOU（解析后改写磁盘文件内容但不动 build-info ⇒ 仍出校验过的字节）；换代（改 build-info 后 ≥1s 的 `/` 请求触发重解析；资源请求不触发）。`tests/web-hub/protocol/paths-trusted.test.ts` 覆盖 `checkTrustedEntry`。
- **未构建页（P5a，`tests/web-hub/hub/unbuilt.test.ts`）**：zh/en 按 Accept-Language；token 模式含 pkgDir 与候选原因；password 模式正文不含 pkgDir、`home`、任何 `/<段>/<段>` 形式的绝对路径（正则扫描，允许 `~/.pi/agent/` 与 release URL）、不含 reason；无 `<script>`/`<style>`/`style=`/`on*=`。
- **pi 侧状态（P5b，`tests/web-hub/agent/ui-status.test.ts`）**：`formatUiStatusLines` 覆盖 ok / unbuilt / hub.json 无 `ui` 回退。
- **UI zip 结构（P7，`tests/release/web-ui-zip.test.ts`）**：fixture 产物在测试里生成（静态小文件 + 用 `ui-manifest.ts` 同一套逻辑现算的 build-info，避免 fixture 过期），`PWH_UI_DIST=<tmp>` 驱动 `package-web-ui.sh`：`unzip -Z1` 条目全部以 `web-hub-ui/<ver>/` 开头、文件集合 = 清单 + `build-info.json`、无 `..`/绝对路径/软链条目；`zipinfo` 模式为 `-rw-r--r--` / `drwxr-xr-x`；`.sha256` 格式与内容正确；version 不符或产物含软链 ⇒ 脚本非零退出；最后解压到 tmp `home/.pi/agent/` 并用 `createUiServer`（包内候选指向不存在目录）解析 ⇒ `source: "external"`，`GET /` 200 且为真 index。`zip`/`unzip` 缺失时跳过，但 `CI` 下失败（ubuntu-latest 自带）。

### 4.3 静态扫描（取代 `no-innerhtml.test.ts`）

`tests/web-hub/ui/source-scan.test.ts` 扫 `src/web-hub/ui/{index.html,public/**,src/**/*.{vue,ts,js}}`（P5b 后含 `src/logic/**`），剥注释后禁止：`v-html`、`innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`eval(`、`new Function`、字符串 `setTimeout`、`createContextualFragment`、`DOMParser`、`srcdoc`、`.on<x>=` 属性赋值、`setAttribute('on…'|'style')`、模板静态 `style="`、`template:` 选项、`requestAnimationFrame`、`<Transition`、`<script>` 无 `src`（index.html）、`http(s)://` 资源引用（`<link>/<script>/<img>/url()`）、`localStorage` 出现在 `theme`/`token-client` 之外（密码不落盘的静态兜底）。首个用例断言扫描到的文件清单包含关键文件，防止 glob 失效后「零文件全绿」。

v2 追加：`.vue` 中禁止 `<style` 块；产物层另由 `check:web` 扫编译后 JS 字符串中的 `style=` / `on<x>=` / `<style` / `<script` 片段（§1.2，覆盖 Vue 静态提升）。

### 4.4 浏览器级验收（Playwright，本机，非 CI）

所有脚本经 `scripts/web-hub/lib/playwright.ts` 加载本机 npx 缓存的 `playwright@1.62.1` + 已缓存 Chromium（离线优先，§1.4）；退出码 0 = 通过、1 = 断言失败、2 = 浏览器不可用。

#### 4.4.1 P0 CSP 探针（`npm run probe:csp`，P0 必做，结果写入 P0 报告）

- 产物：`vite build --mode csp-probe`——同一份 `vite.config.ts`（同插件、同 `define`、同 build 选项），只把入口换成 `src/web-hub/ui/csp-probe/{index,negative}.html`、outDir 换成 `node_modules/.cache/pwh-csp-probe/`，因此测的就是正式构建链路的真实行为。
- 服务：脚本内起 `127.0.0.1` 小服务器，响应头 `Content-Security-Policy` 取 **http.ts 导出的 `CSP` 常量**（直接 import，不抄写）+ `X-Content-Type-Options: nosniff`，静态文件用现有 `serveStatic(root, …)`（P5b 之前它仍在）。
- `Probe.vue` 覆盖：(a) `:style="{ '--pct': '42%' }"` 的元素，其 CSS（外链 css 文件内）为 `width: var(--pct)`；(b) `:style="{ width: '10px' }"`；(c) `v-show` 切换；(d) ≥25 个连续纯静态兄弟节点（确保触发静态字符串化），只带 class/data 属性；(e) 数值型动态 class 切换。
- 断言（在未 bypassCSP 的 context）：页面生命周期内 `securitypolicyviolation` 事件 0；`document.querySelectorAll("style").length === 0`；每个 `<script>` 都有同源 `src`；`document.styleSheets` 每项都有同源 `href`（CSS 全外链）；(a) 计算宽度 = 父宽 × 42%，(b) 计算宽度 10px，(c) `display` 正确切换，(d) 节点全部渲染且外链 CSS 规则生效。
- **反向对照** `negative.html`：静态块中放一个静态 `style="color: rgb(1, 2, 3)"`，断言恰好收到 `style-src-attr` 违规且计算颜色 ≠ `rgb(1, 2, 3)`——证明探针能抓到违规（防假绿），也证明「禁止静态 `style=`」这条规则是必要的。
- 判定：(a)(b) 任一不过 ⇒ 源码扫描改为**全面禁止 `:style`**，百分比类展示改用 `<meter>`/`<progress>` 或按 5% 步进的类名；(c) 不过 ⇒ 禁 `v-show` 改 `v-if`。判定结果由主会话写回本文 §2.2 并推送给在跑的包。浏览器不可用（退出码 2）⇒ 同样按最保守口径禁用 `:style` 与 `v-show`，报告注明。

#### 4.4.2 视觉与 ui-design §6 断言（`npm run visual:web`）

对 `dev:hub` 起的假数据 hub（服务**真实产物** + 真实 CSP 头）：

- 框架（P2）：`scripts/web-hub/visual.ts` 负责起 dev-hub、遍历矩阵、截图到 `/tmp/pwh-visual/<run>/`、汇总报告；断言模块按包独占、由框架 `glob` 自动加载——`scripts/web-hub/visual/checks-common.ts`（P2：`securitypolicyviolation` 0、console error 0、非同源请求 0、失败请求 0、主题三态切换与刷新保持）、`checks-shell.ts`（P3）、`checks-body.ts`（P4）、`checks-e2e.ts`（P6，整合复核），框架文件不因加断言而改。
- 矩阵：宽度 **375 / 481 / 767 / 768 / 1024 / 1025**（另加 1440 截图）× `colorScheme` light/dark × 场景 dashboard / detail / login / states / long；≤767 以 `isMobile + hasTouch` 运行，另跑一遍 1024 `hasTouch` 覆盖 `pointer: coarse`；`reducedMotion: "reduce"` 得静态帧。
- 逐项断言（任一失败即非零退出）：

| ui-design | 断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 模块  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| §6.1      | 6 个宽度 × 列表/详情/登录/空态 × 浅/暗：`documentElement.scrollWidth === innerWidth`；375/481/767 单栏（列表与详情互斥可见），768/1024/1025 分栏（两者同时可见），侧栏宽 768/1024 = 260px、1025 = 288px；375 正文 `font-size` 16px 且卡片无头像；481/767 列表为网格且 767 下 ≥2 列                                                                                                                                                                                                                                                     | shell |
| §6.2      | 直接打开 `#/agent/<key>` 进详情；点卡片后 `history.length` +1，`goBack()` 回列表且列表 `scrollTop` 恢复；深链直达时详情返回按钮用 replace（`history.length` 不变、hash 变 `#/`）；不存在的 key 显示「not connected」空态；<768 按 Esc 返回；带 `#t=` 打开时令牌不进 history、不被当作 agentKey                                                                                                                                                                                                                                         | shell |
| §6.3      | `pointer: coarse` 下所有可交互元素（`a,button,input,summary,[role=button],label`）包围盒 ≥44×44；按钮组相邻间距 ≥8px；DOM 中无 `[title]`；按钮/卡片计算 `touch-action` 为 `manipulation`                                                                                                                                                                                                                                                                                                                                               | shell |
| §6.4      | 长代码块 / 工具 Output / thinking：块 `scrollWidth > clientWidth` 而文档不横向溢出，计算 `overscroll-behavior-x: contain`；超长无空格用户消息不溢出气泡；长路径单行省略；**375 下 Fleet 面板默认折叠**（只见汇总行、树不可见、`aria-expanded=false`），点开后展开且树区高度 ≤ 34dvh；768 下默认展开；非安全上下文下复制按钮回退为选区 + toast                                                                                                                                                                                          | body  |
| §6.5      | viewport meta 精确为 `width=device-width, initial-scale=1, viewport-fit=cover`（无 `maximum-scale`/`user-scalable`）；应用壳高度 === `innerHeight`，`setViewportSize` 改高后仍相等（dvh）；样式表 CSSOM 中 topbar / dock / 登录页规则含 `env(safe-area-inset-*)`（无头环境无法注入安全区，改查规则文本）；dock 计算 `position` 非 `fixed/sticky`，其矩形与 transcript 滚动区不重叠；在详情页用 Tab 遍历全部可聚焦元素，每个聚焦元素的矩形与 dock 矩形不相交且位于滚动区可视范围内（dock 不遮挡焦点）；375 下所有 `input` 计算字号 16px | shell |
| §6.6      | long 场景（1000 条）：`.tx-item` 挂载数 ≤300；375 首屏 ≤80、1024 首屏 ≤200；`.tx-item` 计算 `content-visibility: auto`；streaming 场景下 `MutationObserver` 按 1s 窗口统计批次 ≤10                                                                                                                                                                                                                                                                                                                                                     | body  |
| §6.7      | 375 下安全横幅（改初始密码、明文 HTTP）高度 ≤60px、计算 `-webkit-line-clamp: 2`，点击 `›` 后展开（高度增大、`aria-expanded=true`），横幅无关闭按钮；登录 375×812：卡片宽 ≤400、左右内边距 20px、登录按钮底边 ≤812（首屏可见）；输入框高 ≥44、字号 16px、`autocapitalize="none"`、`spellcheck="false"`；「显示密码」按钮 ≥44×44，点击后 `aria-pressed` 与输入框 `type` 在 `password`/`text` 间切换                                                                                                                                      | shell |

- axe：另开 `bypassCSP: true` 的 context 注入 `axe-core`（经 npx 缓存读取源码后 `page.evaluate`），dashboard/login/states × light/dark 违规 0。严格 CSP 检查只在未 bypass 的 context 做。
- 像素 diff 不设门槛（假数据与样稿文本不完全相同），由 verifier 并排读图判定「结构、配色、密度、层级与样稿一致」，偏差按**文件**列清单（便于 §5 退回原包）。

### 4.5 假数据 hub（`scripts/web-hub/dev-hub.ts`，P2）

独立小 HTTP 服务（`tsx`），**复用**真 `serveStatic`/`serveIndex`（P5b 前传入 `dist/web-hub-ui` 根；P5b 起改用 `createUiServer`）与 http.ts 的 `CSP` 常量、安全头；自己实现假 `/api/login|logout|session|subscribe|unsubscribe|history` 与 SSE：`--mode token|password`、`--scenario dashboard|states|empty|long|streaming`、`--login-error invalid|throttled|saturated|not-allowed|busy-exhausted|network`、`--port`。场景帧来自 `tests/fixtures/web-hub-ui/<scenario>.json`（SSE 帧数组 + 定时脚本；dashboard 内容照样稿：6 个 agent 覆盖 running/waiting/idle/outdated/stale/offline、嵌套子 agent 树、完成/出错/运行中工具卡、长代码块、流式消息；long = 1000 条），同一份 fixture 也喂组件测试。只监听 127.0.0.1，Host 校验同真 hub。

### 4.6 真机验收（P5b verifier 必做）

按 memory `live-acceptance-tmux.md`：tmux 起独立 pi（cwd 在 /tmp），开 `webHub.enabled`，`/webhub open` 拿 URL，用 Playwright：token 模式 agent 列表出现、选中后历史加载、流式消息实时出现、切到后台标签再切回 DOM 追上；LAN 模式（`webHub.lan.enabled`）登录 → 历史加载（#25 同类回归只在真 LAN 暴露过）→ 登出；删掉 `dist/web-hub-ui` 后 `/` 为未构建页、`/webhub status` 出现构建提示。测完按确切路径清理。

- v2 追加：**隐藏页**——Playwright 连真实 pi：详情页打开后新开标签页置前（`bringToFront`），在 pi 里触发几轮流式输出，再切回原标签，断言 1 个任务内（`visibilitychange` 后的首个 `waitForFunction`，超时 500ms）DOM 已含最新消息。**包外根（P7 verifier）**：删掉包内 `dist/web-hub-ui` → `/` 为未构建页（token 页含步骤与包目录，LAN 页不含绝对路径）→ 按页面步骤下载本次 release 构建出的 UI zip、`sha256sum -c`、解压到 `~/.pi/agent/` → 不重启 hub 刷新即得新 UI，`/webhub status` 显示 `ui=ok source=external`；再把 `web-hub-ui/<ver>` 改成 `g+w` ⇒ 刷新回到未构建页、status 显示 `mode` 原因。测完按确切路径清理。

## 5. 包拆分与并行

### 5.1 总览

| 包      | 内容                                                                      | 类型 / 模型（memory 路由）               | 依赖                          | 并行                           | 独立可合入           |
| ------- | ------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- | ------------------------------ | -------------------- |
| **P0**  | 最小骨架 + 冻结面 + build-info + CSP 探针                                 | general · `cr-anthropic/claude-sonnet-5` | 前置 §0.4                     | —                              | 是（用户零可见变化） |
| **P1**  | 传输 / composables / renderGate / 真 HTTP 集成回归                        | general · sonnet                         | P0                            | ∥ P2                           | 是                   |
| **P2**  | 假数据 hub + fixtures + visual 框架                                       | general · sonnet                         | P0                            | ∥ P1                           | 是                   |
| **P3**  | 外壳 / 列表 / 详情头 / 登录 / 横幅 + 其样式与断言                         | frontend-dev · sonnet                    | P1、P2                        | ∥ P4 ∥ P5a                     | 是                   |
| **P4**  | 子 agent 树 / 对话流 / markdown / 窗口化 + 其样式与断言                   | frontend-dev · sonnet                    | P1、P2                        | ∥ P3 ∥ P5a                     | 是                   |
| **P5a** | hub `ui-root` 解析校验 + 未构建页 + `checkTrustedEntry`（纯新增，不接线） | general · sonnet                         | P0（`ui-manifest.ts`）        | ∥ P3 ∥ P4                      | 是（惰性）           |
| **P6**  | 全矩阵验收（§4.4.2 + axe + 读图），偏差按文件退回 P3/P4                   | general · sonnet（只写断言/报告）        | P3、P4 **均已合入**           | 串行；∥ P5b 开发（文件不相交） | 是                   |
| **P5b** | 切换：接线 + hub.json `ui` + `/webhub status` + 删旧 UI + 迁移 + 文档     | general · sonnet                         | P3、P4、P5a；合并在 P6 通过后 | ∥ P6（开发期）                 | 是（原子切换提交）   |
| **P7**  | UI zip 打包 + zip 结构测试 + release 附件安装文案 + README                | general · sonnet                         | P5b                           | —                              | 是                   |

评审 / 验收：`cr-response/gpt-5.6-sol` ⇄ `zhipu-pool/gpt-5.6-sol`（≠ 开发模型）；每包返回**立即**派 verifier；主会话 `bash_job` 后台跑全量门禁（format:check / typecheck / build:web / check:web / test / build）。开发包一律挂 `experts: [本方案的 Plan label]`（v2 已改口径）。dev `timeout_s`：P0/P1/P2/P5a/P5b ≈ 1500，P3/P4 ≈ 2400，P6/P7 ≈ 900（硬上限，超时拆小重派）。

波次：**W1** P0 → **W2** P1 ∥ P2 → **W3** P3 ∥ P4 ∥ P5a → **W4** P6（P3、P4 合入后串行验收；退回的修复由原包在原文件内完成）∥ P5b 开发 → P6 通过后合 P5b（rebase 后复跑门禁）→ **W5** P7。

### 5.2 冻结面与独占文件

**冻结面（P0 合入后只有主会话能改）**：`package.json`、`package-lock.json`、`vitest.config.ts`、`src/web-hub/ui/{vite.config.ts,build-info-plugin.ts,aliases.ts,tsconfig.json}`、`src/web-hub/ui/src/{main.ts,types.ts,contracts.ts,transport/types.ts,i18n/index.ts,styles/tokens.css,icons/**}`、`src/web-hub/protocol/ui-manifest.ts`。流程：包发现需要改 ⇒ 停在当前步骤、在报告/消息里提出具体 diff → 主会话在 master 上改并单独提交 → 用 `steer_subagent` 把提交 sha 与改动摘要推给**所有在跑的包**（worktree 包在自己目录 `git cherry-pick <sha>`）→ 包继续。唯一授权例外：P5b 改 `aliases.ts` / `ui/tsconfig.json` 的 `@logic` 目标（此时无其它 UI 包在跑）。

**独占文件清单**（「新建」= 该包创建且之后只有它改；「接管」= P0 占位、该包整体替换；未列出的文件任何包都不得改，需要时走冻结面流程）：

| 包  | 独占文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | 冻结面全部（新建）；`tsconfig.json`、`tsconfig.build.json`（`exclude` 加 `src/web-hub/ui/**`）、`.github/workflows/ci.yml`；`src/web-hub/ui/{index.html,env.d.ts,public/theme-init.js,public/favicon.svg,csp-probe/**}`；`src/web-hub/ui/src/{App.vue(占位),build-info.ts,composables/useHashRoute.ts,composables/useI18n.ts,components/body/DetailBody.vue(占位)}`；`scripts/web-hub/{check-ui-dist.ts,csp-probe.ts,lib/playwright.ts}`；`src/web-hub/web/token-client.js`（新，自 `app.js` 抽出）+ `src/web-hub/web/app.js`（只改 import）；测试 `tests/web-hub/web/client.test.ts`（改 import）、`tests/web-hub/ui/{source-scan,smoke,hash-route,ui-manifest,i18n-parity,build-info-plugin}.test.ts`                                                                                                                         |
| P1  | `src/web-hub/ui/src/transport/{token,password}.ts`、`composables/{useHub,renderGate,usePasswordAuth,useTheme,useTicker,useClipboard,useAnnouncer,useTranscriptWindow,useFollowScroll,useMedia,visual-state}.ts`、`format.ts`、`i18n/{en,zh}/errors.ts`；`src/web-hub/web/state.js`（仅加 `route`/`routed`/`wanted`，兼容）；`tests/web-hub/web/state.test.ts`（追加）；`tests/web-hub/http/lan-helpers.ts`（仅追加 EventSource 适配，不改既有导出）；`tests/web-hub/ui/{render-gate,render-gate-property,use-hub,transport-contract,hub-http-integration,theme,visual-state,transcript-window,format,password-auth}.test.ts`                                                                                                                                                                                                    |
| P2  | `scripts/web-hub/{dev-hub.ts,visual.ts,visual/checks-common.ts}`、`tests/fixtures/web-hub-ui/*.json`、`tests/web-hub/ui/dev-hub.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P3  | `src/web-hub/ui/src/App.vue`（接管）、`components/{shell,agents,detail}/**`、`styles/{base,primitives,notices,shell,agents,detail,dock,login,states}.css`、`i18n/{en,zh}/{shell,login,agents,detail,notices,common}.ts`、`scripts/web-hub/visual/checks-shell.ts`、`tests/web-hub/ui/{app-gate,login-view,agent-list,detail-header,notices}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P4  | `src/web-hub/ui/src/components/body/DetailBody.vue`（接管）、`components/{fleet,transcript}/**`、`styles/{fleet,transcript}.css`、`i18n/{en,zh}/{fleet,transcript}.ts`、`scripts/web-hub/visual/checks-body.ts`、`tests/web-hub/ui/{detail-body,fleet,transcript,markdown-view,tool-card}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P5a | `src/web-hub/hub/{ui-root.ts,unbuilt.ts}`（新）、`src/web-hub/protocol/paths.ts`（仅追加 `packageUiDistDir` / `webHubUiDir` / `checkTrustedEntry`，不改既有导出）、`tests/web-hub/hub/{ui-root,unbuilt}.test.ts`、`tests/web-hub/protocol/paths-trusted.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P6  | `scripts/web-hub/visual/checks-e2e.ts`、`tests/fixtures/web-hub-ui/e2e-*.json`（新场景，若需要）；**不改** styles/components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P5b | `src/web-hub/hub/{static.ts,http.ts,hub.ts,hub-json.ts,ports.ts}`、`src/web-hub/agent/{index.ts,ui-status.ts(新)}`、`src/commands/webhub.ts`、`scripts/web-hub/{check-ui-dist.ts,dev-hub.ts}`（改用 `createUiServer` / 追加 `verifyUiRoot`）、`git mv src/web-hub/web/{state,contract,token-client,password-client}.js + render/{fleet,tools,agents,banner,markdown,transcript}.js → src/web-hub/ui/src/logic/` 并删其中 DOM 函数、删 `src/web-hub/web/` 其余文件、`aliases.ts`/`ui/tsconfig.json` 的 `@logic` 目标（授权例外）、`tests/web-hub/web/**` 迁移/删除（§4.1）、`tests/web-hub/http/{static,lan-static,lan-password-client}.test.ts`、`tests/web-hub/agent/ui-status.test.ts`、`tests/integration/web-hub-ui-dist.test.ts`（新）、`AGENTS.md` web-hub 段、`docs/dev/web-hub/arch.md`（§105「零构建」决策加废止注记） |
| P7  | `scripts/release/{package.sh,package-web-ui.sh(新)}`、`tests/release/web-ui-zip.test.ts`（新）、`src/web-hub/hub/unbuilt.ts` 与 `src/web-hub/agent/ui-status.ts` 的「方式一」文案段、`README.md`/`README.en.md` web-hub 段（构建 / release 附件安装 / git 安装说明）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 5.3 各包验收要点

> （v2.1，复审 v2-6）**串行 handoff**：P5b 改 P0/P2 文件（`scripts/web-hub/{check-ui-dist.ts,dev-hub.ts}`、`aliases.ts`/`ui/tsconfig.json`）、P7 改 P5a/P5b 文件（`unbuilt.ts`、`ui-status.ts` 文案段）不属越权：这些包在波次上严格串行（原所有包已合入、无其它 UI 包在跑），文件所有权在派单时随上表移交给后续包；派单 prompt 需逐文件列出这次移交。并行波次（W2 P1∥P2、W3 P3∥P4∥P5a）内仍严格按独占清单。

- **P0**：`build:web` 产出 `dist/web-hub-ui/` 与合法 `build-info.json`；`check:web` 全过（含清单逐一对应、产物字符串扫描、体积预算）；`probe:csp` 结果（通过 / 按 §4.4.1 判定收紧）写入报告；`typecheck`（含 vue-tsc）/`test`/`format:check`/`build` 全绿；旧 UI 行为不变（`tests/web-hub/web/**` 全绿）；`git status` 无产物被跟踪；P0 **不含**任何 `components/{shell,agents,detail,fleet,transcript}/` 文件与 `tokens.css` 以外的样式文件。成本约 $4–6。
- **P1**：§3.3–3.9 行为全部有测试；`transport-contract` 对两种模式跑同一套；§3.5 验收 1–6 全过；`hub-http-integration` 六个用例 password 全过（token 同套）；源码无 rAF；旧 state 用例零改动全绿。成本约 $5–8。
- **P2**：`dev:hub -- --scenario dashboard` 在 P0 占位产物上可打开、CSP 头与真 hub 字节一致（import 同一常量）；`visual:web` 框架在占位上跑通（`checks-shell/body/e2e` 尚不存在时自动跳过）。成本约 $3–5。
- **P3**：dev-hub dashboard/login/states 在 6 个断点 × 浅/暗下与样稿结构一致（verifier 读图）；`checks-shell.ts` 的 §6.1/§6.2/§6.3/§6.5/§6.7 全过；三态主题可切并持久；登录全部错误态中英各一套。CSS 以 `ui-mockups/app.css` 为源**按段拆分照搬**（类名保持样稿命名），去掉样稿专用段，断点按 §0.3；每个 CSS 文件自带自己的 `@media` 块（不设共享 responsive.css）；`App.vue` 第一批 import 就是 P3 的样式文件（保证层叠顺序先于 P4 的 fleet/transcript.css）。成本约 $8–14。
- **P4**：ui-design §5.3/§5.4/§6.4/§6.6 全部条目；`checks-body.ts` 全过；long 场景挂载 `.tx-item` ≤300、手机首屏 80；流式 100 帧/s 下 DOM 批次 ≤10/s；XSS 语料全过；工具 partial 截尾；跟随/新消息计数/前插锚点。成本约 $8–14。
- **P5a**：§4.2 的 ui-root / unbuilt / paths-trusted 用例全过；模块未被任何生产代码 import（`git grep` 证明惰性）。成本约 $4–6。
- **P6**：§4.4.2 全矩阵 + axe 0 违规 + 读图无结构性偏差。失败项按文件归属列清单 → 主会话把 P3 文件的问题退回 P3（优先 `resume` 原 run；不可 resume 时新派 frontend-dev 并挂 `experts: [P3 label, Plan label]`），P4 同理 → 原包修完后 P6 verifier 复跑直至全绿。P6 自身只写 `checks-e2e.ts`（跨区域整合断言：列表→详情→对话流全流程、主题切换后各区域配色、窄屏折叠与深链组合）。成本约 $3–5 + 退回修复 $2–6。
- **P5b**：全量门禁绿；`static.test.ts` 覆盖映射/缓存头/未构建页（两种模式 × 两种语言）；`check:web` 追加的 `verifyUiRoot` 通过；§4.6 真机验收（token + LAN + 未构建页 + 隐藏页）通过；`git grep "src/web-hub/web"` 只剩文档里的历史引用；revert 该提交即可恢复旧 UI。成本约 $6–9。
- **P7**：`tests/release/web-ui-zip.test.ts` 与 `package-zip.test.ts` 全过；本机跑一次 `scripts/release/package.sh`（dry：不发布）产出两个 zip 与各自 sha256 校验通过；总 zip 含 `index.ts`/`src/`/`skills/`/`package.json`/`dist/web-hub-ui/build-info.json` 且可按 README 本地安装；§4.6 包外根真机验收通过；README 中英两份步骤与未构建页一致。成本约 $2–4。

### 5.4 冲突预检要点

- P1 ∥ P2：见 §5.2 表，无交集（P1 只追加 `lan-helpers.ts`，P2 不碰）。
- P3 ∥ P4 ∥ P5a：组件目录、CSS 文件、i18n 命名空间文件、visual 断言模块、接缝文件各归其主；i18n 合并靠 `import.meta.glob`、visual 断言靠框架 glob 加载，不存在共享清单文件；P5a 只在 hub/protocol 新增文件。
- P6 ∥ P5b：P6 只写 `checks-e2e.ts`，退回的修复落在 P3/P4 的 UI 文件；P5b 改 hub/逻辑迁移/别名/测试——无交集；但别名切换会让修复分支 rebase 后需复跑门禁，故合并顺序固定「P6 通过（含退回修复）→ P5b」。
- 所有并行写包 `isolation: "worktree"`（从 master HEAD 建，`node_modules` 软链；整理自动提交按 memory pitfalls 的 cherry-pick 流程，剔除 `node_modules` 软链）；派单 prompt 写明禁 `git stash` / `git add -A`、只改本包独占文件。

### 5.5 成本与轮数估算

开发 ≈ P0 $4–6 + P1 $5–8 + P2 $3–5 + P3 $8–14 + P4 $8–14 + P5a $4–6 + P6 $5–11（含退回修复）+ P5b $6–9 + P7 $2–4 = **$45–77**；验收 9 × $1–2；方案评审 2 轮 ≈ $3 ⇒ **总计约 $57–98**（v1 为 $45–75；增量来自 P7 转必做、P5 拆出带安全校验的 P5a、真 HTTP 集成回归、CSP 探针与 §6 逐项断言）。主干 5 个波次 + 预计 2–3 轮打回修复。主要成本风险：P3/P4 的 CSS 移植与样稿逐屏比对（2400 行 app.css）、P6 的退回轮次。

## 6. 风险与待确认项

### 6.1 风险

| 风险                                                                                   | 缓解                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| git 安装用户默认看到未构建页，且 `pi update` 的 `git clean -fdx` 每次都会清掉包内产物  | 方式一 release 附件落在包外目录，不受 `git clean` 影响（P7）；方式二命令兜底；长期 npm 首发（E）        |
| 包外目录被他人篡改注入脚本                                                             | §2.1 统一校验（属主/模式/软链/realpath/清单 sha256/版本协议）+ 只出内存中已校验字节；测试覆盖各拒绝路径 |
| UI zip 解压后模式过宽（用户 umask 宽松）导致被拒                                       | 打包时规范化为 0644/0755 且 zip 存模式；被拒时 status/未构建页给出 `mode` 原因，步骤含 `chmod -R go-w`  |
| vitest 2.1.9 × happy-dom 20 不兼容                                                     | P0 验证；退 `happy-dom ~15.11`                                                                          |
| Vite 5 与 vitest 共用一个 vite 版本，将来升 vitest 3 会连带升 vite 6                   | 显式 pin `vite ~5.4.21`；`@vitejs/plugin-vue 5.2` 两者都支持                                            |
| Vue 静态提升把大段静态模板经 `innerHTML` 插入 ⇒ 模板里的静态 style 属性被 CSP 静默丢弃 | 源码扫描禁静态 `style=` + 产物字符串扫描 + P0 真浏览器探针（含反向对照）                                |
| `:style` 对象绑定在某些浏览器受 CSP 影响                                               | P0 探针判定；不过即全面禁 `:style`                                                                      |
| 隐藏标签页渲染停滞（#25 同类）                                                         | §3.5 唯一规则 + 三路可见性事件 + 1s 轮询兜底 + 属性测试 + 真机验收                                      |
| 两种 transport 行为分叉（78dd76b 同类）                                                | `satisfies` 接口 + 同套契约测试 + 真 HTTP 集成回归 + P5b 真 LAN 验收                                    |
| P3 ∥ P4 争改共享文件                                                                   | 冻结面 + 独占清单 + 两个接缝占位 + glob 合并（i18n / visual 断言）                                      |
| 未构建页在 LAN 泄露主机路径                                                            | password 模式不含绝对路径与拒绝原因；测试正则扫描                                                       |
| wh2-merge 的 1792278 未合入导致 P0 冲突                                                | §0.4 前置                                                                                               |

### 6.2 已确认（2026-09-27）

1. git 安装路径：A + B 本期都做（B = P7 必做）；C 否决；E 长期、本期不做。
2. 新增 devDeps（约 +25 MB，仅开发者）同意；Playwright / axe-core 不进 devDeps，只经本机 npx 缓存使用。
3. 旧前端 P5b 一次性删除，不加运行时开关。
4. 产物目录 `dist/web-hub-ui/`；包外目录 `~/.pi/agent/web-hub-ui/<ver>/`。
5. 未构建页 200，语言按 `Accept-Language`，LAN 模式不显示主机路径。
6. i18n 只自动检测；只做窗口化（上限 300），不做虚拟滚动。
7. todo #29 并入 P7：总 zip 可安装化；UI zip 仍是独立的手工解压附件。

### 6.3 仍待复审确认

1. §2.1 属主放行 uid 0（为系统级 `sudo npm i -g` 安装；草案原文为「属主 = 当前用户」）——若复审要求严格，删去放行即可，影响仅是 root 属主的包内根被拒、改走方式一。
2. §2.1 用「只出内存中已校验字节」替代「服务时比对 realpath+size+sha」——同等以上的 TOCTOU 保证，代价见 §2.1。

## 7. v1→v2 处置

| #   | 评审意见（第 1 轮）              | 级别 | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 落点                                            |
| --- | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 1   | P7 须改为必做                    | 阻塞 | 接受。`build:web` 产 `build-info.json`（version / proto.major / builtAt / commit / 文件清单 path+bytes+sha256）；`package-web-ui.sh` 产 `pi-toolkit-web-ui-<ver>.zip`（顶层 `web-hub-ui/<ver>/`）+ sha256；手工解压安装，步骤进未构建页与 `/webhub status`；zip 结构 fixture 测试；W5                                                                                                                                                                                                                                                      | §0.2、§1.2、§1.6、§1.7、§2.1、§2.3、§4.2、§5 P7 |
| 2   | `resolveUiRoot()` 候选顺序与校验 | 严重 | 接受。包内 → 包外 `<home>/.pi/agent/web-hub-ui/<hubVersion>/`；每根统一校验版本/协议、属主与 g/w 不可写（复用 `paths.ts` 的 `FsDeps`/`PrivateDirError`，新增只查不修的 `checkTrustedEntry`）、拒软链 + realpath 包含、普通文件、清单 sha256 全匹配；任一不过弃根试下一个，全不过 ⇒ 未构建页；诊断进 hub 日志与 hub.json `ui` → `/webhub status`；TOCTOU 以「解析时校验并缓存字节、只出内存」解决并说明代价与换代检测；LAN 未构建页不含绝对路径；测试覆盖穿越/软链/非私有/版本错配/错误 hash/LAN 不泄露。偏差：属主额外放行 uid 0（§6.3-1） | §2.1、§2.3、§4.2、§5 P5a/P5b                    |
| 3   | 隐藏页渲染规则须唯一             | 严重 | 接受。`doc.hidden` 为真时任何优先级都不 commit；`now` 的微任务只在可见时生效；`visibilitychange`→visible / `pageshow` / `focus` 同步 flush；1s 轮询兜底 best-effort（只在发现已可见时 flush）；验收含回前台必 flush、无永久停滞、无丢更新（属性测试）                                                                                                                                                                                                                                                                                      | §3.5、§4.6                                      |
| 4   | 需浏览器级 CSP 测试              | 一般 | 接受。P0 `probe:csp`：真实 Vite 产物（同配置的 probe 模式）+ http.ts 的 `CSP` 常量 + 本机离线 Chromium；断言无 `<style>`/内联脚本、CSS 全外链、CSS 变量与对象绑定计算值生效，含反向对照；判不过即禁对应写法；`check:web` 增编译后产物字符串扫描覆盖静态提升                                                                                                                                                                                                                                                                                | §1.2、§2.2、§4.4.1、§5 P0                       |
| 5   | 需真实 HTTP 集成回归             | 一般 | 接受。真 LAN 监听 + 真 `password-client` + `useHub`：首次订阅、历史分页、401/auth、登出、重连、定时器清理；token 模式同套                                                                                                                                                                                                                                                                                                                                                                                                                  | §4.2、§5 P1                                     |
| 6   | P0 过大、并行包争文件            | 严重 | 接受。P0 只留类型、props/emits 契约（`contracts.ts`）、路由、tokens.css 与两个接缝占位；组件与样式由 P3/P4 独占新建；P6 在 P3/P4 合入后串行，偏差按文件退回原包；冻结面只由主会话改并推送在跑包；给出每包独占清单                                                                                                                                                                                                                                                                                                                          | §1.1、§3.2、§5.2–§5.4                           |
| 7   | 移动端须逐项断言                 | 一般 | 接受。§6.1–§6.7 逐项 Playwright 断言表，断点 375/481/767/768/1024/1025，覆盖 safe-area/dvh、dock 不遮挡焦点、登录 16px 输入与显示密码、横幅两行展开、长内容块内滚动、手机 Fleet 默认折叠、hash 深链与后退                                                                                                                                                                                                                                                                                                                                  | §4.4.2、§5 P3/P4/P6                             |
| —   | （顺带）v1 前置提交号过期        | —    | a367d7f 已被 rebase 为 1792278，已更正                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §0.4                                            |
| —   | （顺带）P5 拆分                  | —    | 为缩短关键路径并让安全模块独立评审，P5 拆为 P5a（纯新增、W3 并行）与 P5b（原子切换）                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §5.1                                            |
