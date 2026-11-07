# #54 P3：traffic.db 跟随 agentDir（§3.5 全部）

## 交付范围

依据 `plan.md` r3（含文末拍板与 r2/r3 修订）实施 §6.2 **P3 traffic**：§3.5 全部 + T-TR1 / T-ID1 traffic 部分。未进行任何仓库 git 写操作；未触碰 `tests/fixtures/`；未打印数据库内容（测试只 stat/断言行文本，不读库内容输出）。secure 域 D8 强制关闭面未动（`wireTraffic`/`assembleTrafficHost` 的 `isSecure()` 前置不变，本次改动不新增任何重开路径）。

## 实现要点

- **`src/traffic/db.ts`**：`defaultRecordPaths(home?)` 改为 `defaultRecordPaths(opts?: { home, env, externalRecorder, exists })`，返回 `{ root, source, recordDir, dbPath, legacyDir, legacyDbPath }`。根目录五分支严格按 §3.5：`default`（未设/空串/默认等价，**短路、零 fs 探测**，逐字节等于旧字面公式）→ `external-recorder`（钉 H）→ `has(P)` ⇒ `agentDir` → `has(H)` ⇒ `inherited` → 都没有 ⇒ `agentDir`（新建在 P）。`has(r)` 把 `dumps/` 也算进来，保证 legacy 检测与库在同一个根上成对判定。复用 P0 的 `resolveAgentDir`（pi-free）。不复制、不移动。
- **`src/traffic/engine.ts`**：`CreateEngineOptions` 新增 `recordPaths?: RecordPaths`；`defaults = opts.recordPaths ?? defaultRecordPaths()`，legacy 检测条件 `dbPath === defaults.dbPath` 改为与**传入的** defaults 比较（评审 #4 iii）。wireTraffic 总是传入，engine 不再自己选根；测试直调保留回落。
- **`src/traffic/index.ts`**：
  - `WireTrafficOptions` 新增 `externalRecorder?: boolean`；`assembleTrafficHost` 传 `dupFindings.length > 0`（外部 recorder 仍装着 ⇒ 钉 H，与其同库，认领协议照旧）。
  - host 命令闭包内惰性记忆 `recordPaths()`（首次显式 DB 访问才算；未设变量时零探测；每装配一份闭包，无模块级状态，I4）。
  - `recordOn` 把 `recordPaths` 传给 `acquireEngine`；`recordStatus` 无 engine 时 `openDb` 显式传 `legacyDbPath`（选中根成对；注入 dbPath 时不检测，与旧行为一致）。
  - `数据库:` 行（on 与 status 两处）在 `source !== "default"` 时追加 `（agentDir）` / `（继承 ~/.pi/agent）` / `（外部 recorder 共用 ~/.pi/agent）`；默认与注入 dbPath 时无后缀（输出逐字节不变，I9）。
- 未设变量时整条链路零新增 fs 探测、零新增注册；`traffic.enabled` 关闭时 `wireTraffic` 照旧立即返回。

## 测试

- **新增 `tests/traffic/root-select.test.ts`**（T-TR1 + T-ID1 traffic）：
  - 五分支纯函数表（注入 `home`/`env`/`exists`，含「P 与 H 都有库 ⇒ P 优先」用例，已做变异验证：/tmp 副本交换 has(P)/has(H) 后该用例如期失败）；default 分支用「探测即抛」的 `exists` 证明零 fs 访问；`toEqual` 钉住完整字面公式（root/source/recordDir/dbPath/legacyDir/legacyDbPath）。
  - 真实 fs 沙箱：P 下只有 `dumps/` 旧库 ⇒ 选 P 且 engine 的 `legacyDbPath` 指向 P/dumps、拒绝打开（E_LEGACY_UNMIGRATED，发生在加载 node:sqlite 之前）、不建 records/ 不碰 H；P 空 H 有 dumps ⇒ inherited 且 legacy 指向 H/dumps。
  - `/record status` 后缀端到端（沙箱 HOME + 真 sqlite）：默认无后缀（逐字节）；inherited / agentDir / external-recorder 三种后缀按行断言；注入 dbPath 无后缀；status 保持短连接不建容器。
