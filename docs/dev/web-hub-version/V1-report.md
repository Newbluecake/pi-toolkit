# V1 (hub backend) 交付报告 — web-hub-version

## 改动文件（均在 /home/bluecake/ai/pi-toolkit）

源码

- `src/web-hub/protocol/paths.ts` — 追加 `packageRootDir()`
- `src/web-hub/hub/changelog.ts`（新）— `parseChangelogSections`
- `src/web-hub/hub/version-git.ts`（新）— 冻结 argv（`versionGitArgs`/`VERSION_GIT_PREFIX`）、`gitHead`/`gitCommits`
- `src/web-hub/hub/version-info.ts`（新）— `readBounded`、`createVersionInfoService`、`fitBody`
- `src/web-hub/hub/static.ts` — `refreshFor()`、`UiServer.probe()`（跨请求单飞，`PROBE_WAITERS=8`，E_BUSY 以 `Error("E_BUSY")` 拒绝）、`onServed`（`rootGeneration+assets` 独立去重，在 `logStatus` 之外）、`assetsOf()`
- `src/web-hub/hub/hub.ts` — `VERSION_HUB_CAP` 进 `extraHubCaps`（两个 cap 面同源）、构造/dispose service、`onUiServed`→`info.ui`+一次 `hub` 广播、`captureBootHead()`、fallback `ui` stub 补 `probe`
- `src/web-hub/hub/registry.ts` — `card().buildId`
- `src/web-hub/hub/http.ts` — loopback + LAN 的 `GET /api/version`（`serveVersionInfo`），`onUiServed`→`onServed` 透传
  测试
- 新：`tests/web-hub/hub/{changelog,version-git,version-info,hub-version}.test.ts`、`tests/web-hub/http/{api-version,lan-version}.test.ts`、`tests/integration/web-hub-version.test.ts`
- 改：`tests/web-hub/hub/{hub-lan,hub-preview,registry}.test.ts`（caps 基线加 `VERSION_HUB_CAP`；buildId 用例）、`tests/web-hub/http/lan-helpers.ts`（`version`/`ui` 选项）

## 偏离 / 实现决定（plan 未明确处）

1. `probe()` 的 E_BUSY 以 `Error("E_BUSY")` 拒绝（接口类型 `Promise<UiStatus>` 不变）；http 层将 probe 的 E_BUSY 映射 503，probe 仅超时则忽略（快照照常返回，只是 `HubInfo.ui` 可能滞后）。
2. LAN 路由字段命名 `LanRuntime.versionInfo`（`version` 已被占用）。
3. service：round 结果已出但 IO 槽仍被占且缓存已过期 ⇒ 新请求 `E_BUSY`（不叠加 IO）。
4. 无 tag 时 commits 范围为 `HEAD`（plan 只写了 `<tag>..HEAD`）；`rev-parse` 退出 128/spawnError ⇒ `repo` 缺省（nogit 安装）。
5. 限速：`admit(bucket,3,1000)` 同 `/api/load/top`；LAN 认证预算 `deriveBudget(8000, LAN_AUTH_CAP_MS, 4000)`。
6. `VERSION_HUB_CAP` 放在 `extraHubCaps` 首位（因此在 caps 基线里紧随 TODO_ARCHIVE，位于 preview 等条件 cap 之前）。
7. 未改任何 V0 文件。

## 自验

- `npx prettier --write`：已对全部改动文件执行。
- `npm run typecheck`：我的文件无错误；唯一错误来自 V2 正在编辑的 `src/web-hub/ui/src/components/shell/VersionPanel.vue(177,69): TS18048 'repo.value.commits' is possibly 'undefined'`（V2 域）。
- `npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/protocol tests/integration/web-hub-version*.test.ts tests/web-hub/boundary.test.ts`：
  `Test Files 1 failed | 205 passed (206); Tests 1 failed | 3977 passed | 3 skipped`
  唯一失败 `api-upload.test.ts (c')`（startHub recover 审计行）是**既有的间歇性用例**：单跑 2 次一过一败，失败断言是读 hub.log 时审计行尚未落盘，与版本功能无关（V1 TDZ 修复前后均出现过同一现象之外的其他失败已全部消除）。未做基线对照（禁止 stash）。
- 已覆盖：argv 逐字节钉住；129 ⇒ git-too-old 且仅 1 次调用；partial clone（promisor 指向本地陷阱端口，连接数 0）；单飞 ≤8 waiters/第 9 个 E_BUSY；断连只摘自己；FIFO 替换不阻塞；fs 迟到完成期间占槽；bootHead 仅一次/失败静默；泄露深扫（pkgRoot/home/tmpdir/stderr/候选目录/`candidates|reason|detail`）；403/401/200/429/503/504 与缺省矩阵（loopback 401/404，LAN 404）；仅 assets 变化的重建 ⇒ onServed 恰好一次且 onStatus 不触发；commit 变化 ⇒ 各一次；probe 悬挂时重复请求不叠加 IO；`/api/version` 驱动的真 HTTP 重部署。
