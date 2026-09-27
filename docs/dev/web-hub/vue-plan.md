# web-hub 前端 Vue 重写 — L2 实施方案（todo #26 施工口径）

> 状态：方案稿，待评审 ∥ 用户确认（HARD GATE）。只描述施工；视觉/交互以 `ui-design.md`（含 §6 移动端、§17.1 用户拍板）为准，
> 样稿 `ui-mockups/` 是像素参照。本文与 `ui-design.md` 冲突处以本文 §0.3「对设计稿的修订」为准。

## 0. 摘要

### 0.1 车道

打分：文件数 +2（>5）· 模块边界 +1（hub static ↔ 前端 ↔ 构建/CI）· 契约 +1（新增 reducer 本地事件、static 新根目录，兼容）· 设计选择 +2（git 安装路径、旧前端切换、渲染调度）· 风险面 +1（发版/打包、CSP）= 7 ⇒ **L2 标准**；命中「发版与部署」一票升级，本就是 L2。

### 0.2 已定决策（用户拍板，不再讨论）

Vue 3 SFC + Vite；产物不进 git（npm 包 / release zip 携带，本地 `npm run build:web`）；缺产物显示「未构建」页、不做运行时下载；浅色默认 + 暗色，三态主题（localStorage）；手写 CSS 沿用 `tokens.css`，不引组件库；CSP `script-src 'self'` 不放宽 ⇒ 只用预编译 SFC + runtime-only Vue；teal 主色；≥768 分栏；文案跟随浏览器语言（zh/en 小词典）；移动端一等公民。

### 0.3 对设计稿的修订（实现口径，覆盖 ui-design.md 对应句）

| ui-design 原文                            | 实现口径                                                                                                                                                                              | 原因                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| §3.6 / app.css 断点 481 / 1025，平板单栏  | 手机 ≤480（16px 正文、无头像）；481–767 单栏 + 卡片网格；**≥768 分栏**（侧栏 260px）；≥1025 侧栏 288；≥1280 侧栏 340                                                                  | §17.1-2 用户拍板                                                                                   |
| §6.6「渲染用 requestAnimationFrame 合批」 | **禁用 rAF**；Vue 调度（微任务）+ 自写 `renderGate`（setTimeout 100ms 节流 + `visibilitychange` 冲刷），见 §3.5                                                                       | #25 根因：隐藏 tab 中 rAF 挂起 ⇒ 状态已变但 DOM 永不追上（a367d7f 的补丁）                         |
| §12「contract.js 原样复用」               | 前端改为**直接 import `src/web-hub/protocol/http-contract.ts`**（Vite 能打包 TS），手抄镜像 `contract.js` 只留 `API` 路径 / `SILENCE_MS` / `HISTORY_LIMIT_MAX` 这几个协议未导出的常量 | 消除「两边手抄、测试比对」的漂移源；http-contract.ts 对 messages.ts 只有 type import，打包后零依赖 |
| §13「ESLint `vue/no-v-html`」             | 不引 ESLint，用静态扫描测试（§4.3）                                                                                                                                                   | 仓库无 ESLint，为一条规则引一套工具链不划算                                                        |
| §12「reducer 原样复用」                   | 加一个**兼容性**本地事件 `route`（§3.3）：路由为选中态的唯一来源，关闭 `withSelection` 的自动选中；旧 UI 不派发它，行为不变                                                           | 手机列表页不能偷偷订阅第一个 agent；深链 key 在 `agents` 帧到达前需暂存                            |
| §6.6「首屏只渲染最近 80/200 条」          | 纯客户端窗口：hub 快照照旧返回尾部 400 条（`DEFAULT_TAIL_ENTRIES`，不动协议），前端只挂载窗口内条目                                                                                   | 不改 hub 协议即可达成手机 DOM 上限；协议级 `limit` 留作以后                                        |

### 0.4 前置条件

- `wh2-merge` 分支上的 a367d7f（`fix(web-hub): render fallback when rAF is suspended…`，改 `app.js` + `history.ts`）须先合入 master，P0 从含它的 HEAD 起步（P0 要重构 `app.js`，否则必冲突）。
- P0 合入后主会话在主工作树跑一次 `npm install`（新增 devDeps），之后各 worktree 通过 `node_modules` 软链复用。

## 1. 目录与构建

### 1.1 目录

```
src/web-hub/ui/                      # Vue 源码（进 git；npm 包因 files:["src"] 也会带上，便于 npm 用户自行重建）
  index.html                         # Vite 入口；<html data-auth-mode="__AUTH_MODE__">（serveIndex 占位符必须原样保留）
  vite.config.ts
  aliases.ts                         # @logic / @protocol 别名，vite.config.ts 与根 vitest.config.ts 共用
  tsconfig.json                      # 独立 tsconfig（Bundler 解析 + DOM lib），vue-tsc 检查
  env.d.ts                           # *.vue 模块声明 + __PWH_UI_BUILD__ 常量声明
  public/
    theme-init.js                    # 同步小脚本（非 module）：读 localStorage 在首帧前给 <html> 加 theme-* 类
    favicon.svg
  src/
    main.ts                          # createApp(App).mount("#root")；import "./styles/index.css"
    App.vue
    build-info.ts                    # 读 __PWH_UI_BUILD__（version / proto）
    styles/
      index.css                      # 只有 @import 列表（P0 建好，之后冻结）
      tokens.css                     # 原样拷贝 ui-mockups/tokens.css（删去 #mock-dark 样稿专用段）
      base.css primitives.css notices.css shell.css agents.css detail.css dock.css login.css states.css  # P3
      fleet.css transcript.css       # P4
    icons/
      IconSprite.vue                 # 33 个 <symbol>（照搬样稿），App 顶层渲染一次
      AppIcon.vue                    # <svg class="icon" aria-hidden="true"><use :href="`#i-${name}`"/></svg>
      names.ts                       # IconName 联合类型
    transport/
      types.ts                       # HubTransport / PasswordTransport 接口（§3.4，冻结）
      token.ts                       # createTokenTransport(win): HubTransport —— 包装 @logic/token-client.js
      password.ts                    # createPasswordTransport(win, hooks): PasswordTransport —— 包装 @logic/password-client.js
    composables/
      useHub.ts                      # shallowRef 状态 + dispatch + 订阅/分页副作用（移植 wireFleetUi）
      renderGate.ts                  # 节流/可见性调度（纯函数工厂，可注入时钟与 document）
      usePasswordAuth.ts             # 登录表单状态机、错误 → i18n key、倒计时
      useHashRoute.ts                # #/ 与 #/agent/<key>
      useTheme.ts                    # system|light|dark，localStorage "pwh_theme"
      useI18n.ts                     # navigator.languages → zh|en；t(key, params)
      useTicker.ts                   # 共享 1s ticker（隐藏时暂停）
      useClipboard.ts                # navigator.clipboard / 非安全上下文回退为选区
      useAnnouncer.ts                # sr-only role=status 播报，节流 ≥2s
      useTranscriptWindow.ts         # 窗口计算（纯函数 computeWindow + 组合式包装）
      useFollowScroll.ts             # 跟随 / 前插锚点（flush:"post"，不用 rAF）
      useMedia.ts                    # matchMedia("(min-width: 768px)") 等
    i18n/
      index.ts                       # 合并各命名空间；Lang 检测
      en/{shell,login,agents,detail,fleet,transcript,notices,common}.ts
      zh/{同上}.ts                   # 每个文件 `satisfies Messages<typeof en.xxx>` ⇒ 缺 key 即类型错误
    format.ts                        # Intl.NumberFormat / DateTimeFormat；保留 formatUsd「<$1 显示 4 位」规则
    components/                      # 见 §3.2