- **`tests/traffic/db-path.test.ts`**：标题/注释改为 inherited 语义（plan 要求）；补 root/source 断言与继承后缀断言；原有用例语义不变继续通过。
- **`tests/traffic/legacy-dir.test.ts`**：仅更新文件头注释（行为不变）。
- **`tests/config/agent-dir-identity.test.ts`**（T-ID1 traffic 部分，方案分派给 P3）：`defaultRecordPaths(sandbox.home)` 改 opts 调用并补 `root`/`source`；「P3 is not part of P0」占位用例改为新语义（空 P ⇒ agentDir 根）。
  - 另修一处**非 P3 造成**的断言：`agentDir: hubAgentDir` 出现次数 6 → 7（并行包 P4 在 hub.ts 写 hub.json 时新增的消费点，已核实 diff；注释注明）。
- 未新增 T-ID2/T-ID3（属 P1）；hub 侧 T-HB1 属 P4。

## 自验

| 项目     | 命令                                                                                                                                                              | 结果                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 类型     | `npm run typecheck`                                                                                                                                               | PASS（改动后复跑）       |
| 定向套件 | `npx vitest run tests/traffic tests/conformance/traffic.test.ts tests/conformance/traffic-coexist.test.ts tests/config/agent-dir-identity.test.ts --maxWorkers=3` | PASS：35 文件 / 427 测试 |
| Prettier | `npx prettier --write <P3 文件>`                                                                                                                                  | PASS（全部 unchanged）   |
| 冻结物   | `git diff --quiet HEAD -- tests/fixtures/`                                                                                                                        | PASS（无差异）           |
| 差异空白 | `git diff --check`                                                                                                                                                | PASS                     |

首次定向跑唯一失败是 agent-dir-identity 的 hub 结构断言（6 vs 7），确认为并行 P4 的 hub.ts 改动所致，已按上述修订并复跑全绿。

## 遗留问题

- `src/traffic/state.ts:4` 头注释已随本次补测同步为新规则。
- `createTrafficEngine` 在未传 `recordPaths` 时仍回落调用 `defaultRecordPaths()`（兼容测试直调），与方案「不再自己调用」的字面差异：生产路径（wireTraffic）恒传入，回落只服务测试。
- 工作区混有并行包 P2/P4 的改动；本报告只覆盖 P3 文件域 + `tests/config/agent-dir-identity.test.ts` 的 T-ID1 traffic 行与 hub 计数断言。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/src/traffic/db.ts`
- `/home/bluecake/ai/pi-toolkit/src/traffic/engine.ts`
- `/home/bluecake/ai/pi-toolkit/src/traffic/state.ts`（头注释一行改为新规则）
- `/home/bluecake/ai/pi-toolkit/src/traffic/index.ts`
- `/home/bluecake/ai/pi-toolkit/tests/traffic/db-path.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/traffic/legacy-dir.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/traffic/root-select.test.ts`（新）
- `/home/bluecake/ai/pi-toolkit/tests/config/agent-dir-identity.test.ts`（T-ID1 traffic 行 + P4 引起的 hub 计数断言）
- `/home/bluecake/ai/pi-toolkit/docs/dev/traffic-merge/README.md`（拍板 1b 修订标注）
- `/home/bluecake/ai/pi-toolkit/docs/dev/settings-rename/P3-report.md`（本报告）

建议 commit message（仅建议，未提交）：

```text
feat(traffic): follow PI_CODING_AGENT_DIR for traffic.db with inherited fallback

traffic-merge 拍板 1b 由 #54 修订：默认库根按 §3.5 选择（P 有库 ⇒ P；否则 H
有库 ⇒ 继承 H；外部 recorder 仍装着 ⇒ 钉 H 同库；都没有 ⇒ P），未设变量时
逐字节等于旧固定公式且零 fs 探测。legacy dumps/ 检测改在选中的根上成对判定，
/record status 数据库行在非默认根时追加来源后缀。不复制、不移动库文件。
```
