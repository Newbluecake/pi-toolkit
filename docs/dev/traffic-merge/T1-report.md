# traffic 合并 T1 报告——原样搬迁源码（不接线）

> 依据：`docs/dev/traffic-merge/plan.md`（r3）§0/§1/§3.1/§8.1/§10 T1 行。
> 来源：`/home/bluecake/ai/pi-traffic-record`，HEAD `b17d1f825c4a9b028b82a38ca8f236e41f4106af`（v0.2.1，含加密适配；外部仓库工作区干净、未做任何修改）。
> 提交切分（方案 §10）：`feat(traffic): import pi-traffic-record sources as src/traffic (unwired)`——**本次未 commit**（纪律）。

## 1. 搬迁文件清单（源 → 目标）

### src/traffic/（源码，14 个 TS + app.js + vendor）

| 源（pi-traffic-record）         | 目标（pi-toolkit）                      | 说明                                                                                                                                       |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/capture.ts`                | `src/traffic/capture.ts`                | prettier 重排 + 1 处严格修复（§2.1）                                                                                                       |
| `src/correlate.ts`              | `src/traffic/correlate.ts`              | 仅 prettier 重排                                                                                                                           |
| `src/db.ts`                     | `src/traffic/db.ts`                     | 字节一致（prettier 后无差异）                                                                                                              |
| `src/index.ts`                  | `src/traffic/index.ts`                  | 仅 prettier 重排；未被任何现有代码 import（T3 才装配）                                                                                     |
| `src/jq.ts`                     | `src/traffic/jq.ts`                     | prettier 重排 + 1 处严格修复（§2.4）                                                                                                       |
| `src/page.ts`                   | `src/traffic/page.ts`                   | 字节一致；资源目录解析基于 `import.meta.url`/`__filename` 自定位，随目录迁移自动生效，未改动                                               |
| `src/redact.ts`                 | `src/traffic/redact.ts`                 | 仅 prettier 重排                                                                                                                           |
| `src/rewrite.ts`                | `src/traffic/rewrite.ts`                | 仅 prettier 重排                                                                                                                           |
| `src/secure.ts`                 | `src/traffic/secure.ts`                 | 字节一致                                                                                                                                   |
| `src/serialize.ts`              | `src/traffic/serialize.ts`              | prettier 重排 + 1 处严格修复（§2.3）；**保留**（方案终态 §2.1 不迁，但 T1 需 13 测试全绿，T2a 删除并把 poison/重试用例改写进 ticket.test） |
| `src/server.ts`                 | `src/traffic/server.ts`                 | prettier 重排 + 2 处严格修复（§2.2）                                                                                                       |
| `src/sse.ts`                    | `src/traffic/sse.ts`                    | 字节一致                                                                                                                                   |
| `src/state.ts`                  | `src/traffic/state.ts`                  | 字节一致                                                                                                                                   |
| `src/app.js`                    | `src/traffic/app.js`                    | 仅 prettier 重排（非 vendored，照常格式化）                                                                                                |
| `src/vendor/vue.global.prod.js` | `src/traffic/vendor/vue.global.prod.js` | **字节一致**（sha256 `aae6339a…ca2c`，cmp 验证）                                                                                           |
| —（新增）                       | `src/traffic/vendor/VENDOR.json`        | Vue 锁定：`{name:"vue", version:"3.5.42", file, sha256, source, license:"MIT"}`                                                            |
| —（新增）                       | `src/traffic/vendor/LICENSE`            | Vue MIT 全文（取自本仓库 `node_modules/vue/LICENSE`，Vue 官方 MIT 文本）                                                                   |
| —（新增）                       | `src/traffic/VENDOR.json`               | 源 SHA 溯源：repo/commit（b17d1f8 全 SHA）/version 0.2.1/commit subject/方案指针                                                           |
| —（不迁）                       | —                                       | 源仓库根 `index.ts`（pi 入口薄壳，T3 由 toolkit 自己的装配取代）；`scripts/vendor-check.mjs` 由新脚本取代（下）；docs 迁移归 T7            |

「仅 prettier 重排」的证明：`src/traffic/**` 由「源副本 + `npx prettier --write`」产生，随后仅用编辑工具做过下文 §2 列出的 4 处修改（可逐条核对 diff）。

### tests/traffic/（13 个测试文件，160 例）

| 源                                                                                                                              | 目标                                         | 改动                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/{capture-rewrite,correlate,db,headers,hooks,jq,page,redact,replay,rewrite-api,rewrite,secure,serialize}.test.ts` | `tests/traffic/` 同名                        | ① import 路径 `../x.js` → `../../src/traffic/x.js`（sed，仅 import 语句）；② prettier 重排；③ 下述 2 处文件读取路径调整                                                                                                                |
| —（新增）                                                                                                                       | `tests/traffic/fixtures/source-package.json` | 源仓库 `package.json` 的逐字节快照（cmp 验证一致），供 `secure.test.ts` 的 `piSecure.honors` 契约断言读取（该断言在源仓库读 `../../package.json`，搬到 toolkit 后指向了错误的包；T3 把 `piSecure` 写进本仓库 package.json 后可再指回） |

测试内容断言与源完全一致（除上述路径），符合 §8.1「T1：测试内容不变，全绿（基线对照）」。`jq` 依赖用例的 `skipIf(!existsSync("/usr/bin/jq"))` 原样保留（本机有 `/usr/bin/jq`，实跑生效）。

### 其它

| 目标                                     | 说明                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.prettierignore`（+11 行）              | 新增 3 条：`src/traffic/vendor/vue.global.prod.js`（sha256 锁定的 vendored 构建产物）、`src/traffic/vendor/LICENSE`（licensure 文本逐字节）、`tests/traffic/fixtures/source-package.json`（逐字节快照，先例：`tests/fixtures/quota/` 等）                                    |
| `scripts/traffic/vendor-vue.mjs`（新增） | 方案 §2.1 规定（替代源仓库 `vendor:check`）：默认校验 vendor 文件头版本注释 + sha256 与 `src/traffic/vendor/VENDOR.json` 一致；`--refresh <file>` 从本地 vue.global.prod.js 刷新并更新 VENDOR.json（Vue 不再是依赖树成员，锁定凭据从 package.json devDeps 换成 VENDOR.json） |

vitest 配置**未改**：现有 `include: ["tests/**/*.test.ts"]` 已覆盖 `tests/traffic/**`；happy-dom、jq 已是本仓库现有环境/devDep，零新依赖。

