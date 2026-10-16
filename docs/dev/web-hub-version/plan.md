# web-hub 版本面板 + 前后端版本匹配检测 — 实施方案 v2

> 状态：**R1 修订版**（评审 gpt-6.1-sol 结论 REVISE，13 条已全部处置，见 §R1）；§9 四项决策已于 2026-10-16 由用户拍板。
> 用户原话：「版本号那里，点击一下可以查看后端版本，changelog 等信息，另外，前端具备检测后端版本是否匹配的能力」。
> 取代 `docs/dev/web-hub/vue-plan.md` §3.11 的软提示横幅（从未落地；`i18n/{zh,en}/detail.ts` 的 `versionMismatch` 键无人引用，本方案删除）。

## 0. 现状核对（已验证）

| 事实                                                                                                                                                                                                                                                                                                                                | 位置                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 顶栏 `<span class="topbar-meta">ui {stamp}</span>` 不可交互，CSS 仅 ≥1025px 显示；hub 版本只在品牌 tooltip                                                                                                                                                                                                                          | `ui/src/components/shell/TopBar.vue`、`styles/shell.css:160/358`                    |
| `UI_BUILD = {version, proto:{major}, commit, builtAt}`，commit = 12 hex[`-dirty`] 或 `unknown`；`builtAt` 受 `SOURCE_DATE_EPOCH` 影响可固定                                                                                                                                                                                         | `ui/src/build-info.ts`、`protocol/ui-manifest.ts`                                   |
| hub `buildId` = `<version>@<git %h>[*]`（脏=`*`；无 git `@nogit`；超时 `@unknown`），由**拉起 hub 的 pi 进程**首次调用时计算并缓存，hub 自己不算                                                                                                                                                                                    | `agent/index.ts:1064,1815`                                                          |
| bug：`logic/build-stamp.js` `shortCommit` 只剥 `-dirty`，`abc1234*` ⇒ `null`                                                                                                                                                                                                                                                        | 同左                                                                                |
| `HubInfo` 已有 `version, buildId, pid, startedAt, proto, caps`；SSE `hub` 帧 = `{...info, port}`，连接直发 + `registry.publish({type:"hub"})` 广播                                                                                                                                                                                  | `hub/ports.ts:573`、`hub/http.ts:852/908`                                           |
| `AgentCard` 有 `pluginVersion`、`outdated`（semver < hub），**无 `buildId`**；UI 原样保存 card                                                                                                                                                                                                                                      | `protocol/http-contract.ts:135`、`hub/registry.ts:184`、`ui/src/logic/state.js:660` |
| 非托管 agent semver 高于 hub ⇒ supersede；**托管 agent 绕过 supersede**，只在 spawn 记录上打 `hint:"newer-plugin"`；同版本不同 commit 无任何检测                                                                                                                                                                                    | `hub/hub.ts:462`、`hub/supersede.ts`                                                |
| hub 只服务 `version`/`proto.major` 与自身相等的 UI 根，并在**加载时**读入并逐个校验 manifest 中每个文件的 sha256，之后只从内存服务；重部署探测仅在请求 `/` 时（节流 1s）进行，`serve()` 中 `maybeRefresh` → `logStatus` → `opts.onStatus`（hub.ts 里接 `hubJson.patchUi`）；`UI_ROOT_RESOLVE_TIMEOUT_MS = 3000`                     | `hub/ui-root.ts:504/606`、`hub/static.ts:178/246`                                   |
| 构建产物 `index.html` 只引用两个哈希资源：`/assets/index-<hash>.js`（module）+ `/assets/style-<hash>.css`，Vite 哈希即内容指纹                                                                                                                                                                                                      | `dist/web-hub-ui/index.html`                                                        |
| 重部署后旧标签页的懒 chunk 会 404（hub 只服务当前 manifest）                                                                                                                                                                                                                                                                        | `hub/static.ts`                                                                     |
| hub 只能 import `src/git/{run,worktrees,diff,graph}.ts` + sysload 闭包（不能 import `src/hud/plugin-info.ts`）                                                                                                                                                                                                                      | `tests/web-hub/boundary.test.ts`                                                    |
| graph 的 git 加固先例：`--no-lazy-fetch`（git ≥2.45，旧 git 退出码 129，**禁止去掉该参数重试**）、`--no-replace-objects`、`--no-pager`、`core.hooksPath=/dev/null`、`log.showSignature=false`、`log.mailmap=false`、`--no-notes`；`run.ts` 支持 `signal`，`envPolicy:"minimal"` 已设 `GIT_OPTIONAL_LOCKS=0`/`GIT_TERMINAL_PROMPT=0` | `src/git/graph.ts:61-115`、`src/git/run.ts`                                         |
| CHANGELOG.md 在包根，只在发版时生成，两版之间 `[Unreleased]` 为空                                                                                                                                                                                                                                                                   | `scripts/release/release.sh`                                                        |
| 打包预算：首屏 JS 512 KiB gz / 懒加载 JS 128 KiB / CSS 64 KiB，仅作粗粒度报警线                                                                                                                                                                                                                                                     | `scripts/web-hub/check-ui-dist.ts`                                                  |
| `tests/fixtures/quota/topbar-no-quota-golden.html` 逐字节钉住 TopBar DOM（重生成器绑定 quota 之前的 HEAD）                                                                                                                                                                                                                          | `tests/web-hub/ui/quota-pill.test.ts`                                               |