dist/web-hub-ui/                     # 构建产物（dist/ 已 gitignore、已在 package.json files、已被 release zip 整体拷贝）
  index.html  theme-init.js  favicon.svg  assets/index-<hash>.js  assets/index-<hash>.css
```

**产物目录选 `dist/web-hub-ui/` 的理由**：`dist/` 已在 `.gitignore`、`.prettierignore`、`package.json#files` 里，`scripts/release/package.sh` 本就 `cp -r dist`——零配置改动即可同时满足「不进 git」「进 npm 包」「进 release zip」。static.ts 用 `new URL("../../../dist/web-hub-ui/", import.meta.url)` 解析：hub 永远经 jiti 从 `src/web-hub/hub/` 跑（`agent/index.ts` 的 `hubMainPath` 指向 `../hub/main.ts`），`../../../` 即包根；万一从 `dist/web-hub/hub/` 跑，深度相同，同样落到包根。tsc 的 `outDir: dist` 只写 `dist/<模块>/`，不会与 `dist/web-hub-ui/` 冲突；Vite `emptyOutDir: true` 只清自己的 outDir。

`.gitignore`：无需改（`dist/` 已覆盖）。

### 1.2 Vite 配置（`src/web-hub/ui/vite.config.ts`，要点逐条写死）

```ts
export default defineConfig({
  root: here, // src/web-hub/ui
  base: "/", // 产物引用 /assets/…（与旧前端一致；LAN 反代按 origin 不按子路径）
  publicDir: "public",
  plugins: [vue()], // @vitejs/plugin-vue：SFC 模板构建期编译 ⇒ runtime-only
  resolve: { alias: uiAliases }, // @logic → src/web-hub/web（P5 改指 src/web-hub/ui/src/logic）；@protocol → src/web-hub/protocol
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    __PWH_UI_BUILD__: JSON.stringify({ version: pkg.version, proto: PROTO.major }),
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
- 产物守卫脚本 `scripts/web-hub/check-ui-dist.mjs`（CI 必跑，§1.5）逐条断言：`index.html` 含 `data-auth-mode="__AUTH_MODE__"`；无内联 `<script>`（每个 `<script>` 都有 `src`）；无 `on*=` 属性、无 `style=` 属性、无 `<style>`；所有引用的 `/assets/*` 文件存在且文件名带 ≥8 位哈希；无 `.map` 文件、无 `sourceMappingURL`；JS 中无 `eval(`、`new Function(`、`Function("`（Vue 运行时的 `insertStaticContent` 会用 `innerHTML` 插**编译期静态**模板，所以产物层不禁 `innerHTML`，源码层禁，见 §4.3）；无 `http://` / `https://` 外链资源引用（字符串常量中的文档 URL 例外名单写在脚本里）；体积预算 JS ≤ 120 KiB gzip、CSS ≤ 25 KiB gzip（Vue runtime ≈ 25 KiB gzip，余量给业务）。

### 1.3 tsconfig 关系

- 根 `tsconfig.json` 与 `tsconfig.build.json` 的 `exclude` 加 `src/web-hub/ui/**`（build 的 `exclude` 是覆盖不是合并，两处都要写）。根 tsc 是 NodeNext + 无 DOM lib，不能也不该检查 SFC。
- `src/web-hub/ui/tsconfig.json`（独立，不 extends 根）：`target ES2022`、`module ESNext`、`moduleResolution Bundler`、`lib [ES2022, DOM, DOM.Iterable]`、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`isolatedModules`、`verbatimModuleSyntax`、`allowJs: true`（@logic 下的 JSDoc JS 通过 JSDoc 推断出类型给 TS 调用方）、`checkJs: false`（不在本期给旧 JS 补类型）、`types ["vite/client", "node"]`（后者仅供 vite.config.ts）、`paths` 与 `aliases.ts` 一致；`include: ["src/**/*.ts", "src/**/*.vue", "env.d.ts", "vite.config.ts", "aliases.ts"]`。
- `npm run typecheck` 追加 `&& vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json` ⇒ 自动进 CI（CI 已跑 typecheck）。
- 根 `vitest.config.ts`：`plugins: [vue()]`、`resolve.alias: uiAliases`；环境仍默认 `node`，组件测试文件头写 `// @vitest-environment happy-dom`。`include` 不变（`tests/**/*.test.ts`）。

### 1.4 package.json

```jsonc
"scripts": {
  "build:web": "vite build --config src/web-hub/ui/vite.config.ts",
  "dev:web":   "vite build --watch --config src/web-hub/ui/vite.config.ts",   // 配合 dev:hub 看真实 CSP 下的效果
  "check:web": "node scripts/web-hub/check-ui-dist.mjs",
  "dev:hub":   "tsx scripts/web-hub/dev-hub.ts",                              // 假数据 hub（§4.5）
  "visual:web":"node scripts/web-hub/visual.mjs",                             // Playwright 截图 + 自动检查（本机，非 CI）
  "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json",
  "prepack":   "npm run build && npm run build:web && npm run check:web"      // npm pack / publish 必带产物
}
```

- **不加** `prepare` / `postinstall`（理由见 §1.7 方案 C）。`prepack` 只在 `npm pack` / `npm publish` / npm 自己安装 git 依赖时触发，pi 的 git 安装走 `npm install --omit=dev`（触发的是 `prepare` 不是 `prepack`），不受影响。
- `files` 不改（`dist` 已在列）。
- 新增 devDependencies（全部 MIT；体积为 npm 报告的 unpacked，含主要传递依赖估算）：