## 2. 严格模式修改逐条（4 个编译错误，全部类型层、行为不变）

本仓库 tsconfig 相对源仓库多 `exactOptionalPropertyTypes`、少 DOM lib（`lib: ["ES2022"]`）：

1. **capture.ts:213 `BodyInit` 不存在**（DOM lib 缺失；Node 的 undici 全局不导出该名字）→ `result.body as BodyInit` 改为 `result.body as NonNullable<RequestInit["body"]>`（`RequestInit` 是已有全局，`options.body` 的赋值目标类型即此）。
2. **server.ts:732 同上 + exactOptionalPropertyTypes**：三元里显式 `undefined` 不能赋给可选属性 `body`。重放 init 改为条件赋键：`const replayInit: RequestInit = { method, headers: sendHeaders }; if (method !== "GET" && method !== "HEAD") replayInit.body = sendBody;`——`sendBody` 类型 `string | Uint8Array` 天然可赋，连 cast 都不再需要；fetch 对「无 body 键」与「显式 undefined」行为一致（runtime 逐字节等价的请求）。
3. **serialize.ts:212 `releaseReason: undefined` 赋给 `releaseReason?: ReleaseReason`** → 接口声明放宽为 `releaseReason?: ReleaseReason | undefined`（对象字面量仍显式赋 `undefined`，运行时不变）。
4. **server.ts:85 `jqPath: string | undefined` 传给 `jqPath?: string`** → `jq.ts` 的 `JqRunOptions.jqPath` 放宽为 `string | undefined`（`runJq` 内部本就按「缺省 = undefined」处理，运行时不变）。

另注：prettier 自身做过的唯一「看似语义」重写是 server.ts 中 `({...} as BodyInput)` → `({...}) as BodyInput`（cast 位置规范化，AST 等价）与三元链的强制括号/缩进，均无行为差异。

## 3. 测试输出

```
$ npx vitest run tests/traffic --maxWorkers=2
 Test Files  13 passed (13)
      Tests  160 passed (160)
      Start at  14:21:43   Duration  3.29s
```

（迁移过程中修复过两个环境耦合失败：`page.test.ts` 读 `../app.js` 的相对路径 ENOENT；`secure.test.ts` 读 `../../package.json` 指到 toolkit 的 package.json 导致 `piSecure` 断言失败——分别改为 `../../src/traffic/app.js` 与 `fixtures/source-package.json` 快照，见 §1。）

## 4. 自验结果（全部通过）

| 命令                                                                           | 结果                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/traffic --maxWorkers=2`                                  | 13 文件 / 160 例全绿（§3）                                                                                                                                                                                                              |
| `npm run typecheck`（= tsc tsconfig.json + tsconfig.typecheck.json + vue-tsc） | 通过（0 错误）                                                                                                                                                                                                                          |
| `npx tsc --noEmit -p tsconfig.build.json`                                      | 通过（dist 构建配置同样覆盖 `src/traffic/**`）                                                                                                                                                                                          |
| `npx prettier --check src/traffic tests/traffic scripts/traffic`               | All matched files use Prettier code style!                                                                                                                                                                                              |
| `npx prettier --check … .prettierignore`                                       | 任务原样命令在 `.prettierignore` 上报 `No parser could be inferred`——这是 prettier 对无扩展名点文件的固有行为（CI 的 `prettier --check .` 默认跳过点文件，故仓库门从未覆盖它）；`.prettierignore` 的改动为本报告 §1 所列 +11 行注释条目 |
| `git grep -n "traffic/" -- src ':!src/traffic'`                                | 空（exit 1）——`src/traffic` 未被任何现有代码 import，未接线                                                                                                                                                                             |
| `node scripts/traffic/vendor-vue.mjs`                                          | `vendor-vue OK — vue@3.5.42 sha256=aae6339a… 一致`                                                                                                                                                                                      |
| `cmp` 源↔目标的 `vue.global.prod.js`、`package.json`→fixture                   | 字节一致                                                                                                                                                                                                                                |

## 5. 遗留 / 移交

- **未接线确认**：`src/index.ts`、settings、package.json 依赖、command-policy、HUD 均未动（工作区里 package.json/src/stack.ts 等的波动来自并行的 secure P2 在途工作，非本任务足迹；本任务足迹仅为 §1 所列文件）。`serialize.ts` 按基线保留，T2a 删除。
- **node:sqlite 顶层加载**（`db.ts` 模块顶层 `createRequire`）原样保留——测试通过注入路径/`resetState` 跑通；惰性化与 `loadSqlite()` 归 T2a（方案 §3.1），`ExperimentalWarning` 在测试输出可见属预期。
- `scripts/traffic/node-floor-smoke.mjs` 归 T7（方案 §10），本包不做。
- 绑定地址/鉴权加固（`0.0.0.0` + 免 token 回环）原样保留，T4 加固——**在 T3 接线前 `src/traffic` 不可达，无暴露面**。