## 1. 目标 / 非目标

目标：①顶栏版本号可点击：桌面弹 popover，窄屏在设置弹窗的「版本」卡里直接展示同一内容；②显示 UI / hub / 当前会话 agent / 磁盘 HEAD 与最近提交 / 已发布 CHANGELOG；③检测 UI、hub、agent 三方版本是否匹配，并区分四种状态：**一致 / 不一致 / 有证据的「旧于」/ 无法验证**；结果用版本按钮上的圆点 + 面板中的「建议」区呈现。
非目标：pi 本体版本；自动刷新、重启或 reload；`git fetch`；横幅。

## 2. 冻结面（V0 先合，V1/V2 不再改这些文件）

**`protocol/version.ts`**（追加）：`export const VERSION_HUB_CAP = "version.v1";`（无条件声明，经 `extraHubCaps` 同源进入 `HubInfo.caps` 与 `hello_ack.caps`；无新帧、无新 SSE 事件 ⇒ 不升 PROTO）。

**新 `protocol/version-info.ts`**（纯函数，UI 与 hub 共用）：

```ts
export const VERSION_INFO_PATH = "/api/version";
export const VERSION_LIMITS = {
  changelogSections: 5,
  sectionBytes: 8192,
  fileBytes: 1 << 20,
  commits: 20,
  subjectChars: 200,
  bodyBytes: 64 * 1024,
  waiters: 8,
  requestMs: 4000,
  gitStepMs: 1000,
  fileMs: 1000,
  okTtlMs: 30_000,
  failTtlMs: 10_000,
} as const;

export interface CommitRef {
  commit: string;
  time?: number;
  dirty?: true;
} // commit = 小写 hex ≥7
/** 当前「被服务」的 UI 根身份；assets = 已校验 index.html 引用的 /assets/* 路径（排序，≤4）= 内容指纹 */
export interface HubUiBuildWire {
  source: "package" | "external";
  version: string;
  commit: string;
  builtAt: string;
  assets: string[];
}
export type SectionError = "timeout" | "unavailable" | "git-too-old" | "too-large" | "missing";

export interface VersionInfoWire {
  v: 1;
  checkedAt: number;
  hub: { pid: number; startedAt: number }; // 代际键，UI 用它丢弃过期快照
  repo?:
    | {
        head: CommitRef;
        packageVersion?: string;
        lastTag?: string;
        commits?: { commit: string; time: number; subject: string }[];
        commitsTotal?: number;
      }
    | { error: SectionError }; // 包根不是 git toplevel ⇒ 整键缺省
  changelog?:
    { sections: { title: string; date?: string; markdown: string; truncated?: true }[] } | { error: SectionError };
  truncated?: true;
}
export function parseVersionInfoWire(x: unknown): VersionInfoWire | undefined; // 永不抛
export function normalizeCommit(s: unknown): { hex: string; dirty: boolean } | null; // 剥 `@…`、`*`、`-dirty`；nogit/unknown/非 hex ⇒ null
export function compareCommit(a: unknown, b: unknown): "same" | "differ" | "unknown"; // 前缀相等(min≥7)；任一 null ⇒ unknown
```

**`hub/ports.ts`**（仅追加）：

```ts
// HubInfo:
ui?: HubUiBuildWire;        // UI 根状态为 ok 时存在
bootHead?: CommitRef;       // hub 启动后首次观测到的磁盘 HEAD（不保证等于已加载代码，§10）
// 新端口 + FrontendDeps 字段:
export type VersionInfoOutcome = { ok: true; data: VersionInfoWire } | { ok: false; code: "E_BUSY" | "E_DEADLINE" };
export interface VersionInfoPort { snapshot(signal: AbortSignal): Promise<VersionInfoOutcome> } // signal = 该请求方的断连信号，只解绑等待者
// FrontendDeps: version?: VersionInfoPort;
//               onUiServed?: (ui: HubUiBuildWire | undefined) => void; // static.ts 的 logStatus 内与 onStatus 同点调用
```