| 包                   | 版本                             | 体积（约）                                                                 | 用途                                    |
| -------------------- | -------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| `vue`                | `^3.5.43`                        | 2.5 MB，连 `@vue/compiler-sfc`（postcss、@babel/parser）≈ 9 MB             | 运行时 + SFC 编译（构建期）             |
| `@vitejs/plugin-vue` | `~5.2.4`                         | 0.2 MB                                                                     | peer `vite ^5 \|\| ^6`                  |
| `vite`               | `~5.4.21`                        | 0（已作为 vitest 2.1.9 的依赖存在于 node_modules，显式声明以锁版本、去重） | 构建                                    |
| `vue-tsc`            | `^3.3`（peer TS ≥5，本仓 5.9.3） | ≈ 3 MB（@volar/\*、@vue/language-core）                                    | SFC 类型检查                            |
| `happy-dom`          | `^20`                            | 8.4 MB（+ ws、entities）                                                   | 组件测试 DOM（20.x 修复了 VM 逃逸 CVE） |
| `@vue/test-utils`    | `^2.4.x`                         | 1.5 MB + js-beautify ≈ 1 MB                                                | 组件挂载                                |

合计约 +25 MB node_modules（现 333 MB，≈ +8%），**不进用户安装**（pi git 安装 `--omit=dev`；npm 包不含 devDeps）。**不作为 devDep 引入**：Playwright（13 MB core + 浏览器）与 `axe-core`（MPL-2.0）只在 `scripts/web-hub/visual.mjs` 里经 `npx -y playwright@1.62.1`（本机 npx 缓存已有，浏览器 chromium-1243 已缓存）按需加载。P0 须验证 vitest 2.1.9 + happy-dom 20 兼容；不兼容则退 `happy-dom ~15.11`（≥15.10.2 已修 RCE；VM 逃逸只影响执行不可信脚本，测试场景可接受——写入 P0 报告）。

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

### 1.6 release（`scripts/release/package.sh`）

- `npm run build` 之后追加 `npm run build:web && npm run check:web`；`cp -r dist` 自动带上 `dist/web-hub-ui/`。
- 可选（见待确认项 Q1-B）：另产 `release/pi-toolkit-web-ui-<ver>.zip`（仅 `dist/web-hub-ui/` + `build-info.json`）及其 sha256，供 git 安装用户手动下载。
- **既有问题（本期不修，另立 todo）**：release zip 只含 `dist/` + package.json，而 `package.json#pi.extensions` 指向不在 zip 里的 `./index.ts`，hub 也只能从 `src/web-hub/hub/main.ts` 起——zip 目前装不成可用的 pi 扩展，web-hub 更跑不起来。「release zip 携带产物」只有在 zip 修好后才对用户有意义。

### 1.7 `pi install git:…` 路径（重点）

**事实（读 pi 0.87.1 `dist/core/package-manager.js`）**：

1. 首次安装：`git clone` → `npm install --omit=dev`（在克隆目录里）。任一步抛错 ⇒ `rmSync(targetDir)` 整个安装回滚。
2. 每次 `pi update`（HEAD 变化时）：`git reset --hard` → **`git clean -fdx`** → `npm install --omit=dev`。即：**任何 gitignored 的本地构建产物（含 `dist/web-hub-ui/`）和手装的 devDeps 都会在每次更新时被清掉**。
3. 用户本人当前以本地路径安装（`~/.pi/agent/settings.json` `packages: ["../../ai/pi-toolkit"]`），且包尚未发布到 npm（`npm view pi-toolkit` 404）——所以**眼下真正受影响的是「未来的 git 安装用户」**，本机开发者跑一次 `npm run build:web` 即可。

**候选对策**：

| 方案                                                                                                                                                                                                                       | 可行性 / 风险                                                                                                                                                                                                                                    | 建议                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| **A 提示页 + 命令**：未构建页与 `/webhub status`/`open` 都给出 `cd <包目录> && npm install --include=dev --no-audit --no-fund && npm run build:web`，并注明「`pi update` 会清掉产物，更新后需重跑」                        | 零风险、零新机制；代价是每次更新后手动一次，且 `--include=dev` 会装上 pi-\* 等全部 devDeps（数百 MB，下次 update 的 `--omit=dev` 会裁掉）                                                                                                        | **本期采用（P5）**  |
| **B release 附件**：release 额外产出 `pi-toolkit-web-ui-<ver>.zip`；hub 除包内 `dist/web-hub-ui/` 外，再按版本查找包外目录 `~/.pi/agent/web-hub-ui/<version>/`（不受 `git clean` 影响）；提示页给出 release 链接与解压位置 | 用户手动下载 ≠ 运行时下载，符合决策；需多一个受控查找根（realpath 包含 + 私有目录权限校验 + `build-info.json` 版本/协议匹配），约 1 个小包的工作量                                                                                               | 推荐作为 P7（可选） |
| **C `prepare`/`postinstall` 构建**                                                                                                                                                                                         | pi 用 `--omit=dev` ⇒ vite/vue 不存在，只能静默跳过 ⇒ 对 git 用户**无效**；若脚本出错，pi 会**回滚整个安装**；若把 vite/vue 挪进 `dependencies`，每个用户每次 update 都多装 ~40 MB（含 esbuild 原生二进制）并构建 ~10 s，且把构建失败变成安装失败 | 否决                |
| **D 产物进 git**（孤儿分支 / tag 附带）                                                                                                                                                                                    | 违反已定决策                                                                                                                                                                                                                                     | 不采纳（仅列出）    |
| **E 发布到 npm**                                                                                                                                                                                                           | `pi install npm:pi-toolkit` 天然带产物（prepack 保证）；需要用户决定何时首发                                                                                                                                                                     | 建议作为长期主路径  |

## 2. hub 侧改动（全部在 P5）

### 2.1 `src/web-hub/hub/static.ts`

- `webRoot()` → `uiRoot()`：`fileURLToPath(new URL("../../../dist/web-hub-ui/", import.meta.url))`。
- URL 映射收紧（旧前端的 `/assets/<p>` → `<root>/<p>` 双路回退与任意顶层 `.js` 一并删除）：
  - `/`、`/index.html` → `serveIndex`（占位符替换逻辑不变）。
  - 顶层**仅**白名单文件名：`theme-init.js`、`favicon.svg`。
  - `/assets/<name>`：单层文件名，匹配 `^[A-Za-z0-9._-]+$`，扩展名 ∈ `.js .css .svg`。
  - 保留现有全部守卫：百分号解码失败 ⇒ 404；拒绝 `..`/NUL/反斜杠/点开头段；扩展名白名单（`.html .js .css .svg .ico`）；词法包含 + `realpath` 包含（防软链逃逸）+ 普通文件 + 8 MiB 上限。
