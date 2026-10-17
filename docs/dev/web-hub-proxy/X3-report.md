# X3 report — integration (2026-10-17)

依据 `docs/dev/web-hub-proxy/plan.md` v2 + §R1/§R2（T-I1 / §10 / X3），先读取 `X1c-report.md` 的交接。基线包 XA/X0/X1a/X1b/X2/X1c 均已提交；本包**不提交、不修改 `src/`**。

## 改动文件（绝对路径）

- `/home/bluecake/ai/pi-toolkit/tests/integration/web-hub-proxy.test.ts` — 新增 T-I1，真实 hub 子进程、真实 HTTP/TCP/WS、既有 upstream fixture。
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/logic-proxy.test.ts` — 将 token-only 代理契约矩阵改成 token/password 两个独立实现共用，并补充三条端点的错误矩阵和完整请求断言。
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-proxy/acceptance.md` — 用户执行的中文编号真实浏览器清单，明确阻塞/条件阻塞/残余验证与未执行记录规则。
- `/home/bluecake/ai/pi-toolkit/docs/dev/web-hub-proxy/X3-report.md` — 本报告。

**不属于本包的工作区改动：** 开始时工作区干净，实施中观察到 `AGENTS.md` 出现外部修改；已通知主调度，未编辑或回退该文件。§12 要求的 AGENTS web-hub 段落由主调度处理。

## 测试地图

| 需求                   | 文件 / 用例                                          | 真实断言                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-I1 主路径            | `web-hub-proxy.test.ts` 第 1 用例                    | `spawnHub` + `resolveJitiCli` 从 pi dev dependency 定位 bundled jiti，执行真实 `hub/main.ts`，配置从 `PI_WEBHUB_CONFIG.proxy={portRange,maxProxies}` 传入；socket hello_ack 有 `proxy.v1`；open → 未认证 401（零上游请求）→ enter 303 + Location + HttpOnly/Lax gate → HTTP 路径/query/应用 cookie 转发、pwh cookie 被剥离 → WS 101 + **原样字节 echo** → list/policy → stop 200 + 客户端和上游 WS 关闭 + 端口 ECONNREFUSED + 空列表 |
| 一次性 code            | 第 1 用例                                            | 已兑换 code 重放 **410**，不能再兑换（区别于旧 gate cookie 的 401）                                                                                                                                                                                                                                                                                                                                                                  |
| SIGTERM / close 清理   | 第 2 用例，以及各用例正常 terminate                  | 活跃 proxy/WS 时 SIGTERM 真实进程，经过 `installProcessHandlers → close → dispose`；子进程 close 事件 `{code:0,signal:null}`，hub/proxy 端口连接拒绝，上游 WS 关闭；不用 SIGKILL 冒充正常退出                                                                                                                                                                                                                                        |
| 重启持久化             | 第 2 用例                                            | 同 HOME、同配置、同一个 upstream/target，新 child pid；`ports.json` 内容不变，origin/port 相同；旧 gate **401**、未消费旧 code **410**，上游计数不增长；新 enter 恢复 HTTP 和 WS，然后再次干净退出                                                                                                                                                                                                                                   |
| `main.ts` overlap veto | 第 3 用例                                            | 配置 hub port 位于 proxy range 内；hub 仍在该端口正常启动；stderr 精确包含 `dropping config.proxy: portRange overlaps webHub.port (...)`；socket cap 无 `proxy.v1` / `proxy.lan.v1`，三个 `/api/proxy*` 端点全部 404，无 proxy 目录及 hub.json.proxy，范围其余端口连接拒绝                                                                                                                                                           |
| T-U5 password 对齐     | `logic-proxy.test.ts` 参数化 token/password describe | 两个真实 client factory 跑同一矩阵；open POST `{target}`、list GET 无 body、stop POST `{instanceId}`；X-PWH、JSON Content-Type、same-origin credentials、协议成功体、单次请求（无暗中登录/重试）                                                                                                                                                                                                                                     |
| 三条 API 错误          | 同上，每个 mode × open/list/stop                     | denied/public、unavailable/closing、cookie-conflict、E_RATE/Retry-After、401 fallback、HTTP 500/无效 Retry-After；status/reason/retryAfterS 原样保留；malformed 200→E_BAD_RESPONSE、网络→E_NETWORK、pre-abort→E_ABORT 且 fetch 零调用                                                                                                                                                                                                |
| §10 浏览器闸门         | `acceptance.md` 1–17                                 | 设置/重载/重启、HTTP 样例、TopBar/消息链接/弹窗、gate 与 Cookie 边界、浏览器 echo、Vite/Jupyter/NAS、A/B 两组、跨端口 P4/WS、注入及父 Domain/恢复文案、Clear-Site-Data、外链/GET callback、停止/同端口重启/重新进入、登出/passwd/token rotate、iOS LAN、反代/隧道/status/off                                                                                                                                                         |