**`protocol/http-contract.ts`**：`AgentCard.buildId?: string`。

V0 测试 `tests/web-hub/protocol/version-info.test.ts`：normalizeCommit 覆盖 `@abc1234*` / `-dirty` / `nogit` / `unknown` / 大写 / 少于 7 位；compareCommit 前缀规则；parse 拒绝超界和类型错误。

## 3. 后端（V1：`protocol/paths.ts`、`hub/{changelog,version-git,version-info,static,hub,registry,http}.ts` 及其测试）

**3.1** `protocol/paths.ts` 追加 `packageRootDir()`（推导方式同 `packageUiDistDir`）。

**3.2** 新 `hub/changelog.ts`（纯函数）`parseChangelogSections(text, limits)`：按 `^## \[` 切节，空 `[Unreleased]` 跳过，剥离引用式链接定义；`[0.5.5] - 2026-10-16` 解析为 `{title, date}`；每节按行截断到 8 KiB。

**3.3** 新 `hub/version-git.ts`：基于 `run.ts`，**每条命令**都带统一前缀（frozen argv，测试逐字节钉住）：
`--no-lazy-fetch --no-replace-objects --no-pager --no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false`，并设 `cwd=pkgRoot`、`envPolicy:"minimal"`、`pathOverride: WTDIFF_GIT_PATH`、`maxStdoutBytes` 64 KiB、`signal` 取服务级 AbortController。三个阶段串行，阶段内并行，每步 `min(剩余, 1000ms)`：

1. `rev-parse --show-toplevel`：realpath 必须等于 `pkgRoot`，否则不输出 repo（排除宿主仓库，语义对齐 `hud/plugin-info.ts`）；
2. `log -1 --format=%h%x09%ct …` ∥ `status --porcelain --untracked-files=no --ignore-submodules=all` ∥ `describe --tags --abbrev=0 --match v[0-9]*`；
3. `log -n 20 --format=%h%x09%ct%x09%s <tag>..HEAD` ∥ `rev-list --count <tag>..HEAD`。

所有 `log` 额外带 `-c log.showSignature=false -c log.mailmap=false --no-show-signature --no-use-mailmap --no-notes --no-decorate --no-color`。退出码 129 ⇒ `error:"git-too-old"`，永不去掉加固参数重试。subject 截断到 200 字符并剔除控制字符；**不采集**作者名和邮箱。

**3.4** 安全读文件 `readBounded(path)`（CHANGELOG.md 和 package.json 共用）：`open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` → `fstat` 必须是普通文件且 size ≤ 1 MiB → 读至多 cap+1 字节 → `finally close`。FIFO、符号链接、超大文件分别映射到 `unavailable`/`too-large`。缓存键 `(dev, ino, size, mtimeMs)`。

**3.5** 新 `hub/version-info.ts` `createVersionInfoService({pkgRoot, info, git?, fs?, now, log}) : VersionInfoPort & { captureBootHead(): void; dispose(): void }`（不持有 UiServer——它在 http 前端内构造）：

- **单飞**：同一时刻最多一轮计算，等待者 ≤ 8 个，超出 ⇒ `E_BUSY`。成功结果缓存 30s，失败段（`repo.error`/`changelog.error`）缓存 10s。
- **预算**：计算总长 ≤ 4000ms，两路并行：文件读取 ≤1s、git 三阶段 ≤3s（UI 探测由 http 层并行发起，见 3.9）。到期由服务级 AbortController 终止 git，未完成的段落为 `error:"timeout"`，按部分结果返回。
- **生命周期**：fs open/read 无法取消，此时**计算槽一直占用到 IO 真正结束**；迟到的结果按 generation 丢弃。请求方断连只摘除该等待者，不中断共享计算。
- 超出 `bodyBytes` 时依次裁剪 changelog 尾节、提交尾部，并置 `truncated`。
- `captureBootHead()`：hub 启动后跑一次阶段 1+2（只取 HEAD），成功则 `info.bootHead = …` 并 `registry.publish({type:"hub"})`；失败静默，不重试。
- 无 interval、无常驻定时器；git 计时器由 `run.ts` 负责 unref。

**3.6** `hub/static.ts`：把 `serve()` 开头的 `maybeRefresh(urlPath) → logStatus(status)` 抽成私有 `refreshFor(urlPath)`；`UiServer` 追加 `probe(): Promise<UiStatus>` = `refreshFor("/")`。这样只请求 `/api/version` 也会走完整的 `logStatus → onStatus` 链（hub.json、`info.ui`、广播一并更新）。`opts.onServed?.(projectUi(status, root))` **不放在 `logStatus` 的去重之后**（现有 `statusSignature` 只含 source/version/commit/builtAt，assets 变化会被提前 return 吞掉——R2 #2/#5）：`refreshFor()` 在 `logStatus` 之外按独立签名 `served = rootGeneration + assets.join()` 去重后调用 `onServed`，`onStatus` 的原有去重语义不变；集成测试覆盖「commit/builtAt 不变、仅 assets 变化的重建 ⇒ 恰好一次 `hub` 广播」。`assets` 从当前已校验根的内存 `index.html` 中按正则提取 `src|href="/assets/…"`，并经 `isAllowedUiPath` 与 manifest 双重校验，按 root `info` 对象缓存；http.ts 把 `deps.onUiServed` 透传为 `onServed`。