- MIME 不变（已含 html/js/css/svg/ico，均带 charset 的文本类型）；`X-Content-Type-Options: nosniff` 由 http.ts 统一加。
- 缓存：`assets/` 下且文件名匹配 `-[A-Za-z0-9_-]{8,}\.(js|css|svg)$` ⇒ `Cache-Control: public, max-age=31536000, immutable`；`index.html`、`theme-init.js`、`favicon.svg` ⇒ `no-cache`（重新构建后浏览器立即拿到新 index，新 index 引用新哈希）。HEAD 沿用 Node 自动省略 body。
- **缺产物回退**：`uiRoot()/index.html` 不存在（或不是普通文件）时，`/` 返回内置「未构建」页：
  - 由 `src/web-hub/hub/unbuilt.ts` 的纯函数 `renderUnbuiltPage({ lang, version, pkgDir? })` 生成（HTML 转义所有插值），200 + `Cache-Control: no-store` + `X-PWH-UI: unbuilt`（测试用）；**200 而不是 503**：`lan-host.test.ts` 等既有测试断言 `/` 为 200，且 `/healthz` 才是健康语义。
  - 语言按请求头 `Accept-Language`（`zh*` ⇒ 中文，否则英文）——页面不带任何脚本。
  - 无样式（不内联 `<style>`，满足 `style-src 'self'`）；纯语义 HTML：标题、原因、命令（`<pre>`）、「`pi update` 后需重跑」、npm 安装提示、（若启用 B）release 链接。
  - **包目录绝对路径只在 token（回环）模式显示**；LAN（password）模式下未鉴权的局域网访问者也能拿到静态页，改为「在主机上运行 `/webhub status` 查看命令」，避免泄露主机路径。
  - 缺产物时 `/assets/*` 一律 404（不回退）。
- `serveStatic` 签名扩展为 `opts?: { authMode?: "token" | "password"; acceptLanguage?: string }`；http.ts 两处调用（`:1010` LAN、`:1506` 回环）传入 `req.headers["accept-language"]`；`:1201` 的 `webRoot()` 改 `uiRoot()`。

### 2.2 CSP 核对