### Harness 稳定性与清理

- 复用已有 `web-hub-spawn.test.ts` 的生产 launcher 路径；spawn seam **仅**改为可等待的 child、pipe stderr、沙盒 HOME/XDG，不替换 hub/service/auth。
- 使用短路径临时 HOME，避免 Unix socket 路径落入真实用户的 fallback socket。readiness 只接受 **当前 child pid** 的 hub.json，避免重启读到旧记录；loader 缺失明确失败，不静默提前 return 伪通过。
- 端口不是“挑一个 free base 再假定邻居空闲”：从低位非默认 ephemeral 区间随机挑选，**同时绑定检查全部 8 个候选端口**，避开 upstream，持有至 port:0 hub 启动完成，再紧邻 open 释放。仅候选预留阶段的 EADDRINUSE 会重选，不重试失败的行为断言。
- 所有 child 在 spawn 时立即登记；`afterEach` 即使 startup/login/assertion 失败也 TERM，超时才 KILL 并等 close，之后才删除 HOME。所有测试客户端、upstream socket/listener、端口预留也清理，等待有上限。正常退出断言不经过此兜底。
- WS fixture 本身按设计回显原始帧；测试发真实 masked client text frame，并断言完整回传 bytes，而不是仅凭 101/不抛异常判定转发成功。标准浏览器 WS 的协议互操作留给 §10，不能拿该 raw fixture 代替浏览器 echo。

## 自验（实际执行结果）

环境：Node `v22.22.1`，Vitest `v2.1.9`。

```text
timeout 280 npm run typecheck
  PASS — tsc（两套配置）+ vue-tsc，exit 0

timeout 280 npm run build
  PASS — tsc -p tsconfig.build.json，exit 0

timeout 360 bash -c 'for round in 1 2 3; do
  echo "=== T-I1 consecutive round $round/3 ==="
  timeout 100 npx vitest run tests/integration/web-hub-proxy.test.ts || exit $?
done'
  PASS — 连续三轮均 1 file / 3 tests passed
  round 1: 11.82s；round 2: 12.91s；round 3: 11.59s
  此三轮与 typecheck/build、UI 目录测试并行执行

timeout 600 npx vitest run tests/web-hub/ui
  PASS — 184 files / 4432 tests passed，30.33s，exit 0
  包含 logic-proxy.test.ts 的 74 个测试
```

UI 目录有既有 Vue 缺 prop 警告与故意 lazy-import reject 用例的 stderr；Vitest 没有失败/未处理异常。此前开发过程的失败来自测试 harness：忘带 strict-CSRF 所需 Origin，以及把 code 重放误写为 401（契约规定 410）。均修正测试，**没有生产代码修复或发现需要越界修改的 bug**。

收尾检查（四个本包文件逐一列为命令参数）：

```text
timeout 60 npx prettier --write <四个本包文件>
  PASS
timeout 60 npx prettier --check <四个本包文件>
  PASS — All matched files use Prettier code style!
timeout 10 git diff --check -- <四个本包文件>
  PASS — exit 0
timeout 10 git diff --numstat -- src/
  空输出 — 无 src 改动
```

## 残余与交接

1. **真实浏览器闸门未执行，仍阻塞放行。** 本包产物是用户可执行步骤，不宣称 Chrome/Firefox/iOS Safari、Vite/Jupyter/NAS、Cookie 注入、SSO 或真实 LAN 已验收；用户须逐项填写证据。没有相应设备/应用时诚实记未执行。
2. **Cookie 隔离的准确边界：** gate 名按端口独立且服务器绑定 origin/实例，`pwh_*` 不进入上游，A→B WS 的 Origin 必须拒绝；但浏览器普通应用 Cookie **不按 TCP 端口隔离**，同 host 的 `demo` 等 Cookie 可能共享。计划 §4.1 已承认同 host 注入风险，清单刻意不承诺不存在这种共享；测试不能伪断言应用 Cookie 被隔离。
3. 端口 release→child listen 存在 OS 无法原子消除的小窗口（生产接口不接受预绑定 fd）；整段预留、低位端口、紧邻释放及引擎自身跳过忙端口降低竞态，连续 3× 已通过。未对行为失败做重试来掩盖回归。
4. 本包未运行全仓 `npm test`、`build:web/check:web` 或真实浏览器自动化；只增加测试/文档，指定的类型检查、集成 3×、整个 UI 测试目录以及额外 TypeScript build 已跑。全量包级/发布门禁与独立 verifier 留给主调度。
5. `plan.md` 所提 `tests/fixtures/proxy-probe.html` 当前仓库不存在；未擅自增加文件域外 fixture。清单改为给用户可直接运行的 Console 探针与现有 `proxy-upstream.ts` 启动命令，覆盖同一组请求/头行为。
6. 没有 git commit；没有编辑 `src/`、AGENTS.md、CHANGELOG 或其他包文件。