**3.7** `hub/hub.ts`：`extraHubCaps += VERSION_HUB_CAP`；新增 `onUiServed: (next) => { if (sameUi(info.ui, next)) return; next ? (info.ui = next) : delete info.ui; if (closing === undefined) registry.publish({ type: "hub" }); }`（`onUiStatus → hubJson.patchUi` 保持不变）；构造 service、调用 `captureBootHead()`，`cleanup`/`close()` 中 `dispose()`，并传入 `FrontendDeps.version`。

**3.8** `hub/registry.ts` `card()` 追加 `buildId: r.buildId`。

**3.9** `hub/http.ts`：两个 listener 同宽，仿 `LOAD_TOP_PATH`。loopback：缺 `X-PWH` ⇒ 403、未认证 ⇒ 401、`cmdLimit` 按 `loopback:<principal>:version` 限速。LAN：`requireLanSession` 配 `deriveBudget(8000, LAN_AUTH_CAP_MS, 4000)`。随后并行 `[rt.ui.probe()（以剩余预算为上限）, version.snapshot(断连 signal)]`。`probe()` 在 static.ts 内**跨请求单飞**（一个在途 promise + 等待者 ≤8，超出 ⇒ `E_BUSY`）；请求方的等待超时只结束该次等待，单飞槽一直占到底层 fingerprint lstat/resolve 真正 settle 才释放（与 ui-root 的 resolve 单飞同口径，R2 #8），测试「probe 悬挂时重复请求不叠加 IO」，两者都结束后再响应——probe 引起的 `hub` 广播同步发生在探测完成时，必然早于本响应；`E_BUSY` ⇒ 503，`E_DEADLINE` ⇒ 504，均设 `no-store`。`deps.version` 缺省时落回原有 404/401 矩阵。不新增错误码。

**3.10 暴露清单（D3 已批：LAN 与 loopback 同宽）**。会暴露：hub `version/buildId/pid/startedAt/bootHead`；被服务 UI 的 `version/commit/builtAt/source/assets`；磁盘 HEAD 的 commit/时间/dirty、`package.json` 的 version、最近 tag 名；≤20 条提交（短 hash、时间、subject）；≤5 节 CHANGELOG。**绝不出现在响应里**：任何文件系统路径（pkgRoot、home、候选目录）、git stderr、`UiStatus.candidates`/拒绝原因/detail、作者名和邮箱。

**3.11 V1 测试**

- `hub/changelog.test.ts`：章节切分与各类边界。
- `hub/version-git.test.ts`：argv 逐字节钉住；129 ⇒ git-too-old 且不重试；**partial clone 零网络回归**：`clone --filter=blob:none`，再把 promisor remote 指向不可达 URL，snapshot 成功且不出现 fetch。
- `hub/version-info.test.ts`：冷缓存预算；持续失败时走 10s 失败缓存；单飞（20 个并发只跑一轮 git）；第 9 个等待者 ⇒ E_BUSY；断连只摘除自己；FIFO 替换 CHANGELOG（O_NONBLOCK 不阻塞，按非普通文件拒绝）；fs 迟到完成期间槽位仍被占用；bootHead 只抓一次且抓到时广播一次。
- `http/api-version.test.ts` + `lan-version.test.ts`：403/401/200/429，deps 缺省时矩阵不变；**泄露断言**：用户可编辑字段（subject/CHANGELOG）用不含路径的夹具，深度扫描响应中所有字符串，不得含 pkgRoot/home 路径、假 runner 的 stderr、候选 dir/reason 文本。
- 重部署集成测试：只请求 `/api/version` ⇒ hub.json 被 patch，且恰好一次带新 `ui` 的 `hub` 广播；未变化 ⇒ 零次。
- 同步更新现有钉子：`caps-coexist`、`registry`/`http/sse`/`run-transcript` 中做精确 `toEqual` 的 card（加 `buildId`）。`boundary.test.ts` 不改（新代码只 import `run.ts`/`diff.ts`）。

## 4. 匹配规则（V2 纯逻辑 `ui/src/logic/version-match.js`）