`CSP` 常量（http.ts:82）**一字不改**：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`。Vue 侧对应约束：

| 约束                 | 落实                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无内联脚本 / eval    | runtime-only Vue + SFC 预编译；`theme-init.js` 外链；产物守卫 + 浏览器实测 `securitypolicyviolation` 为 0                                                                                                                             |
| 无内联样式           | 模板里**禁止静态 `style="…"`**（Vue 会把大段静态节点字符串化后经 `innerHTML` 插入，其中的 style 属性会被 CSP 丢弃）；动态值只允许 `:style="{ '--pct': … }"` 这类对象绑定（Vue 走 CSSOM `setProperty`，不受 CSP 限制）或原生 `<meter>` |
| 无外部资源           | 系统字体、SVG sprite 同文档 `<use href="#i-…">`；favicon 同源                                                                                                                                                                         |
| `connect-src 'self'` | fetch/EventSource 只打同源 `/api/*`（两个 client 不变）                                                                                                                                                                               |

### 2.3 pi 侧提示（P5，小改）

`src/commands/webhub.ts` 的 `status` / `open`：`existsSync(<包根>/dist/web-hub-ui/index.html)` 为假时追加一行 warning：「网页 UI 未构建：cd <包根> && npm install --include=dev && npm run build:web」（主机本地，显示绝对路径无妨）。包根用 `fileURLToPath(new URL("../../", import.meta.url))`（与 static.ts 同一换算，抽成 `src/web-hub/protocol/paths.ts` 里的 `uiDistDir()` 纯函数供两边共用）。

### 2.4 旧前端删除时机 —— 建议「构建期一次性切换」，不做运行时开关

- P0–P4、P6 期间：hub **继续服务旧前端**（`src/web-hub/web/`，不改 static.ts），新 UI 只在 `dev:hub` 下预览 ⇒ 这些包各自可独立发布、线上零可见变化。
- P5 一个提交内完成：static.ts 切到 `dist/web-hub-ui/` + 未构建页 + 删除旧 UI 的 DOM 层文件 + 迁移纯逻辑 + 迁移/删除旧测试 + 文档。回滚 = revert 这一个提交。
- 不做 `webHub.ui: legacy|vue` 设置开关：要维护两套 UI 的 static 映射与测试、要多一个设置项与迁移说明，而旧 UI 的全部纯逻辑已被新 UI 复用、DOM 层没有保留价值；且「产物不进 git」意味着开关打到 vue 时 git 用户照样看到未构建页，开关并不能缓解 §1.7 的问题。

## 3. 前端架构

### 3.1 纯逻辑复用（`@logic` 别名）

`@logic` 在 P0–P4 指向 `src/web-hub/web/`，P5 `git mv` 到 `src/web-hub/ui/src/logic/` 后只改别名目标——UI 代码零改动。

| 旧文件                                                          | 处置                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.js`                                                      | 保留；P1 加 `route` 事件（§3.3）                                                                                                                            |
| `contract.js`                                                   | 保留 `API`、`SILENCE_MS`、`HISTORY_LIMIT_MAX`；新 UI 的 `SSE_EVENTS`/`API_ERRORS`/负载类型从 `@protocol/http-contract.js` 直接 import                       |
| `app.js` 的 `createClient`、`readHashToken`、`TOKEN_KEY` 等     | **P0 抽到 `token-client.js`**（旧 `app.js` 改为 import 它，行为不变）。原因：`app.js` 末尾有「存在 `#app` 就自动挂载旧 UI」的副作用，新 UI 绝不能 import 它 |
| `password-client.js`                                            | 原样保留                                                                                                                                                    |
| `render/fleet.js`                                               | 保留 `fleetTree`；`renderFleet` 在 P5 删                                                                                                                    |
| `render/tools.js`                                               | 保留 `toolView`/`summarizeArgs`/`safeJson`；`renderToolCard`/`pre` P5 删                                                                                    |
| `render/agents.js`                                              | 保留 `agentCardModel`/`shortCwd`/`costLabel`；`renderAgentList` P5 删                                                                                       |
| `render/banner.js`                                              | 保留 `bannerText`；`renderBanner` P5 删                                                                                                                     |
| `render/markdown.js`                                            | 保留 `parseMarkdown`/`isSafeHref`；`toDom`/`renderMarkdown` P5 删                                                                                           |
| `render/transcript.js`                                          | 保留 `messageText`/`itemRenderKey`/（导出 `indexTools`）；`renderTranscript`/`renderItem` 等 P5 删                                                          |
| `render/dom.js`                                                 | `formatUsd`/`formatDuration`/`clip` 迁到 `format.ts`（P1 先复制并加 Intl 版，P5 删原文件）；`el`/`appendAll` P5 删                                          |
| `render/login.js`、`index.html`、`style.css`、`app.js` 余下部分 | P5 删                                                                                                                                                       |

### 3.2 组件树 → 文件（`src/web-hub/ui/src/components/`；props 为冻结契约，P0 以存根落地）

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

视图模型类型（`AgentCardView`、`Notice`、`RunVisualState`、`FleetTreeNode`、`LoginErrorView`、`Route`、`ThemePref`、`ConnState`）集中在 `src/web-hub/ui/src/types.ts`（P0 建、冻结；扩展只能加可选字段）。`RunVisualState` 映射 ui-design §3.2 的状态表，映射函数 `runVisualState(row | agent)` 在 P1 的 `composables/visual-state.ts`（纯函数，测试穷举 §3.2 每行）。

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

### 3.5 渲染调度（节流 ≤10/s，不依赖 rAF）

`composables/renderGate.ts`：`createRenderGate({ intervalMs = 100, hiddenFallbackMs = 1000, setTimeout, clearTimeout, now, doc })` 返回 `{ request(priority: "now" | "throttle"), flush(), dispose() }`：

- `priority "now"`（`select`/`route`/`conn`/`hello`/`agents`/`history`/`page*`/`subscribe*`/`agent_*`/`session`/`status`/`prompt` 等离散事件）⇒ 当前微任务末 `flush`（`queueMicrotask`）。
- `priority "throttle"`（`ev` 中的 `message_update`/`tool_execution_update`，以及 `fleet`）⇒ 前沿立即（距上次 flush ≥ interval）/ 后沿 `setTimeout` 合批，保证 ≤ 10 次/秒。
- `doc.hidden` 为真：不排 100ms 定时，只挂一个 `hiddenFallbackMs` 兜底定时（浏览器对隐藏页定时器的节流只会让它更晚，不会让它永不执行）；`visibilitychange` → 可见时**同步** `flush()`。`pageshow`（bfcache 恢复）同样 `flush()`。
- **源码禁用 `requestAnimationFrame`**（扫描测试）；Vue 自身调度基于 Promise 微任务，不受隐藏 tab 影响；不使用 `<Transition>`（其内部用 rAF）。
- 共享 1s `useTicker` 驱动运行中行的 elapsed 本地递增；`doc.hidden` 时停表，可见时校正。
- 测试（移植 `mount.test.ts` 的 #25 用例 + 新增）：隐藏时 `select` 后 DOM 不变 → 触发 `visibilitychange` 同一 tick 内 DOM 更新；隐藏且无 visibilitychange 时 ≤ `hiddenFallbackMs` 更新；100 帧 `message_update` 在 1s 内 flush ≤ 11 次；离散事件不被节流。

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

### 3.11 版本错配提示

`__PWH_UI_BUILD__ = { version, proto }` 编入产物；收到 `hub` 帧时若 `version` 或 `proto.major` 不一致 ⇒ 全局 warn 横幅「界面构建版本 v… 与 hub v… 不一致，请在主机上重新 `npm run build:web`」。本地路径安装（用户本机）拉代码后忘了重建时最有用。

### 3.12 可访问性

照 ui-design §11 落地：skip link、`nav/main/section` 地标、sr-only `h1`、`aria-current="page"`、原生 `<details>`/`button[aria-expanded]`、单一 sr-only `role="status"`（`useAnnouncer`，节流 ≥2s）、transcript 非 live region、装饰 SVG `aria-hidden`、纯图标按钮必带 `aria-label`、`@media (pointer: coarse)` 44px。

## 4. 测试策略

### 4.1 旧测试处置（`tests/web-hub/web/`）

| 文件                                                                                         | 处置                                                                                                                                                  | 包              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `state.test.ts`                                                                              | 保留；P1 追加 `route` 用例；P5 改 import 路径                                                                                                         | P1 / P5         |
| `client.test.ts`                                                                             | 保留（改 import 到 `token-client.js`）                                                                                                                | P0 / P5         |
| `client-password.test.ts`                                                                    | 保留，P5 改路径                                                                                                                                       | P5              |
| `contract.test.ts`                                                                           | 保留「reduce 接受全部 SSE 事件」「API 路径」；镜像数组比对改为断言 UI 侧 re-export 与 protocol 为同一引用                                             | P5              |
| `markdown.test.ts`                                                                           | parse 部分保留；`toDom` 部分迁为 `MarkdownView` 组件测试                                                                                              | P4 / P5         |
| `render.test.ts`                                                                             | 纯函数（fleetTree/toolView/agentCardModel/bannerText/format）保留；DOM 断言迁为组件测试                                                               | P3/P4 / P5      |
| `mount.test.ts`                                                                              | 订阅副作用、重同步限速、分页、**#25 rAF 挂起回归** 迁为 `useHub`/`renderGate` 测试                                                                    | P1 / P5 删      |
| `login.test.ts`                                                                              | 流程（错误 kind → 文案、倒计时、提交后清密码）迁为 `usePasswordAuth` + `LoginView` 测试                                                               | P1/P3 / P5 删   |
| `auth-mode.test.ts`                                                                          | 三态门迁为 `App.vue` 测试（缺/非法 `data-auth-mode` ⇒ 不读 `#t=`、不碰 localStorage、不发请求、不开 SSE）                                             | P3 / P5 删      |
| `fake-dom.ts`                                                                                | 随上述删除                                                                                                                                            | P5              |
| `no-innerhtml.test.ts`                                                                       | 由 `tests/web-hub/ui/source-scan.test.ts` 取代（§4.3）                                                                                                | P0 建 / P5 删旧 |
| `tests/web-hub/http/static.test.ts`                                                          | 更新映射（去掉 `/assets/<p>` → `<root>/<p>` 回退、顶层白名单）、`uiRoot` 断言、缓存头、未构建页（token 显示路径 / password 不显示 / Accept-Language） | P5              |
| `tests/web-hub/http/lan-static.test.ts` / `lan-host.test.ts` / `lan-password-client.test.ts` | 保留；后者改 import 路径；`lan-host` 的「/ 为 200 且无占位符」在未构建时依然成立（未构建页 200）                                                      | P5              |
| `tests/integration/web-hub-*.test.ts`                                                        | 均为协议层（真 socket + 真 hub + 原始 HTTP/SSE 客户端），不碰前端文件 ⇒ **不受影响**，零改动                                                          | —               |

### 4.2 新增测试（`tests/web-hub/ui/`，组件测试文件头 `// @vitest-environment happy-dom`）

- 逻辑：`render-gate.test.ts`、`use-hub.test.ts`（副作用 + 限速 + 分页 + 路由）、`transport-contract.test.ts`（§3.4）、`hash-route.test.ts`、`theme.test.ts`（含 theme-init.js 在 happy-dom 中执行）、`i18n-parity.test.ts`、`visual-state.test.ts`、`transcript-window.test.ts`、`format.test.ts`、`password-auth.test.ts`。
- 组件：`app-gate.test.ts`、`login-view.test.ts`、`agent-list.test.ts`、`detail-header.test.ts`、`notices.test.ts`、`fleet.test.ts`（嵌套/折叠/深度≥3 默认折叠/Show N Finished）、`transcript.test.ts`（窗口 ≤300 个 `.tx-item`、前插锚点、跟随开关、新消息计数）、`markdown-view.test.ts`（XSS 语料）、`tool-card.test.ts`（partial 截尾）。
- 产物：`tests/integration/web-hub-ui-dist.test.ts`——`existsSync(dist/web-hub-ui/index.html)` 为假时：`PWH_REQUIRE_UI_DIST=1` ⇒ 失败，否则 `skip`。用 `createHttpFrontend` + `fakeDeps`（`tests/web-hub/http/helpers.ts`）起真 hub 前端：`GET /` 200、占位符已替换为 `token`、带 CSP 头；index 引用的每个 `/assets/*` 200 + `immutable`；`/theme-init.js` `no-cache`；`/assets/../package.json` 等穿越 404。

### 4.3 静态扫描（取代 `no-innerhtml.test.ts`）

`tests/web-hub/ui/source-scan.test.ts` 扫 `src/web-hub/ui/{index.html,public/**,src/**/*.{vue,ts,js}}`（P5 后含 `src/logic/**`），剥注释后禁止：`v-html`、`innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`eval(`、`new Function`、字符串 `setTimeout`、`createContextualFragment`、`DOMParser`、`srcdoc`、`.on<x>=` 属性赋值、`setAttribute('on…'|'style')`、模板静态 `style="`、`template:` 选项、`requestAnimationFrame`、`<Transition`、`<script>` 无 `src`（index.html）、`http(s)://` 资源引用（`<link>/<script>/<img>/url()`）、`localStorage` 出现在 `theme`/`token-client` 之外（密码不落盘的静态兜底）。首个用例断言扫描到的文件清单包含关键文件，防止 glob 失效后「零文件全绿」。

### 4.4 浏览器级验收（Playwright，本机，非 CI）

`scripts/web-hub/visual.mjs`（`npx -y playwright@1.62.1`，复用本机缓存的 Chromium）对 `dev:hub` 起的假数据 hub（服务**真实产物** + 真实 CSP 头）：

- 矩阵：宽度 375×812（`isMobile/hasTouch`）、768×1024、820×1180、1440×900 × `colorScheme` light/dark × 场景 dashboard / detail / login / states；`reducedMotion: "reduce"` 得静态帧。截图输出 `/tmp/pwh-visual/<run>/`，与 `docs/dev/web-hub/ui-mockups/screenshots/` 同名对照（样稿 481/1025 断点与实现 768 断点不同，768 档无样稿，按 §0.3 口径人工判读）。
- 自动断言（任一失败脚本非零退出）：`securitypolicyviolation` 事件 0、console error 0、非同源请求 0、失败请求 0；375 下 `documentElement.scrollWidth === 375`；`pointer: coarse` 下所有可交互元素 bounding box ≥44×44；主题三态切换后 `<html>` 类正确且刷新保持。
- axe：另开 `bypassCSP: true` 的 context 注入 `axe-core`（经 npx 缓存路径读取源码后 `page.evaluate`），dashboard/login/states × light/dark 违规 0。严格 CSP 检查只在未 bypass 的 context 做。
- 像素 diff 不设门槛（假数据与样稿文本不完全相同），由 verifier 并排读图判定「结构、配色、密度、层级与样稿一致」，偏差列清单。

### 4.5 假数据 hub（`scripts/web-hub/dev-hub.ts`，P2）

独立小 HTTP 服务（`tsx`），**复用**真 `serveStatic`/`serveIndex`（P5 前传入 `dist/web-hub-ui` 根）与 http.ts 的 `CSP` 常量、安全头；自己实现假 `/api/login|logout|session|subscribe|unsubscribe|history` 与 SSE：`--mode token|password`、`--scenario dashboard|states|empty|long|streaming`、`--login-error invalid|throttled|saturated|not-allowed|busy-exhausted|network`、`--port`。场景帧来自 `tests/fixtures/web-hub-ui/<scenario>.json`（SSE 帧数组 + 定时脚本；dashboard 内容照样稿：6 个 agent 覆盖 running/waiting/idle/outdated/stale/offline、嵌套子 agent 树、完成/出错/运行中工具卡、长代码块、流式消息；long = 1000 条），同一份 fixture 也喂组件测试。只监听 127.0.0.1，Host 校验同真 hub。

### 4.6 真机验收（P5 verifier 必做）

按 memory `live-acceptance-tmux.md`：tmux 起独立 pi（cwd 在 /tmp），开 `webHub.enabled`，`/webhub open` 拿 URL，用 Playwright：token 模式 agent 列表出现、选中后历史加载、流式消息实时出现、切到后台标签再切回 DOM 追上；LAN 模式（`webHub.lan.enabled`）登录 → 历史加载（#25 同类回归只在真 LAN 暴露过）→ 登出；删掉 `dist/web-hub-ui` 后 `/` 为未构建页、`/webhub status` 出现构建提示。测完按确切路径清理。

## 5. 包拆分与并行

### 5.1 总览

| 包         | 内容                                                | 类型 / 模型（memory 路由）               | 依赖                    | 可并行           | 独立可发布           |
| ---------- | --------------------------------------------------- | ---------------------------------------- | ----------------------- | ---------------- | -------------------- |
| **P0**     | 构建脚手架 + 冻结面                                 | general · `cr-anthropic/claude-sonnet-5` | 前置 §0.4               | —                | 是（用户零可见变化） |
| **P1**     | 逻辑层 / 传输 / composables / i18n 骨架             | general · sonnet                         | P0                      | ∥ P2（worktree） | 是                   |
| **P2**     | 假数据 hub + fixtures + visual 脚本                 | general · sonnet                         | P0                      | ∥ P1（worktree） | 是                   |
| **P3**     | 样式移植 + 外壳/列表/详情头/登录组件                | frontend-dev · sonnet                    | P1                      | ∥ P4（worktree） | 是                   |
| **P4**     | 子 agent 树 + 对话流 + markdown + 窗口化            | frontend-dev · sonnet                    | P1                      | ∥ P3（worktree） | 是                   |
| **P6**     | 视觉/可访问性全量验收 + 偏差修复                    | frontend-dev · sonnet                    | P2+P3+P4                | ∥ P5 开发        | 是                   |
| **P5**     | 切换：hub static + 未构建页 + 迁移/删除旧 UI + 文档 | general · sonnet                         | P3+P4（合并在 P6 之后） | ∥ P6 开发        | 是（原子切换提交）   |
| P7（可选） | release web-ui 附件 + 包外查找根                    | general · sonnet                         | P5                      | —                | 是                   |

评审 / 验收：`cr-response/gpt-5.6-sol` ⇄ `zhipu-pool/gpt-5.6-sol`（≠ 开发模型）；每包返回**立即**派 verifier；主会话 `bash_job` 后台跑全量门禁（format:check / typecheck / build:web / check:web / test / build）。开发包挂 `experts: [本方案的 Plan label]`（方案经评审/用户修订后必挂）。dev `timeout_s`：P0/P1/P2/P5 ≈ 1500，P3/P4/P6 ≈ 2400（硬上限，超时拆小重派）。

波次：W1 P0 → W2 P1 ∥ P2 → W3 P3 ∥ P4 → W4 P6 ∥ P5（合并顺序 P6 → P5，P5 rebase 后复跑门禁）→（可选）P7。

### 5.2 各包细则

**P0 构建脚手架 + 冻结面**

- 文件域：`package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、`.github/workflows/ci.yml`、`scripts/release/package.sh`、`scripts/web-hub/check-ui-dist.mjs`（新）、`src/web-hub/ui/{index.html,vite.config.ts,aliases.ts,tsconfig.json,env.d.ts,public/*,src/main.ts,src/App.vue,src/build-info.ts,src/types.ts,src/transport/types.ts,src/styles/index.css,src/styles/tokens.css,src/styles/*.css(空占位),src/icons/*}`、§3.2 全部组件**存根**（`defineProps` 为最终签名，模板只渲染占位）、`src/web-hub/web/token-client.js`（新，自 app.js 抽出）+ `src/web-hub/web/app.js`（改 import）、`tests/web-hub/web/client.test.ts`（改 import）、`tests/web-hub/ui/source-scan.test.ts`（新）、`tests/web-hub/ui/smoke.test.ts`（happy-dom 挂 App 存根）。
- 冻结面（P0 后只有主会话可改）：`package.json`、`vite.config.ts`、`aliases.ts`、`ui/tsconfig.json`、`types.ts`、`transport/types.ts`、`styles/index.css`、组件 props 签名。
- 验收：`npm run build:web` 产出 `dist/web-hub-ui/`、`check:web` 全过（含体积预算）；`typecheck`（含 vue-tsc）/`test`/`format:check`/`build` 全绿；旧 UI 行为不变（`tests/web-hub/web/**` 全绿，含 mount/auth-mode）；`git status` 无产物被跟踪；CI yaml 顺序如 §1.5。成本约 $3–5。

**P1 逻辑层**

- 文件域：`src/web-hub/ui/src/{transport/token.ts,transport/password.ts,composables/**,i18n/**,format.ts}`、`src/web-hub/web/state.js`（仅加 `route`/`routed`/`wanted`，兼容）、`tests/web-hub/web/state.test.ts`（追加）、`tests/web-hub/ui/{render-gate,use-hub,transport-contract,hash-route,theme,i18n-parity,visual-state,transcript-window,format,password-auth}.test.ts`。i18n 各命名空间文件全部建好（P3/P4 只往自己的命名空间加 key：P3 = shell/login/agents/detail/notices/common，P4 = fleet/transcript）。
- 验收：§3.3–3.9 所列行为全部有测试；`transport-contract` 对两种模式跑同一套；#25 回归用例（隐藏页 + visibilitychange / 兜底定时）通过；源码无 rAF；旧 state 用例零改动全绿。成本约 $4–7。

**P2 假数据 hub + visual**

- 文件域：`scripts/web-hub/{dev-hub.ts,visual.mjs}`、`tests/fixtures/web-hub-ui/*.json`、`tests/web-hub/ui/dev-hub.test.ts`（起 dev-hub，断言 CSP 头、SSE 首帧、假登录各错误码）。
- 验收：`npm run dev:hub -- --scenario dashboard` 在 P0 存根产物上可打开、CSP 头与真 hub 字节一致（import 同一常量）；`npm run visual:web` 在存根上跑通并产出截图与检查报告（存根阶段 axe/触控断言允许以 `--allow-stub` 放行）。成本约 $3–5。

**P3 外壳与列表/详情头**

- 文件域：`src/web-hub/ui/src/styles/{base,primitives,notices,shell,agents,detail,dock,login,states}.css`、`components/{shell,agents,detail}/**`、`App.vue`（替换存根实现）、`i18n/{en,zh}/{shell,login,agents,detail,notices,common}.ts`、对应测试（app-gate、login-view、agent-list、detail-header、notices + render.test 中迁出的 DOM 断言）。
- CSS 口径：以 `ui-mockups/app.css` 为源**按段拆分照搬**（类名保持样稿命名，便于逐屏对照），去掉样稿专用段（mock 画廊、`#mock-dark`、`:target` 演示），断点改 §0.3；每个文件自带自己的 `@media` 块（不设共享 responsive.css，避免与 P4 争文件）。不用 scoped CSS（保持与样稿同一套全局类名）。
- 验收：dev-hub dashboard/login/states 在 375/768/1440 × 浅/暗下与样稿结构一致（verifier 读图）；三态主题可切并持久；登录全部错误态文案中英各一套；<768 列表⇄详情（后退键/深链/Esc）；≥768 分栏；visual 脚本自动断言全过（P4 负责区域可暂为存根）。成本约 $8–14。

**P4 子 agent 树与对话流**

- 文件域：`src/web-hub/ui/src/styles/{fleet,transcript}.css`、`components/{fleet,transcript}/**`、`i18n/{en,zh}/{fleet,transcript}.ts`、对应测试（fleet、transcript、markdown-view、tool-card + markdown/render 中迁出的 DOM 断言）。
- 验收：ui-design §5.3/§5.4/§6.4/§6.6 全部条目；long 场景（1000 条）挂载 `.tx-item` ≤300、首屏手机 80；流式 100 帧/s 下 DOM 更新 ≤10/s；XSS 语料全过；工具 partial 截尾；跟随/新消息计数/前插锚点。成本约 $8–14。

**P6 视觉与可访问性全量验收 + 修复**

- 文件域：`src/web-hub/ui/src/{styles,components}/**` 的偏差修复（主会话按 verifier 清单派单）。
- 验收：§4.4 全矩阵自动断言 0 失败、axe 0 违规、375 无横向溢出、触控 ≥44；verifier 并排读图无结构性偏差。成本约 $4–8。

**P5 切换**

- 文件域：`src/web-hub/hub/{static.ts,unbuilt.ts(新),http.ts(三处调用)}`、`src/web-hub/protocol/paths.ts`（加 `uiDistDir()`）、`src/commands/webhub.ts`（未构建提示）、`git mv src/web-hub/web/{state,contract,token-client,password-client}.js + render/{fleet,tools,agents,banner,markdown,transcript}.js → src/web-hub/ui/src/logic/` 并删其中 DOM 函数、删 `src/web-hub/web/` 其余文件、`src/web-hub/ui/aliases.ts` 与 `ui/tsconfig.json` 的 `@logic` 目标、`scripts/web-hub/dev-hub.ts`（改用 `uiRoot()`）、`tests/web-hub/web/**` 迁移/删除（§4.1）、`tests/web-hub/http/{static,lan-password-client}.test.ts`、`tests/integration/web-hub-ui-dist.test.ts`（新）、`AGENTS.md` web-hub 段、`docs/dev/web-hub/arch.md`（§105「零构建」决策加废止注记）、`README.md`/`README.en.md` web-hub 段（构建说明 + git 安装说明）。
- 验收：全量门禁绿；`static.test.ts` 覆盖映射/缓存/未构建页三种语言与两种模式；§4.6 真机验收（token + LAN + 未构建页）通过；`git grep "src/web-hub/web"` 只剩文档里的历史引用；revert 该提交即可恢复旧 UI。成本约 $4–6。

### 5.3 冲突预检要点

- P1 ∥ P2：P1 在 `src/web-hub/ui/src/{transport,composables,i18n,format.ts}` + `state.js` + 测试；P2 在 `scripts/web-hub/` + `tests/fixtures/web-hub-ui/` + `tests/web-hub/ui/dev-hub.test.ts`——无交集。
- P3 ∥ P4：组件目录、CSS 文件、i18n 命名空间按 §5.2 划分，无交集；共享的 `styles/index.css`、`types.ts`、props 签名、`package.json` 已冻结。任一包发现需改冻结面 ⇒ 停下上报主会话统一改。
- P5 ∥ P6：P5 改 hub/逻辑迁移/别名/测试；P6 只改 styles/components——无交集；但 P5 的别名切换会让 P6 分支 rebase 后需复跑门禁，故合并顺序固定 P6 → P5。
- 所有并行写包 `isolation: "worktree"`（隔离从 master HEAD 建，node_modules 软链；整理自动提交按 memory pitfalls 的 cherry-pick 流程，注意剔除 node_modules 软链）；派单 prompt 写明禁 `git stash` / `git add -A`。

### 5.4 成本与轮数估算

开发 ≈ $34–59 + 验收 7×$1–2 + 方案评审 ≈ $2 ⇒ **总计约 $45–75**；主干 4 个波次 + 预计 2–3 轮打回修复。主要成本风险：P3/P4 的 CSS 移植与样稿逐屏比对（2400 行 app.css），以及 P6 的修复轮次。

## 6. 风险与待确认项

### 6.1 风险

| 风险                                                                                   | 缓解                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| git 安装用户默认看到未构建页，且 `pi update` 的 `git clean -fdx` 每次都会清掉本地产物  | 提示页 + `/webhub status` 给命令（A）；推荐 P7（B）与 npm 首发（E）        |
| vitest 2.1.9 × happy-dom 20 不兼容                                                     | P0 验证；退 `happy-dom ~15.11`                                             |
| Vite 5 与 vitest 共用一个 vite 版本，将来升 vitest 3 会连带升 vite 6                   | 显式 pin `vite ~5.4.21`；`@vitejs/plugin-vue 5.2` 两者都支持               |
| Vue 静态提升把大段静态模板经 `innerHTML` 插入 ⇒ 模板里的静态 style 属性被 CSP 静默丢弃 | 源码扫描禁止静态 `style=`；Playwright `securitypolicyviolation` = 0 断言   |
| 隐藏标签页渲染停滞（#25 同类）                                                         | 不用 rAF；visibilitychange 冲刷 + 兜底定时；回归测试                       |
| 两种 transport 行为分叉（78dd76b 同类）                                                | `satisfies` 接口 + `describe.each` 同套契约测试 + P5 真 LAN 验收           |
| 本地路径安装者拉新代码后忘了重建 ⇒ 旧 UI 连新 hub                                      | §3.11 版本错配横幅；index.html `no-cache` 保证重建后立即生效，hub 无需重启 |
| release zip 本身装不成 pi 扩展（既有问题）                                             | 本期只保证产物在 zip 内；另立 todo 修 zip                                  |
| 未构建页在 LAN 泄露主机路径                                                            | password 模式不显示绝对路径                                                |
| a367d7f（wh2-merge）未合入导致 P0 冲突                                                 | §0.4 前置                                                                  |

### 6.2 待用户确认

1. **git 安装路径**：本期采用 A（未构建页 + `/webhub status` 给构建命令，注明 `pi update` 后需重跑）；是否追加 P7（B：release 附带 `pi-toolkit-web-ui-<ver>.zip` + hub 查找包外 `~/.pi/agent/web-hub-ui/<version>/`）；是否计划 npm 首发（E）。C（postinstall 构建）已否决，理由见 §1.7。
2. **新增 devDeps**（全部 MIT，约 +25 MB，仅开发者）：`vue`、`@vitejs/plugin-vue`、`vite`（已存在，显式锁定）、`vue-tsc`、`happy-dom`、`@vue/test-utils`。Playwright / axe-core（MPL-2.0）不进 devDeps，只在本机脚本里经 npx 使用——是否同意。
3. **旧前端删除时机**：建议 P5 一次性切换（此前 hub 一直服务旧 UI，不加运行时开关）。
4. **产物目录** `dist/web-hub-ui/`（复用 dist 的 gitignore / files / zip 流程）。
5. **未构建页返回 200**（而非 503），语言按 `Accept-Language`，LAN 模式不显示主机路径。
6. **i18n 只自动检测、不提供手动语言切换**；**不做虚拟滚动**，只做窗口化（上限 300 个挂载条目）。