**有效 hub 身份**只取**当前 hub 帧**：`version/buildId/proto/ui?/bootHead?`，代际键 `${pid}:${startedAt}`。`/api/version` 快照只提供 `repo`/`changelog`，其 `hub.pid/startedAt` 与当前帧不符就丢弃；代际变化时清空快照。hub 的 commit 取 `bootHead ?? buildId`。
**tab 身份** = `UI_BUILD` + 启动时从自身 DOM 读到的资源路径（`script[type=module][src^="/assets/"]`、`link[rel=stylesheet][href^="/assets/"]`，排序）。

术语与呈现：`一致` / `不一致`（只有 commit 差异，方向未知）/ `旧于`（仅有 semver 顺序证据时）/ `无法验证`（任一侧 commit 不可解析、旧 hub 缺字段、npm/`nogit`）。**「无法验证」从不点亮圆点**，面板显示灰色「无法验证」，不能当作一致。

| code               | 条件                                                                                                          | 状态 / 圆点                                                                               | 建议（措辞为「建议」，不保证修复）                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tab-stale`        | `hub.ui` 存在且 `hub.ui.assets ≠ tab.assets`（内容指纹，dirty 或固定 builtAt 的重建也能识别）                 | 不一致 / **warn**                                                                         | 刷新页面（hub **已经**在服务另一份可用 bundle，刷新必然拿到它） |
| `ui-unservable`    | `hub.ui` 缺失但 cap 存在（hub 当前没有可服务的 UI 根），或 `proto.major` 不同且无 `hub.ui`                    | 不一致 / **warn**                                                                         | `/webhub restart`（或 `npm run build:web`）；**不建议刷新**     |
| `hub-disk-changed` | 快照 `repo.head` 与 `hub.bootHead` 都有且 `compareCommit=differ`（分支切换/回退也会触发，故**不称「旧于」**） | 「hub 启动后磁盘代码已变化」/ info                                                        | 可尝试 `/webhub restart`                                        |
| `hub-older`        | `repo.packageVersion` semver > `hub.version`（唯一的顺序证据）                                                | 旧于 / info                                                                               | `/webhub restart`                                               |
| `ui-drift`         | 无 `tab-stale`；`compareCommit(hub.ui.commit ?? UI_BUILD.commit, repo.head ?? hubCommit) = differ`            | 不一致 / info                                                                             | 可尝试 `npm run build:web`                                      |
| `agent-older`      | `card.outdated === true`                                                                                      | 旧于 / info                                                                               | `/reload`                                                       |
| `agent-newer`      | `compareVersions(card.pluginVersion, hub.version) > 0`（托管 agent 绕过 supersede 时会出现）                  | 不一致（hub 较旧）/ info                                                                  | `/webhub restart`                                               |
| `agent-drift`      | 同版本且 `compareCommit(card.buildId, hubCommit) = differ`                                                    | 不一致 / info                                                                             | 「可尝试 /reload 或 /webhub restart」（不判断方向）             |
| `dirty`            | 任一侧 commit 相同但 dirty                                                                                    | 仅面板 info「工作树有未提交改动」，**不点亮圆点**（bundle 差异由 `tab-stale` 的指纹兜住） | —                                                               |

圆点只反映 UI↔hub 与**当前选中会话**；其他会话中「不一致/旧于」的计数在面板里汇总成一行（卡片上已有 `outdated` 图标，不重复打点）。重新计算的时机：hub 帧到达、选中会话变化、面板打开（拉一次快照），以及 `visibilitychange→visible` 且距上次 ≥10min 且有 cap。前端无轮询、无定时器。

## 5. 前端（V2：`src/web-hub/ui/**`、`tests/web-hub/ui/**`、`tests/fixtures/version/**`）

**5.1 逻辑与传输**

- `logic/build-stamp.js`：`shortCommit` 兼容 `*` 与 `-dirty`；新增 `tabAssets(document)`。
- 新 `logic/version-match.js`：实现 §4。
- 传输五件套照 `loadTop` 的形状添加 `versionInfo(signal)`：`logic/contract.js`、`logic/{token,password}-client.js`（GET，`X-PWH: 1`）、`transport/types.ts`、`transport/{token,password}.ts`。
- 新 `composables/useVersionInfo.ts`：状态机 `idle|loading|ok|error|unsupported`，单飞，cap 缺失 ⇒ `unsupported` 且**永不请求**；结果经 `parseVersionInfoWire` 校验并做代际过滤；`visibilitychange` 监听成对注册/注销。由 TopBar 通过 `provide(VERSION_CTX)` 提供。

**5.2 组件**

- `TopBar.vue`：`<span class="topbar-meta">` 换成 `<span class="version-anchor"><button class="topbar-meta version-chip" aria-haspopup="dialog" :aria-expanded aria-controls="version-panel">ui {stamp}<span v-for="lv in dotList" class="version-dot" :data-level="lv"/></button><VersionHost v-if="open"/></span>`。`dotList` 是 0/1 项 `v-for`，none/unknown 时零节点。齿轮按钮镜像一个同样的 0/1 圆点，仅在 <1025px 显示。
- 新 `shell/VersionHost.vue`（首屏组件）：≥1025px 用非模态 popover（Esc 带 `preventDefault`、外部 pointerdown 关闭、焦点回到按钮，照 `SettingsOverlay` 桌面分支）；<1025px 顶栏版本号不显示，入口是设置弹窗内联的「版本」卡（见下）。内容通过 `defineAsyncComponent({ loader: () => import("./VersionPanel.vue"), timeout: 8000, errorComponent: VersionLoadError })` 懒加载。**首屏**组件 `VersionLoadError` 区分两种情况：若 §4 已证实 `tab-stale`，显示「页面版本已过期」+ 刷新；否则显示「面板加载失败」+ 重试（换 key 重建 async 组件），**不声称过期**。
- 新 `shell/VersionPanel.vue`（懒块），区块依次为：
  1. **建议**：每条 finding 一行；refresh 是按钮，其余是 `detail/CopyButton.vue` 可复制的命令。
  2. **界面**：tab 与被服务 bundle。
  3. **hub**：version、buildId、bootHead、启动时间与运行时长（打开时计算一次）、pid。
  4. **当前会话**。
  5. **仓库**：HEAD、package version、tag、`<details>` 折叠的 ≤20 条提交，纯文本插值。
  6. **更新日志**：`<details>` + `transcript/MarkdownView.vue`，零 `v-html`。

  cap 缺失时 5/6 区替换为一行「hub 版本过旧，升级后可见」。

- `SettingsView.vue`：新增「版本」卡（`settings-card-wide`）。**2026-10-16 用户补充（D4 细化）：手机模式下版本信息直接展示在设置弹窗里**，不再「先关设置、再开 sheet」——卡片内联渲染同一个 `VersionPanel`（经 `VersionHost` 的懒加载 + errorComponent 兜底，`embedded` 模式：无 popover/sheet 外壳，区块 1–4 默认展开，5「仓库」6「更新日志」为 `<details>` 默认折叠以控制弹窗高度）；`useVersionInfo` 在卡片挂载（即设置打开）时才请求。≥1025px 的设置面板同样显示该卡（与顶栏 popover 共用 composable 单飞，不重复请求）。
- 新 `styles/version.css`：使用 `--c-info`/`--c-warning`；`.topbar-meta` 的 ≥1025px 显示规则改挂到 `.version-anchor`。
- i18n：新 `i18n/{en,zh}/version.ts`，zh 写 `satisfies Record<keyof typeof en, string>`。紧凑标记只用英文（`ui 0.5.5@33a89f1`、`dirty`、`up 3h12m`），长句用中文。删除 `detail.versionMismatch`。

**5.3 测试与金样**

- `ui/version-match.test.ts`：§4 逐行覆盖，含无法验证（`nogit`/`unknown`/旧 hub）、dirty 同 HEAD 不点亮、assets 不同但 commit/builtAt 相同 ⇒ tab-stale、`hub.ui` 缺失 ⇒ ui-unservable 而非 refresh、**newer managed agent ⇒ agent-newer 而非 /reload**、过期快照被丢弃。另外**逐条测试每个 finding 的消失条件**。
- `ui/version-panel.test.ts`：开关交互；Esc/外部点击/焦点回归；<1025 走设置卡内联（embedded）；cap 缺失时不发任何请求、不出现 repo/changelog 提示；loader 挂起 ⇒ 8s 后显示 errorComponent；loader 被拒但未证实 stale ⇒ 显示「加载失败」而非「过期」；`settings-overlay.test.ts`：设置弹窗内联渲染版本卡、details 折叠、打开设置才请求端点。
- `ui/build-stamp.test.ts`：`*` 后缀；`.topbar-meta` 断言改为按钮。
- **金样**：`topbar-no-quota-golden.html` **原样保留**作为历史基线。`quota-pill.test.ts` 比较前先做一次经审计的限定归一化：把 `.version-anchor` 子树还原为旧的 `<span class="topbar-meta" translate="no">ui …</span>`，其余 DOM 仍逐字节比对。另新增 `tests/fixtures/version/version-anchor-golden.html`（人工审计，文件头写明来源）逐字节钉住新子树。**no-cap 允许的变化**冻结为三处：版本按钮、设置「版本」卡、`ui-drift`/`agent-*` 回落圆点，此外 DOM 与历史基线一致。
- `npm run build:web && npm run check:web`：预计首屏 +≈2 KB gz、懒块 +≈4 KB gz，不改预算。

## 6. 兼容矩阵

| 组合                                                       | 行为                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 UI × 旧 hub（无 cap、`ui`、`bootHead`、`card.buildId`） | 可用：按钮、面板 1–4 区、`agent-older`/`agent-newer`（semver）、`ui-drift`（UI commit vs `buildId`）；`tab-stale`/`hub-disk-changed`/`hub-older`/`agent-drift` ⇒ 无法验证；不请求端点 |
| 旧 UI × 新 hub                                             | 忽略新增 cap/字段，行为逐字节不变                                                                                                                                                     |
| npm / `nogit` 安装                                         | 所有 commit 规则 ⇒ 无法验证（灰显）；`tab-stale`（assets）、semver、`ui-unservable` 照常；changelog 照常                                                                              |

不升 PROTO；无新帧、无新 SSE 事件、无新错误码；agent 侧零改动。

## 7. 包拆分

| 包        | 文件域（独占）                                                                                                                                                                                                                     | 依赖  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| V0 冻结面 | `protocol/version.ts`（仅追加常量）、`protocol/version-info.ts`、`hub/ports.ts`（`HubInfo.ui/bootHead`、`VersionInfoPort/Outcome`、`FrontendDeps.version/onUiServed`）、`protocol/http-contract.ts`（`AgentCard.buildId`）+ 其测试 | —     |
| V1 后端   | §3 所列文件，不触碰 V0 文件                                                                                                                                                                                                        | V0    |
| V2 前端   | §5 所列文件（对假 transport 开发）                                                                                                                                                                                                 | V0    |
| V3 集成   | 真 hub + 真构建联调，跑完整门禁 `format:check → typecheck → test → build → build:web → check:web`                                                                                                                                  | V1+V2 |

车道 L2，每个包完成后立即派 verifier（验收模型 ≠ 开发模型）。

## 8. 验收（tmux 真机，各 finding 分别验证出现与消失）

1. ≥1025px 点击按钮打开面板，Esc/外部点击关闭且焦点回归；≤480 与 481–1024 打开设置弹窗即可看到版本卡内联内容（仓库/更新日志默认折叠）。
2. 面板各区齐全，CHANGELOG 渲染无 `v-html`。
3. `tab-stale`：提交并执行 `build:web`，任一请求 `/` 或打开面板后，所有标签页显示 warn；刷新后**仅**该条消失，其他 finding 不受影响。
4. `ui-unservable`：在 hub 不重启的情况下把 package.json 版本改为 bump 后的版本并 `build:web`（旧 hub 拒绝服务新根）⇒ 建议 `/webhub restart`，不建议刷新；restart 后消失。
5. `hub-disk-changed`：`git pull`（或新增 commit）后打开面板出现；`/webhub restart` 后消失。`hub-older`：package.json 版本号高于运行中 hub 时出现。
6. `agent-drift` / `agent-older`：某会话不 `/reload` ⇒ 选中时亮 info，`/reload` 后消失；未选中的会话只计入汇总行。
7. dirty 同 HEAD：只出现「工作树有未提交改动」，不亮圆点。
8. 旧 hub + 新 UI：不请求端点，面板显示降级文案，无报错 toast。
9. 旧 bundle 遇 chunk 404：已证实 stale ⇒ 「页面已过期」；断网 ⇒ 「加载失败 + 重试」。
10. `/api/version`：响应 ≤64 KiB；20 个并发请求只跑一轮 git；hub 无常驻定时器；`caps-coexist`/`boundary`/source-scan 全绿。

## 9. 决策（2026-10-16 用户已拍板）

| #   | 决策                                                                              | 结论                                               |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| D1  | 包含 git 信息（boot HEAD、当前磁盘 HEAD、自上个 tag 的提交，≤20 条）              | **已批准**                                         |
| D2  | 版本按钮圆点 + 面板「建议」区取代 vue-plan §3.11 横幅                             | **已批准**                                         |
| D3  | 不加开关；LAN 与 loopback 同宽（含提交标题与 CHANGELOG，暴露清单见 §3.10）        | **已批准**（单用户 LAN，密码认证，与 U1 裁定一致） |
| D4  | <1025px 入口 = 设置「版本」卡 + 齿轮圆点；2026-10-16 细化：版本信息内联在设置弹窗 | **已批准**                                         |

## 10. 残余风险

- `bootHead` 是 hub「启动后首次观测」的磁盘 HEAD，与实际加载代码之间没有时间上界：若 `git pull` 与 hub 启动交错，`hub-disk-changed` 可能漏报。
- `tab-stale` 的主动通知依赖 hub 观测到重部署（有人请求 `/`、打开面板，或可见性刷新 ≥10min）；不加 hub 侧轮询。
- 提交 subject 与工作树中的 CHANGELOG 由用户自己编写，可能含路径或秘密；D3 已接受同宽暴露，hub 自身产生的字段保证不含路径（§3.11 泄露断言）。
- 托管 rpc 会话的 `/reload` 建议可能被网页命令策略拒绝，文案附带「或在会话列表中重新拉起」。

## §R1 处置表（评审 gpt-6.1-sol，REVISE）

| #   | 评审要点                                    | 处置                                                                                                                                                                       |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 冻结面不全，V1 需改 ports.ts                | V0 一次冻结 `FrontendDeps.version/onUiServed`、`VersionInfoPort`、`VersionInfoOutcome`、`HubInfo.ui/bootHead`；V1 不再改 V0 文件（§2、§7）                                 |
| 2   | `probe()` 漏掉 `logStatus/onStatus`         | 抽出 `refreshFor()`，serve 与 probe 共用完整链路；集成测试验证只请求 `/api/version` 也恰好广播一次（§3.6、§3.11）                                                          |
| 3   | 版本不同就建议刷新，可能落到 unbuilt        | 只在 `hub.ui` 已在服务另一份 bundle 时建议刷新；无可服务根 ⇒ `ui-unservable` 建议 `/webhub restart`；各 finding 分别验收消失条件（§4、§8.3–4）                             |
| 4   | commit 不同 ≠ 旧；托管 agent 绕过 supersede | 只有 commit 差异一律称「不一致」，只凭 semver 或 boot-vs-disk 证据称「旧于」；新增 `agent-newer`，并测试 newer managed agent（§4、§5.3）                                   |
| 5   | dirty/无 git 被当作一致；builtAt 可固定     | 新增「无法验证」状态且不点亮圆点；bundle 身份用已校验 index.html 引用的哈希资源（manifest 内容指纹）；dirty 同 HEAD 仅显示 info；统一 §6 的回落规则                        |
| 6   | bootHead 不在 SSE，代际未定义，2s 无据      | `bootHead` 进入 `HubInfo`，抓到后广播；有效身份只取当前 hub 帧，快照按 `pid:startedAt` 失效；删除 2s 说法（§2、§4、§10）                                                   |
| 7   | 可能隐式联网                                | 每条命令加 `--no-lazy-fetch`/`--no-replace-objects`/签名、mailmap、notes 隔离，status 加 `--ignore-submodules=all`，129 不重试；加 partial clone 零网络测试（§3.3、§3.11） |
| 8   | 预算、取消、并发未定义                      | 4s 总预算拆分、单飞、等待者 ≤8、成功缓存 30s / 失败缓存 10s、AbortSignal 传入 git、不可取消的 IO 一直占槽到结束；测试冷缓存、持续失败、断连（§3.5）                        |
| 9   | CHANGELOG 可被换成 FIFO                     | `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK` + fstat + 限量读 + finally close；测试 FIFO 替换与迟到完成（§3.4）                                                                      |
| 10  | LAN 暴露                                    | D3 用户已批准同宽，不加门控；明列暴露清单，并断言响应不含路径、stderr、candidates（§3.10–3.11）                                                                            |
| 11  | 懒块兜底不足                                | 8s 加载超时 + 首屏 errorComponent，区分「加载失败」与「已证实过期」；实测 chunk 404 与设置→sheet 焦点顺序（§5.2、§8.9）                                                    |
| 12  | 金样重抓会整体批准新 DOM                    | 保留历史基线 + 限定归一化，新增审计过的 version-anchor 金样；冻结 no-cap 允许的三处变化（§5.3）                                                                            |
| 13  | 范围过大                                    | D1 已批准，范围保留；提交列表缩到 ≤20 条，方向推断收紧为需要证据（同 #4）                                                                                                  |

## §R2 主会话裁定（评审第 2 轮 REVISE，按评审收敛规则由主会话闭合，不开第 3 轮）

| #   | 残留点                                                         | 处置                                                                                            |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 2/5 | `onServed` 放在 `logStatus` 去重后，仅 assets 变化的重建会被吞 | `onServed` 移到 `refreshFor()`，按 `rootGeneration+assets` 独立去重；补集成测试（§3.6）         |
| 4   | boot≠disk HEAD 仍称「旧于」                                    | 拆为 `hub-disk-changed`（措辞「启动后磁盘代码已变化」）与仅凭 semver 的 `hub-older`（§4、§8.5） |
| 8   | `ui.probe()` 仅有等待超时，可叠加未结束 IO                     | probe 跨请求单飞 + 等待者 ≤8，槽位占到底层 IO 真正 settle；补重复请求测试（§3.9）               |
