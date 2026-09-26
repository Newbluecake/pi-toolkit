# web-hub 局域网访问 —— 实施方案（lan-plan v8，HTTP + 受信任反向代理）

> 输入：`lan-requirements.md`（L1–L24）。L23 使 hub 只做 HTTP；**L24**（v5 复审 #3 后的用户决策）：HTTPS 由本机 / 局域网反向代理终止，本期支持 `trustProxyFrom` + 对外 https 地址（外部 origin），Origin/CSRF 按外部地址校验，限流按受信任链之后的客户端 IP；未配置时同 v5（直连 HTTP）；L24 推翻 L23b。其余决策（L2–L8、L11、L13 的「一并验收」口径、L16、L17、L19、L21、L22、L23a）不变。v4 的 TLS/CA 设计整体存档（§14）。
> 评审（gpt-sol）七轮意见的处置见 §15；v7 复审只剩 6 条冻结接口 / 生命周期不一致，处置为 §15.7。**用户决定：v8 之后不再做文档复审**——W1 接口包把全部冻结接口写成代码（类型 + 桩 + 契约测试），由评审员审代码、typecheck 兜底，通过后并行施工（§11）。
> 代码坐标以 `3b3af74` 为准。保留的本机实测：① `node:sqlite` 预建 0600 的 db 后开 WAL，`-wal`/`-shm` 继承 0600，垃圾文件报 `errcode 26`；② worker_threads 卡在 SQLite 原生调用里时 `terminate()` 与 `process.exit()` 都要等约 60s ⇒ 所有 SQLite 访问放进可以 SIGKILL 的**子进程**（L19，§4）；③ scrypt(N=2^15, r=8) ≈ 100ms、32 MiB；④ 本机 hostname 是纯数字 `202507220006`，Chromium 的 URL 解析器把纯数字单标签当作数值型 IPv4、在请求到达服务器之前就拒绝导航（`lan-spike-results.md` §5），`<h>.local` 形式不受影响。

**v8 相对 v7 的变化**（详见 §15.7；只修 6 条接口 / 生命周期不一致 + W1 定义）：① `FenceLoss` 纳入 `"io"`，`fenceLossOf(err)` 映射表；② 启动取消链：`startup: AbortController` 贯穿 `acquireSingleton` / `frontend.listen` / fs 操作，迟到结果自我清理，测试「延迟 resolve 后仍可再次 acquire」；③ 无效 LAN 配置经 `StartHubDeps.lanConfigError` 显式传入，`HubJsonWriter` 是 hub.json 的唯一写入路径；④ `rootScope` 的创建者与 close 顺序、`defaultLanAssembly` 的导入位置、§1.4.2 片段中所有标识符都有定义；⑤ SSE `auth` 事件的 `SSE_EVENTS` / `web/contract.js` / `SseAuthPayload` / 镜像测试纳入 W1；⑥ crash 的 `STEP_DEADLINE_MS = 3s` 保持为 crash 专用硬退出并写入验收；⑦ §11 的 W1 重定义为**接口包**（类型 / 完整实现 / 桩三张清单 + typecheck + 契约测试 ①–⑪），W1 通过前其它包不得开工；LP 的硬化行为移到 W2 与其它包并行。

## 0. 总览与合入策略

| 阶段                   | 内容                                                                                                                                                                                                                                                                                 | 合入                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **S1-W1 接口包（IF）** | §1.3 / §1.4 / §3.1 冻结的全部接口写成代码：类型、纯函数完整实现、抛 `E_NOT_IMPLEMENTED:<包>` 的桩、契约测试 ①–⑪、`npm run typecheck`（§11）。**W1 通过前其它包不得开工**                                                                                                             | 进特性分支 `feat/web-hub-lan`；评审员审代码而不是文档                   |
| **S1 LAN over HTTP**   | 组合契约（§1.4）、SQLite 子进程、KDF 池、用户 / 初始密码 / 会话、限流与连接上限、Host 白名单（含 extraHosts）+ 受信任代理（L24）+ Origin 校验 + 会话 origin 绑定、SSE 撤销、IPC 准入、管理帧 + 审计、`/webhub passwd\|restart\|unlock`、登录表单、`0.0.0.0:<lan.port>` HTTP listener | 按 §12 验收通过后合入 master（L13 的「S1 不单独合入」随 S2 消失而作废） |
| （将来）hub 内 HTTPS   | 由外部反向代理终止（L24）。hub 侧只保留 `LanTransport` 插槽（§2.3），v4 的 CA/leaf/spike 设计见 §14 存档                                                                                                                                                                             | 不排期                                                                  |

波次：S1 = **W1 IF（接口包，串行，代码评审 + typecheck 门槛）** → W2 LP ∥ LS ∥ LC ∥ LE ∥ LF → W3 LD ∥ LI。W2 各包只填实 W1 的桩、不改签名（要改 ⇒ 回到 W1 文件重过 typecheck + 契约测试）。每个包都要四件套全绿。任何阶段、任何失败都是 fail-closed：不监听局域网，loopback 照常。LP（P1 硬化行为）从 v7 的 S0 移到 W2：它依赖 W1 落地的 `DirPolicy` / `verifyBoundSocket` 签名，因此**不再单独先合入 master**（§16 Q-2 更新）。

不变量：LAN 关闭（`HubConfig.lan === undefined`）⇒ 网络面与认证面和 P1 一致（不打开 db、不启动子进程、不启动第二个 listener、`FrontendDeps.lan` 与 `HttpFrontend.lan` 都是 `undefined`）。`hub.json` 增加身份字段（`procStartTicks`、`argv`）与 `lan`；hello_ack 在 hub 装配了管理端口时带 `caps`。全部是向后兼容的新增。

---

## 1. 威胁模型、决策、P1 硬化与组合契约

### 1.1 威胁模型与信任边界（L11、L23a、L24）

| 主体                                                                   | 信任                 | 保护来源 / 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **同 uid 进程**                                                        | 完全可信             | 它们本来就能读 0600 的 `hub.db`、`token`，也能 ptrace hub。管理帧（info/passwd/unlock/shutdown）经现有 socket，**不做额外鉴权**；每个操作写审计日志（§8.3），用于事后追溯而不是防护                                                                                                                                                                                                                                                                                                                                                             |
| 其它本机 uid                                                           | 不可信               | 状态目录 0700（属主校验）、`hub.sock` 0600、`/tmp` 回落目录与 socket 的硬化（§1.3）、db/log 0600。这是对它们**唯一**的防线；其它 uid 只能像局域网客户端一样访问 LAN 端口                                                                                                                                                                                                                                                                                                                                                                        |
| **受信任反向代理**（`trustProxyFrom` 中的对端，L24）                   | 可信其转发头         | 只有 TCP 对端地址 ∈ `trustProxyFrom` 时才解析转发头，且解析是**收紧的**（§2.4）：`X-Forwarded-Proto` 必须是 `https`（否则 400）、`X-Forwarded-Host` canonical 后必须 ∈ `externalOrigins` 的主机（否则 421）、`X-Forwarded-For` 只取链上第一个不受信任的合法 IPv4。**受信任代理失陷 = 该代理入口的所有会话完全失陷**：失陷的代理能伪造任意客户端 IP（绕过每 IP 限流）、看到并重放经它转发的密码与 cookie、篡改页面；hub 无法区分。这是 L24 把代理列为可信的固有代价，写进 status 提示与 §13；直连入口的会话不受影响（`bound_origin` 不同，§6.4） |
| 代理后面的客户端                                                       | 不可信               | 与直连客户端相同的认证、限流（按解析后的客户端 IP）、每客户端 IP 的进行中请求配额；连接层受代理聚合池约束（§6.3），一个恶意客户端最多耗尽代理池、不影响直连用户                                                                                                                                                                                                                                                                                                                                                                                 |
| 局域网上的**主动**攻击者（猜密码、伪造 Host / 转发头、跨站请求、洪泛） | 不可信               | 用户名密码 + scrypt + 每 IP / 全局限流 + 公平调度 + 连接上限与确定性淘汰 + canonical Host 白名单 + 外部 origin 校验 + 会话 origin 绑定 + IPC 准入；来自非受信任对端的 `X-Forwarded-*` **整体忽略**                                                                                                                                                                                                                                                                                                                                              |
| 局域网上的**被动 / 链路层**攻击者（嗅探、ARP 欺骗、恶意 AP、端口镜像） | **超出范围（L23a）** | 直连 HTTP 明文：用户名、密码、会话 cookie、页面内容都能被同网段读取并**重放**；hub 侧只做告知（status `lan=on` 行与登录页各标一行「HTTP 明文」）。经受信任代理走 https 的路径由代理加密，hub 与代理之间的一跳仍是明文（代理在本机时不出网卡）                                                                                                                                                                                                                                                                                                   |
| root / 物理访问                                                        | 超出范围             | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`/webhub restart` 的 `/proc` 身份校验保留，定位是**安全性（safety）**——防止 PID 复用时误杀无关进程——而不是安全防护（§8.2）。

### 1.2 决策表（v7 版本）

| #   | 问题                             | 决策                                                                                                                                                                                                                                                                                                                                                                                                                           | 依据                               |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Q1  | 传输                             | hub 只做 **HTTP**；不生成、不加载证书；不发 HSTS。HTTPS 由受信任反向代理终止（L24）                                                                                                                                                                                                                                                                                                                                            | L23、L24                           |
| Q2  | listener                         | 两个：P1 的 `127.0.0.1:<port>`（`kind:"loopback"`）不变 + `0.0.0.0:<lan.port>`（`kind:"lan"`）；共用静态资源、SSE 与 API 代码；每个请求带 `RequestContext`（§1.4）                                                                                                                                                                                                                                                             | L3                                 |
| Q3  | authMode 来源                    | 由 **listener** 决定：LAN listener 发出的 `index.html` 带 `<html data-auth-mode="password">`，loopback 的带 `"token"`；前端只读这个属性，缺失或非法 ⇒ 显示错误、不发任何凭据；`/healthz.authMode` 只用于诊断                                                                                                                                                                                                                   | 评审 #2                            |
| Q4  | Host 规范化                      | 每个请求先算 `canonicalHostKey`（小写、显式端口，默认端口按 scheme 补齐）与 `canonicalOrigin`（浏览器形式：默认端口省略）；白名单、Origin 比较、会话绑定只用 canonical 值（§2.2）                                                                                                                                                                                                                                              | 评审 #7                            |
| Q5  | Host 白名单                      | 直连：`canonicalHostKey ∈ HostSnapshot.hostKeys`（接口 IPv4 + `localhost` + 系统主机名 + `<h>.local` + extraHosts）；经受信任代理：`externalOrigin ∈ externalOrigins`（配置）；60s tick + 421 触发的节流重算，原子 swap；每个请求只读一次快照（§2.3）                                                                                                                                                                          | L8、L16、L24                       |
| Q6  | 受信任代理                       | `trustProxyFrom`（IPv4 字面量列表）+ `externalOrigins`（**只允许 `https://` origin**；配置 `http://` ⇒ settings 丢弃并 warning、env ⇒ `bad-config`）；二者同时非空或同时为空；只在 TCP 对端 ∈ `trustProxyFrom` 时解析转发头：XFP ≠ `https` ⇒ 400；XFH（缺失时用 Host）canonical（补 443）后 `https://<hostKey>` 必须 ∈ `externalOrigins` ⇒ 否则 421；XFF 从右往左第一个不在 `trustProxyFrom` 中的合法 IPv4，否则用对端（§2.4） | L24、评审 v6 #4/#5                 |
| Q7  | 认证                             | LAN 只收用户名密码，loopback 只收 token；两套会话存储完全隔离                                                                                                                                                                                                                                                                                                                                                                  | L2、v1                             |
| Q8  | 会话                             | 12h 滑动 / 7 天上限，存 SQLite，hub 重启后保留；改密码 ⇒ epoch+1 并删除全部会话；**无主线程缓存**，每个需要会话的请求查一次 db（§4.2）                                                                                                                                                                                                                                                                                         | L7、L19、评审 v4 #3                |
| Q9  | 会话绑定                         | `bound_origin = canonicalOrigin`（如 `http://192.168.31.25:7879`、`https://hub.example.com`）；每个请求校验相等，不匹配 ⇒ 401 且**不**删除会话                                                                                                                                                                                                                                                                                 | 评审 v4 #7、v5 #7                  |
| Q10 | cookie                           | `pwh_lan; HttpOnly; SameSite=Strict; Path=/`；`ctx.externalOrigin` 为 https 时追加 `Secure`（同名 cookie，属性按请求决定）                                                                                                                                                                                                                                                                                                     | 评审 #3                            |
| Q11 | SSE 撤销                         | SSE 客户端绑定 `{sidHash, userId, epoch, boundOrigin}`；登出 / 改密在 db 提交成功后、返回响应前**同步** `revoke`（停 publish → `auth{revoked}` → end）；**55s tick** 用 IPC 在途上限之外的 **1 个保留槽**逐条复核（不会被交互请求饿死），失效 ⇒ `auth{expired}`。用户可见：**到期后页面最多再显示 ≤ 60s**（55s + 2s deadline + 抖动；Q-5 已接受）（§4.2）                                                                      | 评审 v5 #4、v6 #3                  |
| Q12 | IPC 准入                         | `db-client`：在途 ≤ 64、排队 ≤ 128、排队 + 执行 deadline 2s；同 sidHash 的 touch 合并为一个在途 IPC 且挂起的响应 ≤ 8；每客户端 IP 进行中的需会话请求 ≤ 16；SSE 上限（全局 32 / 每会话 8）先于 IPC 检查；tick 复核走低优先级通道（在途 < 32 时才做、并发 2）；静态与 `/healthz` 从不 IPC（§4.2）                                                                                                                                | 评审 #5                            |
| Q13 | 存储                             | `hub.db` 由 hub 独占；**主线程完全不打开 `DatabaseSync`**；所有读写走子进程，每个请求都有 deadline，子进程可 SIGKILL；有大小上限                                                                                                                                                                                                                                                                                               | L5、L19                            |
| Q14 | 初始密码                         | db 中没有用户时由 hub 生成；明文仅保存到改密为止；**只提醒、不过期**                                                                                                                                                                                                                                                                                                                                                           | L6、L17                            |
| Q15 | restart / 管理面                 | 首选 `hub_ctl shutdown`；挂死时 Linux 身份校验 + SIGTERM；旧 hub 拒绝并提示手动 kill；同 uid 完全可信，管理操作写审计                                                                                                                                                                                                                                                                                                          | L4、L11、L14                       |
| Q16 | extraHosts / numeric / localhost | 同一个 `classifyHostToken`（§2.1）作用于 settings 解析与 env 解析；拒绝原因 `HostTokenRejectReason` 贯穿 settings / env / `HostSnapshot.omitted` / status；纯数字主机名不进白名单；`localhost` **不在**小名单中，由分类优先级中的专用分支先于小名单命中（§2.1）                                                                                                                                                                | L16、spike §5、评审 v5 #8、v6 #6   |
| Q17 | 连接淘汰                         | 两个池（直连 / 代理）+ 受保护类别 `login-pending`/`authed` + 单调 `seq` 的两级确定性规则（§6.3）                                                                                                                                                                                                                                                                                                                               | 评审 v4 #2、v5 #3                  |
| Q18 | 污点表饱和                       | `TAINT_CAP = 4096`；满了不回收，未见过地址 429 直到 TTL 过期或 `unlock`；上界 `4·min(A, 4096) + 16s`（§6.2）                                                                                                                                                                                                                                                                                                                   | 评审 v4 #6、L21                    |
| Q19 | P1 目录 / socket                 | W1 落地签名（`DirPolicy` 三常量、`SocketIdentity`、异步 `ensurePrivateDir`、`verifyBoundSocket` 桩、`SingletonResult.owner.identity`、`startFence(…, identity, onLost(why))`、`RunningHub.identity`），W2 的 LP 填实策略强制与 symlink / 属主 / sticky 校验（§1.3）；不回落候选；既有测试按 §1.3.4 在 W1 同步修改                                                                                                              | 评审 v4 #4、v5 #6、v6 #1/#2、v7 #1 |
| Q20 | db 子进程反复失败                | 10 分钟内第 4 次 ⇒ `off/db-unavailable`，手动 `/webhub restart`                                                                                                                                                                                                                                                                                                                                                                | L22                                |
| Q21 | 启动 / 关闭整体上限              | `HUB_START_DEADLINE_MS = 20s`（一个 `AbortController` 贯穿目录检查、singleton、lanAssembly、loopback listen、hub.json；迟到结果自我清理）、`LAN_START_DEADLINE_MS = 30s`、fence 单次 5s（连续 3 次 `io` ⇒ `onLost("io")`）、`HUB_CLOSE_DEADLINE_MS = 10s`；crash 路径保持 `STEP_DEADLINE_MS = 3s` 硬退出；hub 主线程无同步 fs（§3.1）                                                                                          | 评审 v6 #7、v7 #1/#2/#6            |
| Q22 | P1 测试策略                      | **放弃「一行不改」**：LP 允许修改既有测试 / fixtures 的形态（异步化、新增字段、`inode` → `identity`），每处列在 §1.3.4，不得删除用例或放宽 mode / 次数 / 文案断言                                                                                                                                                                                                                                                              | 评审 v6 #1（主会话拍板）           |
| Q23 | 无效 LAN 配置的传递              | `main.ts` 的 `parseHubLanConfig` 失败 ⇒ **不**设置 `config.lan`，改为 `startHub(config, frontend, { lanConfigError: { detail } })`；hub 正常启动 loopback，`hub.json.lan = { state:"off", reason:"bad-config", detail }` 经唯一的 `HubJsonWriter.write` 写入；`RunningHub.lan === undefined`、`RunningHub.lanStatus()` 返回该状态（§1.4.2、§1.4.3）                                                                            | 评审 v7 #3                         |
| Q24 | 文档复审终止                     | v8 为最后一版方案文档；W1 接口包（§11）把冻结接口写成代码并由评审员审代码；之后的分歧以代码 + typecheck + 契约测试为准，方案文档只在 §15 追加「实施偏差」记录                                                                                                                                                                                                                                                                  | 用户决定                           |

### 1.3 本机其它 uid 的防线：目录与 socket 硬化（签名在 W1 落地，行为由 W2 的 LP 填实；评审 v4 #4、v5 #6、v6 #1/#2/#7）

现状（P1）的缺口：`src/web-hub/protocol/paths.ts:58-75` `ensurePrivateDir(dir)` 用 `statSync` 跟随 symlink、`mkdirSync({recursive:true})` 后 `chmodSync` 也跟随；`src/web-hub/hub/singleton.ts:75-78` 对 `stateDir` 与 socket 目录用同一套宽松逻辑；`singleton.ts:125-137` 在 `listen` 之后才 `chmod 0600` 并用 `statSync().ino` 取 inode；`startFence(socketPath, inode, …)` 只比较 `stat().ino`；`release()` 用 `statSync().ino === inode` 判断「还是我们的」。其它 uid 可以在 sticky 的 `/tmp` 中预置 `/tmp/pi-webhub-<uid>` 为 symlink 并在检查与 bind 之间改指向。同 uid 完全可信（L11），以下只针对其它 uid。**所有 hub 侧文件系统调用改为 `fs.promises`**（评审 v6 #7）：主线程上不再有任何同步 fs（P1 遗留的 `log.ts` `appendFileSync` 与 `hub.ts` `writeHubJson` 的同步写不在本包范围，记入 §13 残余）。

#### 1.3.1 新签名（`protocol/paths.ts`，LP 冻结）

```ts
export interface DirPolicy {
  readonly create: boolean; // false ⇒ 只检查（$XDG_RUNTIME_DIR 不是我们的目录）
  readonly recursive: boolean; // mkdir -p（只对 stateDir）
  readonly allowOwnedSymlink: boolean; // 目录本身是 symlink：链接属主为当前 uid ⇒ realpath 后检查目标；否则拒绝
  readonly repairMode: boolean; // 属主是自己但模式宽于 0700 ⇒ chmod + warn；false ⇒ 拒绝
  readonly parentMustBeSticky: boolean; // /tmp 回落：realpath(parent) 必须是目录且 (mode & 0o1000) !== 0
}
export const STATE_DIR_POLICY: DirPolicy; // {create:true, recursive:true, allowOwnedSymlink:true, repairMode:true, parentMustBeSticky:false}
export const XDG_SOCKET_DIR_POLICY: DirPolicy; // {create:false, recursive:false, allowOwnedSymlink:false, repairMode:false, parentMustBeSticky:false}
export const TMP_SOCKET_DIR_POLICY: DirPolicy; // {create:true, recursive:false, allowOwnedSymlink:false, repairMode:true, parentMustBeSticky:true}
export interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}
export interface HubPaths {
  stateDir: string;
  socketPath: string;
  socketDir: string; // 新增：dirname(socketPath)
  hubJson: string;
  tokenFile: string;
  logFile: string;
  startLock: string;
  policies: { readonly stateDir: DirPolicy; readonly socketDir: DirPolicy }; // 新增：纯计算，按 socket 候选来源选择
  dbFile: string; // W1 一并落地（§4.1 使用）
}
export type PrivateDirReason = "not-directory" | "symlink" | "owner-mismatch" | "mode" | "parent-not-sticky" | "io";
export class PrivateDirError extends Error {
  readonly reason: PrivateDirReason;
  readonly dir: string;
}
export type FsDeps = Pick<typeof import("node:fs/promises"), "lstat" | "stat" | "mkdir" | "chmod" | "realpath"> & {
  getuid(): number;
};
export function resolveHubPaths(env: HubPathsEnv): HubPaths; // 输入不变；输出多 socketDir + policies
export function ensurePrivateDir(dir: string, policy: DirPolicy, deps?: Partial<FsDeps>): Promise<DirIdentity>; // 由同步改异步；policy 必填
export function verifyBoundSocket(
  socketPath: string,
  dirBefore: DirIdentity,
  deps?: Partial<FsDeps>,
): Promise<SocketIdentity>; // lstat：isSocket、非 symlink、uid、目录 {dev,ino} 未变；失败抛 PrivateDirError
export interface SocketIdentity {
  readonly socket: DirIdentity;
  readonly dir: DirIdentity;
}
```

#### 1.3.2 新签名（`hub/singleton.ts`、`hub/hub.ts`）

```ts
// singleton.ts
export type SingletonResult =
  | { kind: "owner"; server: net.Server; identity: SocketIdentity; release(): Promise<void> } // inode: number 删除，改为 identity
  | { kind: "exists"; hubPid?: number }
  | { kind: "failed"; error: string; reason?: PrivateDirReason | "socket-verify" | "listen" | "lock" | "aborted" }; // reason 新增（可选）；"aborted" = 启动 signal 中止，已自我清理
export interface SingletonDeps {
  probeMs?: number;
  lockStaleMs?: number;
  now?: () => number;
  guardName?: string | null;
  fs?: Partial<FsDeps>; // 新增
  signal?: AbortSignal; // 新增：启动 scope（§1.4.2 的 startup）；每个 await 之后检查；bind 成功后才发现 aborted ⇒ close server、lstat 证明是自己的 socket 则 unlink、释放 lock/guard ⇒ {kind:"failed", reason:"aborted"}
}
export async function acquireSingleton(paths: HubPaths, deps?: SingletonDeps): Promise<SingletonResult>;
export type FenceLoss =
  | "socket-missing" // lstat ENOENT
  | "socket-replaced" // socket.{dev,ino} 与 identity 不同
  | "socket-symlink" // lstat 是 symlink
  | "socket-not-socket" // lstat 存在但不是 socket
  | "dir-replaced" // 目录 {dev,ino} 与 identity.dir 不同
  | "owner-mismatch" // socket 或目录 uid 不是当前 uid
  | "io"; // 校验超时（5s）或非 PrivateDirError 的 I/O 错误；连续 3 次才触发 onLost("io")
export function fenceLossOf(err: unknown, identity: SocketIdentity, seen: SocketIdentity | undefined): FenceLoss; // 映射：PrivateDirError.reason not-directory→socket-not-socket、symlink→socket-symlink、owner-mismatch→owner-mismatch；ENOENT→socket-missing；seen 与 identity 的 socket 不同→socket-replaced、dir 不同→dir-replaced；其它（含 withDeadline 超时的 E_DEADLINE、EIO、EACCES）→io
export function startFence(
  socketPath: string,
  identity: SocketIdentity, // 原 inode: number
  onLost: (why: FenceLoss) => void, // 原 () => void（多一个参数，旧调用方仍兼容）；"io" 只在连续 3 次后触发一次
  intervalMs?: number,
  firstMs?: number,
  deps?: Partial<FsDeps> & { checkDeadlineMs?: number /* 5_000 */; ioStrikes?: number /* 3 */ }, // 新增
): () => void;

// hub.ts
export const HUB_START_DEADLINE_MS = 20_000; // 新增（§3.1）
export const HUB_CLOSE_DEADLINE_MS = 10_000; // 新增（§3.1）；STEP_DEADLINE_MS = 3_000 保留给 crash 硬退出与单步 bounded()
export interface StartHubDeps {
  now?: () => number;
  uid?: number;
  xdgRuntimeDir?: string;
  fs?: Partial<FsDeps>; // 新增
  lanAssembly?: LanAssembly; // 新增（§1.4.1）：默认 defaultLanAssembly
  lanConfigError?: { detail: string }; // 新增：main.ts 的 parseHubLanConfig 失败时传入；与 config.lan 互斥（同时存在 ⇒ throw）
}
export interface RunningHub {
  paths: HubPaths;
  httpPort: number;
  info: HubInfo;
  identity: SocketIdentity; // 新增：bind 时确定，release 后无意义
  lan?: LanFacade; // 新增（S1，LD）：等于 frontend.lan；lanConfigError 时为 undefined
  lanStatus(): LanStatus | undefined; // 新增：hub.json 当前的 lan 字段（HubJsonWriter.current()?.lan）
  close(reason: string): Promise<void>;
  readonly closed: Promise<string>;
}
export async function startHub(
  config: HubConfig,
  frontend: FrontendFactory,
  deps?: StartHubDeps,
): Promise<RunningHub | { exists: true }>;
```

| 路径组件                             | policy / 校验                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stateDir`（`~/.pi/agent/web-hub`）  | `STATE_DIR_POLICY`：父路径在 `$HOME` 下，属于同 uid（L11），不逐级检查；用户自己把 `~/.pi` 软链到别的盘是合法的                                                                                                                                                                                                                                                                         |
| `socketDir === stateDir`             | 同上（`policies.socketDir === STATE_DIR_POLICY`，不重复检查）                                                                                                                                                                                                                                                                                                                           |
| `socketDir === $XDG_RUNTIME_DIR`     | `XDG_SOCKET_DIR_POLICY`：lstat 必须是目录（非 symlink）、`uid` 为当前 uid、`(mode & 0o077) === 0`；任一不满足 ⇒ `PrivateDirError`                                                                                                                                                                                                                                                       |
| `socketDir === /tmp/pi-webhub-<uid>` | `TMP_SOCKET_DIR_POLICY`：先 `realpath("/tmp")` + `stat` 确认是带 sticky 位的目录（否则 `parent-not-sticky`）；`lstat(dir)`：ENOENT ⇒ `mkdir(dir, 0o700)`（EEXIST 竞态 ⇒ 重新 lstat 一次）；必须是目录（symlink ⇒ `symlink`）、`uid` 为当前 uid（否则 `owner-mismatch`、**不** chmod）；宽模式 ⇒ chmod 0700 + warn（sticky 目录中其它 uid 无法替换我们的条目）                           |
| socket 文件（bind 之后）             | `verifyBoundSocket(socketPath, dirBefore)`：`lstat(socketPath)` 是 socket、非 symlink、`uid` 为当前 uid；`lstat(socketDir)` 的 `{dev, ino}` 等于 `dirBefore`；失败 ⇒ `closeServer` + `{kind:"failed", reason:"socket-verify"}`（**不** unlink——路径可能不是我们的）。通过后 `chmod 0600`（umask 已让它一出生就是 0600，这一步是纵深防御）并把返回值作为 `identity`                      |
| `identity` 的生命周期                | 在 `acquireSingleton` 的 bind 成功路径上创建（唯一创建点）；由 `SingletonResult.owner.identity` 持有 → `hub.ts` 传给 `startFence` 与 `RunningHub.identity`；`release()` 用 `lstat` 比较 `identity.socket` 且非 symlink 决定「还是我们的」（是 ⇒ 让 libuv 关闭时 unlink；否则先 rename 保全他人条目再 close，与 P1 相同）；`release()` 之后 `identity` 失效，fence 已在 `close()` 中先停 |
| `startFence`                         | 每次检查 = `verifyBoundSocket(socketPath, identity.dir)` 的异步形式并比较 `socket.{dev,ino}`：ENOENT ⇒ `socket-missing`；是 symlink ⇒ `socket-symlink`；不是 socket ⇒ `socket-not-socket`；`{dev,ino}` 变 ⇒ `socket-replaced`；目录变 ⇒ `dir-replaced`；uid 变 ⇒ `owner-mismatch`。任一 ⇒ 停止并 `onLost(why)`（一次）；bind 与 fence 是同一个校验函数                                  |
| 候选选择                             | `resolveHubPaths` 保持纯函数；目录检查失败 ⇒ `acquireSingleton` 返回 `{kind:"failed", reason}`，文案 `socket 目录 <dir> 不可用：<reason>；请删除该条目或设置 XDG_RUNTIME_DIR`，**不**回落到下一个候选                                                                                                                                                                                   |
| umask                                | `hub/main.ts` 在解析配置之后、任何文件操作之前 `process.umask(0o077)`；只在进程入口设置，库代码不改 umask                                                                                                                                                                                                                                                                               |

#### 1.3.3 `hub.ts` 调用链改动（逐行）

| 现有位置                                                               | 改动                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub.ts:44` `ensurePrivateDir(paths.stateDir);`                        | `await ensurePrivateDir(paths.stateDir, paths.policies.stateDir, deps?.fs);`（`startHub` 已是 async）                                                                                                                                                                                                                                                                                                                 |
| `hub.ts:46` `acquireSingleton(paths, { now })`                         | `acquireSingleton(paths, { now, fs: deps.fs, signal: startup.signal })`；内部 `singleton.ts:75-78` 改为 `await ensurePrivateDir(paths.stateDir, paths.policies.stateDir, fs)`，`socketDir !== stateDir` 时 `dirBefore = await ensurePrivateDir(paths.socketDir, paths.policies.socketDir, fs)`；每个 await 之后 `if (signal.aborted)` ⇒ 释放已取得的 lock / guard / server 并返回 `{kind:"failed", reason:"aborted"}` |
| `singleton.ts:125-137` listen 后 `chmodSync` + `statSync().ino`        | `identity = await verifyBoundSocket(paths.socketPath, dirBefore ?? stateDirIdentity, fs)` → `await fs.chmod(socketPath, 0o600)`；失败 ⇒ `closeServer` + `failed/socket-verify`                                                                                                                                                                                                                                        |
| `singleton.ts` `release()` 的 `statSync(...).ino === inode`            | `lstat` + `!isSymbolicLink() && dev/ino === identity.socket`                                                                                                                                                                                                                                                                                                                                                          |
| `hub.ts:127` `startFence(paths.socketPath, single.inode, () => {...})` | `startFence(paths.socketPath, single.identity, (why) => { log.warn("socket fence lost", { why }); void close("fence"); }, undefined, undefined, deps?.fs)`                                                                                                                                                                                                                                                            |
| `hub.ts` 返回的 `RunningHub`                                           | 增加 `identity: single.identity`、`lan: fe.lan`、`lanStatus()`（全部 W1）                                                                                                                                                                                                                                                                                                                                             |
| `hub.ts:37` `startHub(...)` 整体                                       | 按 §1.4.2 重写：`startup: AbortController` + `HUB_START_DEADLINE_MS` 定时器（unref）；步骤 ①–⑦ 每个 await 经 `withSignal`；失败 / 超时 ⇒ `cleanup` 逆序回收 + `rootScope.dispose()` + `log.close()` 后 throw                                                                                                                                                                                                          |
| `main.ts:57` `ensurePrivateDir(paths.stateDir)`                        | `await ensurePrivateDir(paths.stateDir, paths.policies.stateDir)`；其前一行加 `process.umask(0o077)`                                                                                                                                                                                                                                                                                                                  |

#### 1.3.4 被修改的既有测试（评审 v6 #1：放弃「P1 测试一行不改」；只改形态，不删弱行为断言）

| 文件:行                                              | 现有断言                                                                            | 改动与理由                                                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/web-hub/protocol/paths.test.ts:21-28`         | `expect(p).toEqual({stateDir, socketPath, hubJson, tokenFile, logFile, startLock})` | **加**两项：`socketDir: "/home/u/.pi/agent/web-hub"`、`policies: { stateDir: STATE_DIR_POLICY, socketDir: STATE_DIR_POLICY }`。原六项字面值不变（更强：还断言了 policy 选择）                               |
| `paths.test.ts:37-43`（XDG 回落）                    | `socketPath`、`stateDir`、`hubJson` 断言                                            | 保留全部；**加** `expect(p.socketDir).toBe("/run/user/1000")`、`expect(p.policies.socketDir).toBe(XDG_SOCKET_DIR_POLICY)`                                                                                   |
| `paths.test.ts:46-49`（/tmp 回落）                   | `socketPath` 断言                                                                   | 保留；**加** `policies.socketDir === TMP_SOCKET_DIR_POLICY`                                                                                                                                                 |
| `paths.test.ts:76-81` creates nested 0700            | 同步调用 + `statSync(dir).mode & 0o777 === 0o700`                                   | 改为 `await ensurePrivateDir(dir, STATE_DIR_POLICY)`；mode 断言不变                                                                                                                                         |
| `paths.test.ts:83-89` repairs 0755                   | 同上                                                                                | 同上（`repairMode:true` 保持 P1 修复行为）；mode 断言不变                                                                                                                                                   |
| `paths.test.ts:91-96` idempotent                     | 两次调用后 0700                                                                     | 改为两次 `await`；断言不变                                                                                                                                                                                  |
| `paths.test.ts:98-102` file ⇒ throws                 | `expect(() => ensurePrivateDir(file)).toThrow(/not a directory/)`                   | 改为 `await expect(ensurePrivateDir(file, STATE_DIR_POLICY)).rejects.toThrow(/not a directory/)`；并**加** `.rejects.toMatchObject({ reason: "not-directory" })`                                            |
| `paths.test.ts:104-113` other uid（skipIf !root）    | `toThrow(/owned by uid/)`                                                           | 改为 `rejects.toThrow(/owned by uid/)`；**加**一个不依赖 root 的同类用例：注入 `deps.getuid = () => uid + 1` ⇒ `reason: "owner-mismatch"` 且 `chmod` spy 未被调用                                           |
| `tests/web-hub/http/helpers.ts:84-91`                | `const paths: HubPaths = {…六项}`（类型层，无断言）                                 | 改为 `testHubPaths(stateDir)`（新 helper，`tests/web-hub/helpers/paths.ts`）：六项不变 + `socketDir: stateDir` + `policies: {stateDir: STATE_DIR_POLICY, socketDir: STATE_DIR_POLICY}`。无行为断言变化      |
| `tests/web-hub/agent/helpers.ts:24-33` `pathsIn`     | 同上（类型层）                                                                      | 同上                                                                                                                                                                                                        |
| `tests/web-hub/hub/singleton.test.ts:163/179/305`    | `startFence(p.socketPath, o.inode, () => lost++, …)`                                | `o.inode` → `o.identity`；`lost++` 回调签名兼容（忽略 `why`）；**加**断言：#158 用例中 `why === "socket-not-socket"`（unlink 后写普通文件），#305 用例中 `why === "socket-missing"`。触发条件与次数断言不变 |
| `singleton.test.ts:138-155` release inode            | `release()` 只在「inode 仍是我们的」时 unlink                                       | 断言不变（用例名中的 inode 语义由 `identity.socket` 承接）；**加**：把路径换成 symlink 后 `release()` 不 unlink 目标                                                                                        |
| `tests/web-hub/hub/hub.test.ts`                      | 用 fake frontend 的 `RunningHub` 断言                                               | 不改（`identity`、`lan` 为新增字段，现有 `toEqual` 只针对 hub.json 与 port）                                                                                                                                |
| `tests/integration/web-hub-spawn.test.ts:76/113/133` | `resolveHubPaths(...).hubJson` / `.socketPath`                                      | 不改（只取既有字段）                                                                                                                                                                                        |

不允许的改动：删除任一 `it(…)`、放宽任何 mode / 触发次数 / 文案正则。

#### 1.3.5 迁移测试（新增，`tests/web-hub/hub/singleton-hardening.test.ts`、`tests/web-hub/protocol/paths-private-dir.test.ts`、`tests/integration/web-hub-hardening.test.ts`）

`resolveHubPaths` 对三种候选返回的 `policies` 快照；每种 policy 的反例（symlink → `symlink`、`getuid+1` → `owner-mismatch` 且无 chmod、0755 + `repairMode:false` → `mode`、父目录无 sticky → `parent-not-sticky`、`create:false` 下 ENOENT → `io`）；`acquireSingleton` 在目录检查失败时返回 `{kind:"failed", reason}` 且没有 `listen`（spy）；竞态：注入 `lstat` 在 bind 后对目录返回不同 `ino` ⇒ `failed/socket-verify`、server 已关闭、路径未被 unlink；bind 后 `lstat(socket)` 是 symlink / 不是 socket / 属主不对 ⇒ 同上；fence：运行中把 socket 路径替换为 symlink ⇒ `onLost("socket-symlink")`，替换目录（注入）⇒ `dir-replaced`；`RunningHub.identity` 等于 fence 使用的 identity（同一引用）；`startHub` 在注入 `fs.lstat` 永不 resolve 时 ⇒ 在 `HUB_START_DEADLINE_MS`（测试注入 300ms）后 reject `start timeout`，且 guard/lock/socket 都已释放（可再次 acquire）；集成：agent 连上 socket 后立刻 `stat` ⇒ 0600；`hub.json`、`hub.log` 都是 0600、状态目录 0700（umask 生效）。

### 1.4 双 listener 组合契约（W1 冻结；评审 v5 #1、v6 #1）

对照现有 `src/web-hub/hub/{ports,hub,main,http,static,sse}.ts` 的**签名级**清单。原则：现有导出一律不改名、不改参数顺序；新增字段全部可选，`config.lan === undefined` 时所有新代码路径不执行（P1 fake 与测试不受影响）。

#### 1.4.1 `hub/ports.ts`（现有 12-87 行只描述一个 loopback listener）

```ts
// ---- 新增类型 ----
export type ListenerKind = "loopback" | "lan";
export interface HubLanConfig {
  port: number; // ≠ config.port
  extraHosts: string[]; // 已通过 classifyHostToken（env 解析再校验一次）
  trustProxyFrom: string[]; // IPv4 字面量；空 ⇒ 不解析任何转发头
  externalOrigins: string[]; // 只允许 https（§2.4）；与 trustProxyFrom 同时非空或同时为空
}
export interface RequestContext {
  readonly kind: ListenerKind;
  readonly peerIp: string; // socket 对端（去 ::ffff:）
  readonly viaTrustedProxy: boolean; // peerIp ∈ trustProxyFrom
  readonly clientIp: string; // 直连 = peerIp；经代理 = XFF 链上第一个不受信任的地址（解析失败 ⇒ peerIp）
  readonly scheme: "http" | "https"; // 直连恒 http；经代理恒 https（XFP 非 https ⇒ 400，不会构造出 ctx）
  readonly hostKey: string; // canonicalHostKey（小写、显式端口）
  readonly externalOrigin: string; // canonicalOrigin（浏览器形式）
  readonly snapshot?: HostSnapshot; // kind === "lan" 时那一次读取的快照
}
export interface LanFrontendDeps {
  cfg: HubLanConfig;
  store: LanStorePort; // §4
  kdf: KdfPort; // §5.1
  limiter: LoginLimiterPort; // §6.2
  admission: KdfAdmissionPort; // §6.2
  hosts: HostsPort; // §2.3
  scope: Scope; // §3
  onStatus(s: LanStatus): void; // hub.ts 收到后重写 hub.json.lan
}
export interface LanFacade {
  start(): Promise<LanStatus>; // §3 controller.start()；受 LAN_START_DEADLINE_MS 约束
  status(): LanStatus;
  close(): Promise<void>; // 关闭 LAN listener 与其 SSE（≤2s）；loopback 不受影响
  revoke(target: { sidHash: string } | { userId: number }): number; // 同步关闭匹配的 LAN SSE，返回条数
}
/** hub.ts 用来装配 LanFrontendDeps 的接缝（LD 提供默认实现 hub/lan-assembly.ts；测试注入假件） */
export interface LanAssembly {
  build(args: {
    cfg: HubLanConfig;
    paths: HubPaths;
    log: HubLog;
    now: () => number;
    scope: Scope;
    onStatus(s: LanStatus): void;
  }): Promise<LanFrontendDeps>;
}
// ---- 现有类型的变更（只增字段） ----
export interface HubConfig {
  v: 1;
  home: string;
  port: number;
  idleExitMinutes: number;
  pluginVersion: string;
  buildId: string;
  launcher?: [string, string];
  lan?: HubLanConfig; // 新增
}
export interface FrontendDeps {
  config: HubConfig;
  paths: HubPaths;
  registry: RegistryView;
  bus: HubBus;
  history: HistoryService;
  log: HubLog;
  info: () => HubInfo;
  now: () => number;
  lan?: LanFrontendDeps; // 新增
}
export interface HttpFrontend {
  listen(opts?: { signal?: AbortSignal }): Promise<{ port: number }>; // loopback；新增可选 opts：已 aborted ⇒ 立即 reject；listen 进行中 abort ⇒ reject 且迟到的 listening 回调自己 server.close()
  close(): Promise<void>; // 变更语义：同时关闭 lan（如有），先 lan 再 loopback
  clientCount(): number; // 变更语义：两个 listener 的 SSE 之和（idle 判定不变）
  lan?: LanFacade; // 新增：仅当 deps.lan !== undefined
}
export type FrontendFactory = (deps: FrontendDeps) => HttpFrontend; // 不变
```

#### 1.4.2 `hub/hub.ts`（现有 `startHub` 37-176、`RunningHub` 22-28、`installProcessHandlers`、`writeHubJson`）

`RunningHub` / `startHub` / `StartHubDeps` 的新签名见 §1.3.2。下面的片段中出现的每个标识符都在本节或 §1.3 定义：

```ts
// ---- 导入（hub.ts 顶部，全部静态；lan-assembly.ts 在 W1 是抛 E_NOT_IMPLEMENTED 的桩，LD 填实。它不导入 node:sqlite） ----
import { defaultLanAssembly } from "./lan-assembly.js"; // export const defaultLanAssembly: LanAssembly
import { createScope, type Scope } from "./lifecycle.js"; // §3；W1 落地
import { createHubJsonWriter, type HubJsonWriter, type HubRecord } from "./hub-json.js"; // 新文件（W1）

// ---- hub.json 写入器（唯一写入路径；内存中持有当前记录，不回读磁盘） ----
export interface HubRecord {
  pid: number; nonce: string; version: string; buildId: string; proto: typeof PROTO; socket: string; port: number; startedAt: number;
  procStartTicks?: number; argv?: string[]; // 身份字段（Linux 下 procStartTicks 读 /proc/self/stat 第 22 字段；读不到就省略）
  lan?: LanStatus; // 三种来源：lanConfigError（off/bad-config）、fe.lan 存在（starting → start() 的结果 → onStatus 的后续更新）、都不存在 ⇒ 字段缺失
}
export interface HubJsonWriter {
  write(record: HubRecord): void; // tmp + rename，0600；失败只 log.error
  patchLan(lan: LanStatus): void; // 合并到内存记录后 write；write 之前调用 ⇒ 只更新内存
  current(): HubRecord | undefined;
  removeIfOurs(): void; // 现有 removeHubJsonIfOurs 的搬迁
}
export function createHubJsonWriter(file: string, log: HubLog): HubJsonWriter;

// ---- 启动（替换现有 37-110 行的主体；编号对应 §3.1 的取消链） ----
export async function startHub(config: HubConfig, frontend: FrontendFactory, deps: StartHubDeps = {}): Promise<RunningHub | { exists: true }> {
  const now = deps.now ?? Date.now;
  const startup = new AbortController(); // ① 启动 scope：唯一的取消源
  const startTimer = setTimeout(() => startup.abort(new Error("web-hub: start timeout")), HUB_START_DEADLINE_MS);
  startTimer.unref();
  const paths = resolveHubPaths({ home: config.home, uid: deps.uid ?? process.getuid?.() ?? 0, xdgRuntimeDir: deps.xdgRuntimeDir ?? process.env["XDG_RUNTIME_DIR"] });
  await withSignal(ensurePrivateDir(paths.stateDir, paths.policies.stateDir, deps.fs), startup.signal); // ②
  const log = createHubLog(paths.logFile);
  const rootScope: Scope = createScope({ log, now }); // ③ 根 scope：hub 生命期；LAN 的 controller/db 子进程/定时器都挂在它的 child 上
  const cleanup: (() => Promise<void>)[] = []; // 逆序执行；每项经 bounded()
  try {
    const single = await acquireSingleton(paths, { now, fs: deps.fs, signal: startup.signal }); // ④ 内部按 §1.3.2 处理 abort：迟到 bind ⇒ 自己 release
    if (single.kind === "exists") { log.info("hub already running", …); log.close(); return { exists: true }; }
    if (single.kind === "failed") throw new Error(`web-hub: ${single.error}`);
    cleanup.push(() => single.release());
    const registry = createRegistry({ now, log, hubVersion: config.pluginVersion });
    const history = createHistoryService({ registry, log });
    cleanup.push(async () => history.dispose());
    let httpPort = 0;
    const agentServer = createAgentServer(single.server, { registry, config, log, now, httpPort: () => httpPort });
    cleanup.push(() => agentServer.close());
    const info: HubInfo = { version: config.pluginVersion, buildId: config.buildId, pid: process.pid, startedAt: now(), proto: PROTO };
    const hubJson: HubJsonWriter = createHubJsonWriter(paths.hubJson, log);
    let lanDeps: LanFrontendDeps | undefined;
    if (config.lan !== undefined) { // 只有合法配置才会到这里；非法配置由 main.ts 转成 deps.lanConfigError（§1.4.3）
      lanDeps = await withSignal((deps.lanAssembly ?? defaultLanAssembly).build({ cfg: config.lan, paths, log, now, scope: rootScope.child(), onStatus: (s) => hubJson.patchLan(s) }), startup.signal); // ⑤
    }
    const fe = frontend({ config, paths, registry, bus: registry.bus, history, log, info: () => info, now, ...(lanDeps === undefined ? {} : { lan: lanDeps }) });
    cleanup.push(() => fe.close()); // fe.close 内部先 lan.close 再 loopback
    httpPort = (await fe.listen({ signal: startup.signal })).port; // ⑥ 迟到的 listen 由 frontend 自己 close
    const initialLan: LanStatus | undefined = deps.lanConfigError !== undefined ? { state: "off", reason: "bad-config", detail: deps.lanConfigError.detail } : fe.lan !== undefined ? { state: "starting" } : undefined;
    hubJson.write({ pid: process.pid, nonce: randomBytes(12).toString("base64url"), version: config.pluginVersion, buildId: config.buildId, proto: PROTO, socket: paths.socketPath, port: httpPort, startedAt: info.startedAt, ...identityFields(), ...(initialLan === undefined ? {} : { lan: initialLan }) }); // ⑦
    clearTimeout(startTimer); // 启动完成；之后的取消由 close() 负责
    if (fe.lan !== undefined) void fe.lan.start().then((s) => hubJson.patchLan(s), (err: unknown) => hubJson.patchLan({ state: "off", reason: "timeout", detail: String(err) })); // LAN 异步启动，受 §3 的 LAN_START_DEADLINE_MS
    … // 现有的 closed promise、tick、startFence（(why) => …）、idle、close() 定义不变，但 close() 的顺序见下表
    return { paths, httpPort, info, identity: single.identity, ...(fe.lan === undefined ? {} : { lan: fe.lan }), lanStatus: () => hubJson.current()?.lan, close, closed };
  } catch (err) {
    clearTimeout(startTimer);
    for (const step of cleanup.reverse()) await bounded(step()); // ⑧ 已创建的资源逆序回收；bounded = 现有 3s 单步上限
    await bounded(rootScope.dispose());
    log.close();
    throw err instanceof Error ? err : new Error(String(err));
  }
}
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T>; // 已 aborted ⇒ 立即 reject(signal.reason)；否则 race；迟到的 p 结果被丢弃（调用方负责用 signal 自行清理产物）
function identityFields(): Pick<HubRecord, "procStartTicks" | "argv">; // Linux：读 /proc/self/stat；其它平台返回 {}
```

| 项                       | 规定                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootScope` 的创建者     | `startHub`（步骤 ③，log 之后、singleton 之前）；`RunningHub.close()` 在 `fe.close()` 之后、`single.release()` 之前 `await bounded(rootScope.dispose())`；启动失败路径在 cleanup 之后 dispose。`rootScope.dispose()` 幂等，abort ⇒ LAN controller 的 generation 失效、db 子进程 SIGKILL、全部 unref 定时器清除                                                                         |
| 启动 scope vs 根 scope   | `startup: AbortController` 只覆盖启动阶段（①–⑦），启动完成即 `clearTimeout`；`rootScope` 覆盖 hub 生命期。二者独立：启动超时不会 dispose 一个还没开始用的 rootScope 以外的东西，运行期关闭不再涉及 startup                                                                                                                                                                            |
| `close(reason)` 的顺序   | `closing` 幂等守卫 → `stopFence()` → `idle.stop()` → `clearInterval(tick)` → `fe.close()`（内部先 `lan.close()` ≤2s 再 loopback ≤2s）→ `history.dispose()` → `agentServer.close()`（≤3s）→ `rootScope.dispose()`（≤2s：LAN 定时器、db 子进程）→ `single.release()`（≤2s）→ `hubJson.removeIfOurs()` → `log.close()` → `resolveClosed(reason)`；整体受 `HUB_CLOSE_DEADLINE_MS`（§3.1） |
| `defaultLanAssembly`     | 定义在 `src/web-hub/hub/lan-assembly.ts`，`hub.ts` 顶部静态导入；W1 版本 `build()` 直接 `throw new Error("E_NOT_IMPLEMENTED:LD")`（config.lan 存在时 hub 启动失败，测试用 `deps.lanAssembly` 注入假件）；LD 用真实装配（store / kdf / limiter / admission / hosts）替换。该文件只 `import type` 端口类型，不导入 `node:sqlite`                                                        |
| `hub.json` 的写入路径    | 只有 `HubJsonWriter`（`write` 一次 + 若干 `patchLan`）；`lan` 字段的三种来源见 `HubRecord` 注释；`removeIfOurs` 在 close 尾部；没有任何别的代码写这个文件                                                                                                                                                                                                                             |
| `installProcessHandlers` | 不变：SIGTERM/SIGINT ⇒ `hub.close(sig)`（受 `HUB_CLOSE_DEADLINE_MS` 10s）；`uncaughtException` ⇒ **crash 专用**：`setTimeout(process.exit(1), STEP_DEADLINE_MS = 3s).unref()` 后 `hub.close("crash").finally(exit(1))`——3s **保持**（进程状态已不可信，宁快勿全），不统一到 10s（v7 复审 #6）                                                                                         |

#### 1.4.3 `hub/main.ts`（现有 `main()` 36-80）

```ts
process.umask(0o077); // 新增：在 JSON.parse(PI_WEBHUB_CONFIG) 之后、resolveHubPaths 之前
export function parseHubLanConfig(raw: unknown): { ok: true; lan: HubLanConfig } | { ok: false; detail: string }; // 新增（导出以便单测）
// config.lan 的处理（替换现有 44-46 行的 v1 校验之后）：
const deps: StartHubDeps = {};
if (config.lan !== undefined) {
  const parsed = parseHubLanConfig(config.lan);
  if (parsed.ok) config = { ...config, lan: parsed.lan };
  else {
    const { lan: _drop, ...rest } = config;
    config = rest;
    deps.lanConfigError = { detail: parsed.detail };
  } // 非法 ⇒ 不进 startHub 的 LAN 分支，只以 off/bad-config 写 hub.json
}
// 现有 57 行的 ensurePrivateDir 调用删除：startHub 自己做（§1.4.2 ②），避免在 startup signal 之外多一次 fs 调用
hub = await startHub(config, createHttpFrontend, deps);
```

#### 1.4.4 `hub/http.ts`（现有 `createHttpFrontend` 233-…，内部 `allowedHost` / `csrfOk` / `handle` / `listen` / `close`）

```ts
export const createHttpFrontend: FrontendFactory; // 签名不变；deps.lan 存在时另外构造 LAN 部分
// ---- 新增导出（供 LC 单测与 LanTransport） ----
export function buildContext(
  req: IncomingMessage,
  kind: ListenerKind,
  lan?: { snapshot: HostSnapshot; trust: ReadonlySet<string> },
): RequestContext | { reject: 400 | 421; code: "E_BAD_REQUEST" | "E_HOST"; detail: string }; // 纯函数（只读 req.headers / req.socket.remoteAddress）
export function createLanTransport(ctx: LanTransportCtx): LanTransport; // LanTransportCtx = { handleRequest(req, res, ctx: RequestContext): Promise<void>; log; connGuard: ConnGuard }
// ---- 内部变更 ----
// allowedHost(host) → allowedHost(ctx: RequestContext)：kind === "loopback" 时逻辑与 P1 逐字节相同（比较 ctx.hostKey 与 `127.0.0.1:${port}` / `localhost:${port}`）
// csrfOk(req) → csrfOk(req, ctx)：loopback 分支不变（有 Origin 则必须等于 `http://${host}`）；lan 分支按 §2.5
// handle(req, res) → handle(req, res, ctx)：入口 `const ctx = buildContext(req, "loopback")`（loopback）；LAN 由 createLanTransport 的 request 处理器构造 ctx 后调用同一个 handle
// listen()：不变；close()：先 await lan?.close() 再现有逻辑；clientCount()：sse.count() + lanSse.count()
```

#### 1.4.5 `hub/static.ts`（现有 `webRoot` 28、`safeRelativePath` 38、`serveStatic` 79）

```ts
export async function serveStatic(
  root: string,
  urlPath: string,
  res: ServerResponse,
  opts?: { authMode?: "token" | "password" },
): Promise<boolean>; // 新增可选 opts；safeRelativePath(urlPath) === "index.html" 且 opts.authMode 存在 ⇒ 走 serveIndex
export async function serveIndex(root: string, res: ServerResponse, authMode: "token" | "password"): Promise<boolean>; // 新增：读 index.html，把唯一占位符 data-auth-mode="__AUTH_MODE__" 替换为字面值；不含占位符（如 static.test.ts 的假 index）⇒ 原样输出；Content-Length 按替换后字节计；Cache-Control 与 tryServe 相同（no-cache）
```

`tests/web-hub/http/static.test.ts:20` 的假 `index.html` 不含占位符 ⇒ 现有 51-68 行断言不受影响（v6 §16 Q-4 关闭：无需改该测试）。loopback 调用 `serveStatic(root, path, res, { authMode: "token" })`，LAN 调用 `{ authMode: "password" }`；P1 只传三个参数的调用在 `deps.lan === undefined` 时仍成立（`opts` 可选），但为了让 loopback 的 `index.html` 带 `data-auth-mode="token"`，loopback 路径也传 `opts`——这是 P1 行为的一处可见变化（多了一个 HTML 属性），`tests/web-hub/http/api.test.ts` 若比对 `/` 的正文需同步（LC 实施时确认；目前该测试只断言状态码与 content-type）。

#### 1.4.6 `hub/sse.ts`（现有 `SseClient` 26-31、`SseHub` 33-39、`createSseHub` 67）

```ts
export interface SseClient {
  id: string; subscribed: Set<string>; send(event: SseEventName, data: unknown): boolean; close(): void;
  auth?: { sidHash: string; userId: number; epoch: number; boundOrigin: string; verifiedAt: number }; // 新增（LAN 打开时写入；tick 复核更新 verifiedAt）
  revoked?: boolean; // 新增：置位后 publish/send 跳过
}
export interface SseHub {
  attach(req: IncomingMessage, res: ServerResponse, lastEventId: number | undefined, auth?: SseClient["auth"]): SseClient; // 第 4 参数新增
  publish(...): void; get(...): SseClient | undefined; count(): number; closeAll(): void; // 不变
  revoke(pred: (c: SseClient) => boolean, reason: "revoked" | "expired"): number; // 新增：同步标记 → 写 event:auth → end；返回条数
  list(): readonly SseClient[]; // 新增：tick 复核遍历
}
export const SSE_EVENTS = [...现有, "auth"] as const; // 新增事件名 —— 定义在 protocol/http-contract.ts:17-34（sse.ts 只 import type）；web/contract.js:10 同步追加 "auth"；tests/web-hub/web/contract.test.ts:8 的镜像测试自动覆盖
export interface SseAuthPayload { reason: "revoked" | "expired" } // protocol/http-contract.ts 新增；hub 侧 revoke 与 web/app.js 的 auth 处理都用它
```

| 契约项              | 规定                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端口                | loopback：`config.port`（占用时回落随机端口，P1 不变）；lan：`config.lan.port`，占用 ⇒ `off/listen-failed`，**不回落**；两者相等 ⇒ settings 解析拒绝、`parseHubLanConfig` ⇒ `bad-config`                                                                   |
| 生命周期            | §1.4.2 的顺序：loopback 先服务并写 hub.json，LAN 异步启动、状态经 `onStatus` 重写；`close`：`fe.close()` 内部先 lan 再 loopback；全程受 §3.1 的两个整体 deadline                                                                                           |
| 请求上下文          | 每个请求（两个 listener 都是）在入口构造一次 `RequestContext`，后续只读 ctx；loopback 的 ctx 只是把 P1 已有的 `req.headers.host` / `remoteAddress` 读取集中到一处，判定逻辑不变                                                                            |
| authMode 来源       | 由 `kind` 决定，写进 `index.html` 的 `<html data-auth-mode>`；`/healthz.authMode` 仅诊断                                                                                                                                                                   |
| agent / status 返回 | `lan_res{op:"info"}.info = { username, initialPassword?, initialLogin?, lan: LanStatus }`；`/webhub status` 只读 `hub.json.lan`；TUI 下额外 `lan_req info`                                                                                                 |
| P1 兼容             | `hub.test.ts:25` 的 fake frontend 不改（`lan` 可选）；`agent-server.test.ts:55` 的 hello_ack 精确 `toEqual` 不改（`caps` 只在装配 admin 端口时输出）；PROTO 1.0；`createHttpFrontend` 在 `deps.lan === undefined` 时除 `index.html` 多一个属性外与 P1 等价 |

---

## 2. Host 规范化、白名单、受信任代理与请求路由

### 2.1 主机名规则与拒绝原因（`protocol/lan.ts`，W1 冻结；L16、评审 #8）

```ts
export const SINGLE_LABEL_DENYLIST = [
  "local",
  "lan",
  "home",
  "internal",
  "intranet",
  "corp",
  "localdomain",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "dev",
  "app",
  "io",
  "com",
  "net",
  "org",
]; // v7：不含 localhost
export type HostTokenKind = "ipv4" | "fqdn" | "single-label" | "dot-local" | "localhost";
export type HostTokenRejectReason = "syntax" | "denylisted" | "ipv6" | "too-long" | "numeric";
export type HostTokenResult =
  { ok: true; kind: HostTokenKind; host: string /* 小写化 */ } | { ok: false; reason: HostTokenRejectReason };
export function classifyHostToken(token: string): HostTokenResult;
export interface InvalidHostToken {
  token: string;
  reason: HostTokenRejectReason;
}
```

规则（先小写化；**按以下优先级依次判定，命中即返回**）：① 含 `:` ⇒ `ipv6`（L8 仅 IPv4）；② 点分四段且每段 0..255 ⇒ `ipv4`；③ 总长 > 253 或任一标签 > 63 ⇒ `too-long`；④ 任一标签不匹配 `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` ⇒ `syntax`；⑤ 恰等于 `localhost` ⇒ `{ok:true, kind:"localhost"}`（专用分支，**先于**小名单与 numeric——`localhost` 不在 `SINGLE_LABEL_DENYLIST` 中，v6 #6）；⑥ **最后一个标签全是数字**（且不是合法 IPv4）⇒ `numeric`（WHATWG URL 把它当数值型 IPv4 解析，Chromium 实测在到达服务器之前就拒绝）；⑦ 单标签且在小名单中 ⇒ `denylisted`；⑧ 以 `.local` 结尾且前面恰是一个合法单标签 ⇒ `dot-local`；⑨ 其它带点 ⇒ `fqdn`；⑩ 其它 ⇒ `single-label`。测试（LA `tests/web-hub/protocol/lan.test.ts`「分类优先级」）：`localhost` ⇒ `localhost`（不是 denylisted）；`LOCALHOST` ⇒ 小写后同上；`localhost.local` ⇒ `dot-local`；`a.localhost` ⇒ `fqdn`；`127.0.0.1` ⇒ `ipv4`（不是 numeric）；`123` ⇒ `numeric`（不是 single-label）；`123.local` ⇒ `dot-local`；`dev` ⇒ `denylisted`；`x.dev` ⇒ `fqdn`；`a_b` ⇒ `syntax`（先于 denylisted 检查）；`::1` ⇒ `ipv6`。

`numeric` 的统一契约：它**只是**一个 `ok:false` 的拒绝原因，不是 `HostTokenKind`；同一个 `HostTokenRejectReason` 类型被 `parseWebHubSettings` 的 `invalidExtraHosts: InvalidHostToken[]`、`parseHubLanConfig` 的 `bad-config` detail（`extraHosts[2]=202507220006: numeric`）、`HostSnapshot.omitted[].reason` 与 §9.3 的文案共用，任何一处都不得自定义字符串。

| 来源                                                                                   | 进入白名单                                                                                                                                     | 说明                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 接口 IPv4（`os.networkInterfaces()`，`family === "IPv4"`，含 internal、docker/bridge） | 全部                                                                                                                                           | L8：不排除 docker 网桥                         |
| `127.0.0.1`、`localhost`                                                               | 是                                                                                                                                             | 本机也可以走 LAN 端口（用密码）                |
| 系统主机名 `h = os.hostname().toLowerCase()`                                           | `classifyHostToken(h).ok` ⇒ 是；否则记入 `omitted: {host: h, reason}` 并在 status 提示（§9.3）                                                 | 纯数字主机名放进去也无法被 Chromium 使用       |
| `<h>.local`                                                                            | h 是合法单标签（**含纯数字**：`202507220006.local` 在 Chromium 可导航）⇒ 是                                                                    | 只有 mDNS/Avahi 存在时才可解析；hub 不负责解析 |
| extraHosts（`webHub.lan.extraHosts`）                                                  | 逐项 `classifyHostToken`：settings 解析时非法项进入 `invalidExtraHosts`（status 列出）；env 解析时任一项非法 ⇒ `off/bad-config`（fail-closed） | L16 两处校验各自有测试                         |
| `externalOrigins`（L24）                                                               | **不进** `hostKeys`；单独作为 `HostSnapshot.externalOrigins` 集合，只对经受信任代理的请求生效（§2.4）                                          | 代理的对外地址与本机接口无关                   |

### 2.2 Host 规范化（`protocol/lan.ts`；评审 #7）

```ts
export function canonicalHostKey(hostHeader: string | undefined, scheme: "http" | "https"): string | undefined; // "host:port"，小写；缺端口 ⇒ 补 80/443；非法 ⇒ undefined
export function canonicalOrigin(scheme: "http" | "https", hostKey: string): string; // 浏览器形式：默认端口省略，如 "https://hub.example.com"、"http://192.168.31.25:7879"
export function parseOrigin(origin: string): { scheme: "http" | "https"; hostKey: string } | undefined; // 用 URL 解析；path/search/hash 非空、非 http(s)、含用户信息 ⇒ undefined
```

规则：`hostHeader` 只接受 ASCII，形如 `host` 或 `host:port`；`host` 必须通过 `classifyHostToken` 的语法层（允许 `numeric`/`denylisted`——规范化不判白名单）；IPv6 字面量 `[…]` ⇒ `undefined`（L8）；`port` 必须是 1..65535 的十进制，前导零 ⇒ `undefined`；缺端口按 scheme 补 80/443。**所有比较都在 canonical 值上进行**：白名单 `hostKeys` 存显式端口形式；`Origin` 头先 `parseOrigin` 再 `canonicalOrigin` 后与 `ctx.externalOrigin` 字符串相等；会话 `bound_origin` 存 `ctx.externalOrigin`。测试：`Host: hub.example.com` + https ⇒ `hub.example.com:443` / `https://hub.example.com`；`Host: 192.168.31.25:7879` ⇒ 不变；`Host: MyHost.Local:7879` ⇒ 小写；`Host: host:080` ⇒ 拒绝；`Origin: https://hub.example.com:443` 与 `Origin: https://hub.example.com` 规范化后相等；`Origin: https://hub.example.com/` （带斜杠，URL 解析后 pathname 为 `/`）⇒ 接受；`Origin: null` ⇒ 拒绝。

### 2.3 快照、重算与传输插槽（`hub/ports.ts` W1 冻结；`hub/net-hosts.ts` LC；`hub/lan-controller.ts` LD）

```ts
export interface HostSnapshot {
  readonly gen: number;
  readonly hostKeys: ReadonlySet<string>; // 直连白名单：canonicalHostKey 集合
  readonly externalOrigins: ReadonlySet<string>; // 经受信任代理的白名单：canonicalOrigin 集合（来自配置，不随接口变化）
  readonly trustProxyFrom: ReadonlySet<string>; // IPv4 字面量
  readonly omitted: readonly { host: string; reason: HostTokenRejectReason }[];
  readonly computedAt: number;
}
export interface LanListenerHandle {
  readonly port: number;
  current(): HostSnapshot;
  swap(next: HostSnapshot): void; // 同步替换引用
  close(): Promise<void>; // 上限 2s
}
export interface LanTransport {
  bind(port: number, first: HostSnapshot, signal: AbortSignal): Promise<LanListenerHandle>;
}
export interface HostsPort {
  compute(cfg: HubLanConfig): HostSnapshot; // 纯计算 + os.networkInterfaces()/os.hostname()，同步、无 I/O
}
```

| 规则           | 效果                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 重算触发       | 60s tick（unref）；直连请求收到 421 且 Host 的主机部分是 IPv4 语法 ⇒ 一次节流重算（≤ 1 次 / 5s）。新地址在 ≤ 5s 内进入白名单（之前的请求返回 421，前端不重试 421）                    |
| 提交           | `compute()` 结果与当前快照的 `hostKeys` 集合相等 ⇒ 不提交；否则 `swap` + `onStatus`。同步执行，没有 await                                                                             |
| 每请求单一快照 | 入口处 `buildContext` 读一次 `handle.current()`；Host 校验、Origin 校验、会话绑定都用这一份                                                                                           |
| 主机减少       | 直接提交缩小的集合（安全方向）；持有旧 Host 的已有连接下一次请求返回 421                                                                                                              |
| `LanTransport` | S1 唯一实现 `createLanTransport()` 在 `http.ts` 中，用 `node:http` 绑 `0.0.0.0:<port>`。这是将来若在 hub 内做 TLS 时唯一需要替换的接口（§14）；认证、限流、路由都在它上面、与传输无关 |

### 2.4 受信任反向代理（`hub/proxy.ts`，LC；L24、评审 #3）

```ts
export interface ProxyResolution {
  viaTrustedProxy: boolean;
  clientIp: string;
  scheme: "http" | "https";
  hostHeader: string | undefined; // X-Forwarded-Host（受信任时）否则 Host
  warnings: ("xff-missing" | "xff-all-trusted" | "xff-malformed" | "proto-invalid")[];
}
export function resolveProxy(peerIp: string, headers: IncomingHttpHeaders, trust: ReadonlySet<string>): ProxyResolution; // 纯函数
```

| 项                  | 规定                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 何时解析            | **只有** `peerIp ∈ trustProxyFrom`（精确 IPv4 字面量匹配，不做 CIDR）时才读 `X-Forwarded-*`；否则三者一律忽略，`clientIp = peerIp`、`scheme = "http"`、`hostHeader = Host`。`Forwarded`（RFC 7239）永远忽略。经受信任代理的请求**必须**通过下面三条收紧规则才会构造出 `RequestContext`，否则在 `buildContext` 就以 400 / 421 结束（不进入任何认证或限流逻辑）                                                                                                                   |
| `X-Forwarded-For`   | 取**最后一个**同名头（多个头时最靠近代理的那个），按逗号切分并 trim；从右往左跳过 ∈ `trustProxyFrom` 的地址，第一个不在其中的项必须是合法的 IPv4 字面量（`classifyHostToken(...).kind === "ipv4"`）⇒ `clientIp`；全部受信任 / 缺失 / 任一项非法 ⇒ `clientIp = peerIp` 并记 warning（限流按代理本身计数，fail-closed 方向）；IPv6 项按非法处理（L8）                                                                                                                             |
| `X-Forwarded-Proto` | **必须存在且恰为一个值 `https`**（大小写不敏感、无逗号列表）；缺失 / 其它值 / 多值 ⇒ **400 `E_BAD_REQUEST`**（`proxy-proto`，代理配置错误，不是客户端问题）；`ctx.scheme` 因此恒为 `https`（v6 #5）                                                                                                                                                                                                                                                                             |
| `X-Forwarded-Host`  | 存在 ⇒ 必须恰为一个值，`canonicalHostKey(XFH, "https")` 成功（补 443）且 `canonicalOrigin("https", hostKey)` ∈ `snapshot.externalOrigins`，否则 **421 `E_HOST`**（`proxy-host`）；多值 / 非法语法 ⇒ 400；缺失 ⇒ 用 `Host` 做同样的判定。不再「XFH 优先于 Host」地任意采信：任何形态最终都要落在配置的 https origin 上（v6 #5）                                                                                                                                                  |
| 白名单              | 经代理：`ctx.externalOrigin ∈ snapshot.externalOrigins`（上一行已保证，此处是同一判定的落点），**不**查 `hostKeys`；直连：`ctx.hostKey ∈ hostKeys`。直连请求的 `scheme` 恒为 `http`，`externalOrigins` 只允许 `https`（v6 #4）⇒ 直连请求**永远**匹配不到 `externalOrigins`，代理请求永远匹配不到 `hostKeys`——两类入口的 origin 集合不相交，即使同一主机名同时出现在 `extraHosts` 与 `externalOrigins` 中，`bound_origin` 也分别是 `http://h:7879` 与 `https://h`（§6.4）        |
| Origin / CSRF       | POST 的 `Origin` 经 `parseOrigin` + `canonicalOrigin` 后必须**字符串相等**于 `ctx.externalOrigin`；缺失或不等 ⇒ 403                                                                                                                                                                                                                                                                                                                                                             |
| cookie              | `Set-Cookie: pwh_lan=…; HttpOnly; SameSite=Strict; Path=/` + （`ctx.scheme === "https"` ⇒ `; Secure`）。同名 cookie；浏览器在 https origin 下只会带回 Secure cookie，在 http origin 下 `Secure` cookie 不会被发送——两种入口的会话天然隔离，服务端再用 `bound_origin` 校验一次                                                                                                                                                                                                   |
| 会话绑定            | `bound_origin = ctx.externalOrigin`（如 `https://hub.example.com`）；经代理创建的会话拿到直连入口（`http://192.168.31.25:7879`）⇒ 401，反之亦然                                                                                                                                                                                                                                                                                                                                 |
| 限流 / KDF          | `limiter`、`admission`、每客户端 IP 进行中请求配额全部用 `ctx.clientIp`；连接层（conn-guard）在解析之前，按 `peerIp` 走代理聚合池（§6.3）                                                                                                                                                                                                                                                                                                                                       |
| 配置校验            | `trustProxyFrom` 每项必须是 IPv4 字面量；`externalOrigins` 每项 `parseOrigin` 成功、**scheme 必须为 `https`**（`http://` ⇒ 原因 `origin-not-https`）、hostKey 的主机部分通过 `classifyHostToken`（允许 `fqdn`/`single-label`/`ipv4`/`dot-local`/`localhost`；`numeric`/`denylisted`/`ipv6` 拒绝）；两者必须同时非空或同时为空；settings 解析时非法项丢弃并列出（status：`忽略无效的 externalOrigins：http://hub.lan（origin-not-https）`），env 解析时 fail-closed `bad-config` |
| 审计 / status       | 每个 warning 类型每 60s 最多记一条日志（含 peerIp、不含头内容）；status 显示 `代理：受信任对端 127.0.0.1；对外 https://hub.example.com` 与「代理被攻破可伪造客户端 IP」的一行说明                                                                                                                                                                                                                                                                                               |

测试（LC `tests/web-hub/http/lan-proxy.test.ts` + `proxy.test.ts`，注入 remoteAddress）：非受信任对端带 `X-Forwarded-For: 1.2.3.4`、`X-Forwarded-Proto: https`、`X-Forwarded-Host: hub.example.com` ⇒ 全部忽略：限流按对端计数、Origin 必须是 `http://<Host>`、cookie 无 `Secure`、`Host: hub.example.com` 不在 `hostKeys` ⇒ 421；受信任对端：`XFP` 缺失 / `http` / `https, http` / `HTTPS`（最后一个通过）⇒ 前三者 400、第四者通过；`XFH: evil.example.com` ⇒ 421；`XFH: hub.example.com:443` 与 `XFH: hub.example.com` ⇒ 同一 origin 通过；`XFH: a, b`（多值）⇒ 400；XFH 缺失且 `Host: hub.example.com` ⇒ 通过，`Host: 192.168.31.25:7879` ⇒ 421（代理入口不查 hostKeys）；`XFF: 1.2.3.4, 192.168.31.10`（.10 受信任）⇒ `clientIp = 1.2.3.4`；`XFF: 192.168.31.10`（全部受信任）⇒ `clientIp = peerIp` + warning；`XFF: garbage` / `XFF: ::1` ⇒ `peerIp` + warning；两个 XFF 头 ⇒ 用最后一个；通过后 `Secure` cookie、`externalOrigin = https://hub.example.com`、`Origin: https://hub.example.com` 通过、`Origin: http://hub.example.com` 403；经代理创建的会话直连使用 ⇒ 401，直连会话经代理 ⇒ 401；**同主机双入口**：`extraHosts=hub.example.com` + `externalOrigins=https://hub.example.com`，直连 `http://hub.example.com:7879` 登录的 cookie 经代理发 ⇒ 401，反向 ⇒ 401（v6 #4）；直连伪造 `Host: hub.example.com` ⇒ 421；5 个客户端 IP 经同一代理各失败 6 次 ⇒ 各自被锁，第 6 个客户端 IP 正常登录；`trustProxyFrom` 非空而 `externalOrigins` 为空 ⇒ `bad-config`；`externalOrigins=http://hub.lan` ⇒ settings 丢弃 + warning、env `bad-config`（`origin-not-https`）。

### 2.5 请求流水线（LAN listener）

| 步骤 | 规则                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | conn-guard（TCP 层，按 `peerIp` 与池，§6.3）                                                                                                                                                                                                                                                                                 |
| 1    | `buildContext`：读一次快照 → `resolveProxy` → `canonicalHostKey`（失败 ⇒ 421）→ `RequestContext`                                                                                                                                                                                                                             |
| 2    | 白名单（§2.4）不通过 ⇒ 421 `E_HOST`（直连 IPv4 形态可能触发节流重算）                                                                                                                                                                                                                                                        |
| 3    | `GET /healthz`（无认证、无 IPC）⇒ `{ ok, version, authMode: "password", plaintext: scheme === "http" }`；非 `/api` 的 GET ⇒ 静态资源（无认证、**无 IPC**；`index.html` 经 `serveIndex` 注入 `data-auth-mode="password"`）                                                                                                    |
| 4    | `/api/*` ⇒ `Cache-Control: no-store`；POST ⇒ CSRF：`Content-Type: application/json` + `X-PWH: 1` + `Origin` 规范化后等于 `ctx.externalOrigin`；任一不满足 ⇒ 403 `E_CSRF`                                                                                                                                                     |
| 5    | `POST /api/login`（body ≤ 4 KiB，deadline 10s，§6.1）· `POST /api/logout` · `GET /api/session`；其它路由需要会话：每客户端 IP 进行中配额 → SSE 上限（仅 `/api/events`）→ `touchSession` 准入 + IPC（§4.2）→ `bound_origin === ctx.externalOrigin` ⇒ 否则 401 `E_AUTH`；准入拒绝 ⇒ 503 `E_BUSY` / 429；db 不可用 ⇒ 503 `E_DB` |
| 6    | 其它 body ≤ 64 KiB；`OPTIONS` ⇒ 404 且**不带**任何 `Access-Control-*` 头；token 发到 LAN 的 `/api/login` ⇒ 401（不区分原因）                                                                                                                                                                                                 |
| 7    | 安全头（CSP、XFO、nosniff、Referrer-Policy）与 P1 相同；**不发 HSTS**（由代理决定）                                                                                                                                                                                                                                          |

测试（LC `tests/web-hub/http/lan-host.test.ts`）：不在快照中的 Host ⇒ 421；IPv4 形态的 421 触发一次重算且 5s 内第二次不触发；在同一请求的两次读取之间注入 `swap` ⇒ 仍只用一份快照；Origin 缺失 / 不同 scheme / 异源 / 大小写不同的主机名 ⇒ 前三者 403、第四者通过；`lan.port = 80` 时不带端口的 Host 与 `Origin: http://myhost.local` 通过；纯数字主机名不在快照中且出现在 `omitted`；extraHosts 非法项在 env 解析中 ⇒ `bad-config`；`OPTIONS` 带 `Origin: http://evil` ⇒ 404 无 ACAO；静态资源 1000 次请求 ⇒ store spy 零调用。

---

## 3. LAN 生命周期（`hub/lifecycle.ts`、`hub/lan-controller.ts`）

```ts
// lifecycle.ts
export interface Scope {
  readonly signal: AbortSignal;
  timer(fn: () => void, ms: number, repeat?: boolean): void; // 一律 unref，dispose 时清除
  defer(fn: () => void | Promise<void>): void; // dispose 时逆序执行，单项上限 2s，出错只记日志
  child(): Scope;
  dispose(): Promise<void>; // abort → 清定时器 → 执行 defers；幂等
}
// lan-controller.ts
export const LAN_START_DEADLINE_MS = 30_000;
export interface LanController {
  start(): Promise<LanStatus>;
  status(): LanStatus;
  recompute(): void; // 节流；供 421 路径与 tick 调用
  close(): Promise<void>;
}
export function createLanController(deps: {
  cfg: HubLanConfig;
  transport: LanTransport;
  hosts: HostsPort;
  store: LanStorePort;
  onStatus: (s: LanStatus) => void;
  log: HubLog;
  now: () => number;
  scope: Scope;
}): LanController;
```

| 场景                | 语义                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`           | `mine = ++gen`，在子 scope 中运行；deadline 到 ⇒ `scope.dispose()`（abort ⇒ db 子进程被 SIGKILL）⇒ `off/timeout`                                                                                                                                                       |
| 迟到回调            | 每个 await 之后检查 `mine !== gen \|\| closed` ⇒ 丢弃结果；如果 `bind` 已经 resolve ⇒ 立刻 `handle.close()`；**不调用 onStatus**                                                                                                                                       |
| `close()`           | `closed = true; gen++` → 根 scope dispose → 关闭 handle（上限 2s）→ 查询子进程 SIGTERM，1s 后 SIGKILL；之后 `start`、`bind`、`onStatus` 全部变成 no-op                                                                                                                 |
| close 与 start 并发 | start 的每个检查点都会看到 `closed`；bind 使用 `scope.signal`，abort 之后 server 关闭、端口释放                                                                                                                                                                        |
| 前置条件（按顺序）  | `db-too-large` → 维护子进程执行 open、恢复、`quick_check`、迁移（§4.2，失败为 `sqlite-unavailable`、`db-invalid` 或 `db-timeout`）→ 查询子进程就绪 → 用户（初始密码）→ `hosts.compute()` → bind（端口占用 ⇒ `listen-failed`，不回落随机端口）。任何一步失败都不 listen |
| tick                | 60s：`recompute()`（§2.3）+ db 大小复查（§4.1）+ `purgeExpired`（§4.2）；每项都在 try/catch 中，出错只记日志                                                                                                                                                           |

测试（LD：`tests/web-hub/hub/lan-controller.test.ts`）：前置条件顺序；超时后迟到成功 ⇒ 不 bind、`off/timeout`、onStatus 没有收到 `on`；bind 已经 resolve 但 gen 已变 ⇒ handle 被关闭；close 与 start 并发 ⇒ 端口可以重新 bind、hub.json 中没有 `on`；close 之后 start 是 no-op；`recompute` 节流；集合不变时不 swap（spy）。

### 3.1 启动与关闭的整体上限；主线程文件系统调用的边界（评审 v6 #7）

hub 主线程上的文件系统调用**只**出现在三条非请求路径上，且全部是 `fs.promises`（libuv 线程池，不阻塞事件循环）：① **启动**——`ensurePrivateDir`（stateDir、socketDir）、singleton 的 lock / probe、`verifyBoundSocket`、§4.1 的 db 文件 `lstat` / 大小检查；② **bind**——LAN listener 之前没有额外 fs；③ **fence**——每 30s 一次 `verifyBoundSocket`（异步）。请求热路径（登录、SSE、API）不做任何 fs 调用；静态资源由 P1 的 `serveStatic` 用 `fs.promises` 读取（不变）。不引入额外子进程。

| 阶段                            | 上限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 超时后的行为                                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub 启动（P1 路径）             | `HUB_START_DEADLINE_MS = 20_000`：一个 `AbortController`（§1.4.2 的 `startup`）覆盖 ① 目录检查 → ④ `acquireSingleton`（其内部 probe / lock 等待本来就各有 ≤ 500ms×N 的上界）→ ⑤ `lanAssembly.build` → ⑥ loopback `listen` → ⑦ `hub.json`。**取消链**：signal 传给 `acquireSingleton`、`frontend.listen`、每个 fs 操作的 `withSignal`；abort 后每个 await 点立即 reject；**迟到结果自行清理**——迟到的 bind（`acquireSingleton` 内部）⇒ `verifyBoundSocket` 之前先查 `signal.aborted` ⇒ close server + 若 lstat 证明是自己刚 bind 的 socket 则 unlink，返回 `{kind:"failed", reason:"aborted"}`；迟到的 loopback `listen` ⇒ frontend 自己 `server.close()`；迟到的 `lanAssembly.build` ⇒ 其 scope 由 `rootScope.dispose()` 回收 | `startHub` reject `web-hub: start timeout`；已创建的资源逆序回收（§1.4.2 ⑧）；`main.ts` 退出码 1；agent 侧 spawn 观察者按既有超时记日志；**再次 `acquireSingleton(paths)` 必须能成为 owner**（guard / lock / socket 都已释放）                                              |
| LAN 启动                        | `LAN_START_DEADLINE_MS = 30_000`（§3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `off/timeout`，loopback 照常；status 文案见 §9.3                                                                                                                                                                                                                            |
| fence 单次检查                  | 5s（`verifyBoundSocket` 外层 `withDeadline`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 超时 / 非 `PrivateDirError` 的 I/O 错误 ⇒ `fenceLossOf(err) === "io"`：记日志、**不**立即 `onLost`；连续 3 次 `io` ⇒ `onLost("io")` 并 close（保守：宁可重启也不带着不确定的 socket 运行）；`PrivateDirError` 与 identity 不匹配 ⇒ 按 §1.3.2 的映射表**立即** `onLost(why)` |
| hub 关闭（信号 / idle / fence） | `HUB_CLOSE_DEADLINE_MS = 10_000`：§1.4.2 的 close 顺序（`lan.close` ≤2s → loopback ≤2s → `agentServer` ≤3s → `rootScope` ≤2s → `release` ≤2s）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 超时 ⇒ `log.error` 后 `process.exit(1)`                                                                                                                                                                                                                                     |
| hub 崩溃（`uncaughtException`） | **`STEP_DEADLINE_MS = 3_000` 保持**（crash 专用硬退出；与 10s 不统一）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 3s 后无论 `close("crash")` 进行到哪一步都 `process.exit(1)`；理由：进程状态已不可信，尽快让 agent 侧 respawn 比完整清理更重要；socket 路径由下一个 hub 的 singleton 流程回收（P1 已有的 stale 处理）                                                                        |

**零 hang 论证（文件系统部分）**：① 主线程没有同步 fs 调用（W1 之后 P1 遗留的只有 `log.ts` 的 `appendFileSync` 与 `hub.ts` 的 `writeHubJson`——都是对状态目录里小文件的追加 / 重命名，记入 §13 残余）；② 每个 `fs.promises` 调用都在某个带 deadline 的阶段之内，文件系统卡住时线程池线程被占住、但事件循环照常，deadline 定时器（unref）能触发并走到 `process.exit`；③ 启动超时 ⇒ LAN 不启用（或整个 hub 退出），status 报出原因，不会出现「半启动」状态；④ fence 的慢检查不误判为丢失，但连续失败仍会收敛到 close。

测试（W1 `startup-cancel.test.ts` / `singleton.test.ts`，LD `hub-lan.test.ts`）：注入永不 resolve 的 `fs.lstat` ⇒ `startHub` 在注入的 300ms deadline 后 reject，guard / lock / socket 已释放；注入**延迟 resolve**（deadline 之后才 resolve）的 `fs.lstat`、`frontend.listen`、`lanAssembly.build` 各一 ⇒ 同样 reject，且延迟结果到达后没有残留的 server / 文件（迟到的 bind 自我 unlink），再次 `acquireSingleton(paths)` ⇒ `owner`；注入慢 `lstat`（延迟 > 注入的 fence 单次 deadline）⇒ 前两次不 `onLost`、第三次 `onLost("io")`；`close()` 注入卡住的 `fe.close` ⇒ 在注入的整体 deadline 后 `process.exit` spy 被调用；`uncaughtException` 注入 ⇒ 3s（注入 100ms）后 `process.exit(1)` spy 被调用，即使 `close("crash")` 尚未完成。

---

## 4. SQLite（S1：`db.ts`、`db-client.ts`、`db-child.ts`、`lan-store.ts`；L19）

**主线程完全不导入 `node:sqlite`，也不打开 `DatabaseSync`。** 所有 SQLite 读写都在子进程中执行；主线程只和它们做异步 IPC，每个请求都带 deadline（timer unref）。主线程从不加载这个模块，也就不需要抑制 ExperimentalWarning；子进程用 `--disable-warning=ExperimentalWarning` 启动。

### 4.1 文件、PRAGMA、schema

| 项     | 规定                                                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件   | `<stateDir>/hub.db`，由维护子进程预建（`open(wx, 0o600)`；`-wal`/`-shm` 继承 0600）；主线程用 **`fs.promises.lstat`**（异步）检查 db、`-wal`、`-shm`：必须是普通文件、owner 为当前 uid、mode 0600（变宽 ⇒ chmod + warn；owner 不对 ⇒ `db-invalid`） |
| 大小   | 打开前：db > **64 MiB** 或 wal > **16 MiB** ⇒ `db-too-large`（fail-closed，不打开、不删除）；运行中由 60s tick 复查                                                                                                                                 |
| PRAGMA | 查询子进程：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`secure_delete=ON`、`wal_autocheckpoint=0`、`busy_timeout=200`；维护子进程：`busy_timeout = deadline − 500ms`                                                              |
| 并发   | 只有 hub 控制的两个子进程会打开：常驻的查询子进程（1 个）+ 短命的维护子进程（同时最多 1 个）；pi 进程从不打开；写操作放在 `BEGIN IMMEDIATE` 事务中                                                                                                  |
| 迁移   | `user_version`：0 ⇒ 建 v1；1 ⇒ 直接使用；大于 1 或结构不符 ⇒ `db-invalid`；全部在维护子进程中执行                                                                                                                                                   |
| 损坏   | fail-closed，不自动删库；status 提示把 `<path>` 移走后执行 `/webhub restart` 会重建                                                                                                                                                                 |

```sql
-- v1
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  kdf TEXT NOT NULL CHECK (kdf = 'scrypt'), n INTEGER NOT NULL, r INTEGER NOT NULL, p INTEGER NOT NULL,
  salt BLOB NOT NULL, hash BLOB NOT NULL, epoch INTEGER NOT NULL DEFAULT 1,
  initial_password TEXT, initial_created_at INTEGER, initial_login_at INTEGER, initial_login_ip TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE sessions (
  sid_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL, bound_origin TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, created_ip TEXT NOT NULL) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires_at);
```

### 4.2 子进程架构、会话校验、IPC 准入与 SSE 撤销（L19；评审 v4 #3、v5 #4、#5）

| 组件                           | 规定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 查询子进程（常驻）             | `spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", DB_QUERY_SCRIPT], { stdio: ["pipe","pipe","pipe"] })`；stdin/stdout 上走 NDJSON（`{id, op, args}` → `{id, ok, result \| code}`，单行 ≤ 64 KiB）；按顺序串行处理；op 只有小查询：`getUser`、`initialInfo`、`createSession`、`touchSession`、`deleteSession`、`deleteAllSessions`、`setPassword`、`markInitialLogin`、`purgeExpired`（`LIMIT 256`）                                                                                                                                                           |
| 维护子进程（短命）             | `execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", DB_MAINT_SCRIPT], { env: {PI_WEBHUB_DB_OP}, timeout, killSignal: "SIGKILL" })`；op：`open-check-migrate`（5s）、`checkpoint-passive`（3s，每 10 分钟一次）、`checkpoint-truncate`（3s，改密后与关闭时各一次）                                                                                                                                                                                                                                                                                            |
| deadline（主线程计时，unref）  | 查询 op **2s**（排队 + 执行合计；正常情况是毫秒级）；超时 ⇒ SIGKILL 查询子进程，**所有**在途请求立即以 `E_DB` 失败（HTTP 503）                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 崩溃 / 超时后的重启策略        | 子进程 `exit` ⇒ 在途与排队请求立即 reject；按 1s → 5s → 30s 退避重启；10 分钟内第 4 次失败 ⇒ LAN `off/db-unavailable`（关闭 LAN listener，fail-closed），需要 `/webhub restart`（L22）；重启期间 LAN 请求一律 503，从不挂起                                                                                                                                                                                                                                                                                                                                                          |
| **IPC 准入（`db-client.ts`）** | 三个槽位集合：**交互槽 64**（= 管道积压上界）+ **排队 ≤ 128**，超出 ⇒ 立即 reject `E_BUSY`（HTTP 503，`Retry-After: 1`），进入队列的请求受 2s 总 deadline 约束（最坏 2s，不掩盖）；**保留槽 1**（v6 #3）：只供 SSE 到期复核 tick 与 `purgeExpired` 使用，**不计入** 64，也不受交互队列影响——tick 的 32 条 touch 在保留槽上串行执行（正常 ≈ 32 × 1–3ms），交互洪泛打满 64 个槽时它照常进行；反过来 tick 也永远只占 1 个在途，不挤占交互槽。子进程串行处理 NDJSON，所以在途上限实际是 65。请求方 `req` 关闭（客户端断开）⇒ 对应 waiter 从队列移除（AbortSignal），结果丢弃             |
| **会话校验（无缓存）**         | 每个需要会话的请求（SSE 打开、subscribe、unsubscribe、history、`/api/session`、logout）都执行一次 `touchSession(sidHash, now)`：子进程 `SELECT … WHERE sid_hash=? AND expires_at>? AND absolute_expires_at>?`，命中则按需 `UPDATE … SET last_seen_at=?, expires_at=min(?+12h, absolute_expires_at) WHERE sid_hash=? AND last_seen_at < ?−60000`（60s 内不重复写），返回 `{userId, epoch, boundOrigin, expiresAt, absoluteExpiresAt}` 或 `null`；主线程再校验一次 `now < min(expiresAt, absoluteExpiresAt)` 与 `boundOrigin === ctx.externalOrigin`                                   |
| 同 sid 去重与配额              | 同一 `sidHash` 的并发 touch 合并为一个在途 IPC（promise map），但挂在它上面的 HTTP 响应 ≤ **8**（第 9 个 ⇒ 429 `E_RATE`，`Retry-After: 1`）；每客户端 IP 进行中的需会话请求 ≤ **16**（计数在路由前 +1、响应结束 −1，超出 ⇒ 429）；`/api/events` 在 IPC 之前先检查 SSE 上限（LAN 全局 32 / 每 sid 8，超出 ⇒ 429）；静态资源与 `/healthz` 从不触发 IPC（无 cookie 读取）                                                                                                                                                                                                               |
| **SSE 绑定与撤销**             | `SseClient` 增加 `auth?: { sidHash, userId, epoch }`（LAN 打开时写入）与 `revoked` 标记；`sse.revoke(pred)`：同步把匹配客户端标记 revoked（此后 `publish` 跳过它们）→ 写 `event: auth\ndata: {"reason":"revoked"}` → `res.end()`（单个 socket 抛错只记日志，不阻塞）。**登出**：`deleteSession` IPC 成功 → `revoke(c => c.auth.sidHash === sid)` → 返回 200；**改密**（admin passwd）：`setPassword` IPC 成功 → `lan.revoke({userId})` → 回复 `lan_res ok`。撤销都在响应之前完成                                                                                                     |
| SSE 到期复核                   | **55s** tick：对每条 LAN SSE 经**保留槽**依次 `touchSession`（≤ 32 条，串行；单条 2s deadline；整批 deadline 20s，超出则剩余留到下一个 tick 并记日志）；返回 `null` / epoch 不等 / `boundOrigin` 与打开时不等 ⇒ `revoke(…, "expired")`；IPC 失败或 `E_DB` ⇒ **保持连接**并记日志（不把「无法复核」当作撤销，也不放行任何新请求）；`verifiedAt` 更新。另有本地硬计时：打开时按 `absoluteExpiresAt` 设 unref 定时器（7d 上限），到点直接 `revoke("expired")`，不依赖 db。用户可见结论：**登出 / 改密：0 延迟；到期：页面最多再显示 ≤ 60s**（55s + 2s deadline + 调度抖动；Q-5 已接受） |
| 撤销的顺序                     | 登出：`deleteSession` IPC 成功后才 revoke、才返回 200；改密：`setPassword` 在**同一事务**中 `UPDATE users … epoch=epoch+1, initial_password=NULL` + `DELETE FROM sessions WHERE user_id=?`，成功后 revoke、再回复。子进程在 COMMIT 之后、回复之前崩溃 ⇒ 主线程收到 reject ⇒ 调用方得到 503 / `E_DB`、**不 revoke**，但 db 已是撤销后的状态：被撤销 cookie 的下一次请求 401，已开 SSE 最迟在下一个 55s tick 被关闭                                                                                                                                                                    |
| 登录路径                       | KDF 在主线程异步执行（libuv 线程池，不是 db 操作）；取用户和创建会话各一次 IPC（≈1–3ms，即 L19 接受的代价）                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 主线程的文件操作               | LAN 与 db 相关的文件检查全部用 `fs.promises`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

| 撤销 / 到期事件             | 新请求的最大残留                                                         | 已打开 SSE 的最大残留                                          |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 登出                        | 0：下一次带该 cookie 的请求即 401                                        | 0：响应 200 之前已关闭；子进程 COMMIT 后崩溃的极端情况 ⇒ ≤ 60s |
| 改密（epoch+1，删全部会话） | 0                                                                        | 0（同上极端情况 ⇒ ≤ 60s）                                      |
| 12h 滑动 / 7 天绝对到期     | 0：每个请求都按 db 中的 `expires_at` / `absolute_expires_at` 判定        | **≤ 60s**（§12 #22 验收；期间仍能收到事件——用户可见的接受项）  |
| db 不可用（超时 / 重启中）  | **不放宽**：所有需要会话的请求 503；不存在任何在没有 db 应答时放行的路径 | 保持连接（不误判为撤销）；db 恢复后下一个 tick 复核            |

**零 hang 论证**：① 主线程上不存在任何 SQLite 同步调用；② 每个 db 请求都受主线程上 2s（维护操作 3/5s）unref 定时器约束，到期 ⇒ SIGKILL；③ SIGKILL 对普通子进程总是有效，不会拖住 hub 的 `process.exit`；④ 重启有上限，达到上限就 fail-closed；⑤ IPC 管道积压 ≤ 64 KiB × 64 在途，排队 ≤ 128 个 promise，超出立即拒绝——内存与延迟都有上界；⑥ 低优先级通道不与交互请求竞争 64 个槽位。残余：`fs.promises` 调用落在 libuv 线程池中，磁盘卡住会占住线程池线程，但不会阻塞主线程。

### 4.3 测试（vitest，`hasNodeSqlite` 条件下 skipIf；集成测试 `sandboxHome()`）

| 测试                        | 做法                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 主线程从不加载 sqlite       | 在 hub 进程中启动完整 LAN 路径后，断言 `process.moduleLoadList` / `require.cache` 中没有 `node:sqlite`，并且全程没有 ExperimentalWarning                                                                                                                                                                                                   |
| **同步 I/O 卡住时仍然响应** | 测试专用 op `__block`（只有在 `PI_WEBHUB_DB_TEST=1` 时编译进脚本）让查询子进程执行 `Atomics.wait` 阻塞 10s ⇒ 发起一次会话校验：2s 后得到 503；在此期间 `/healthz` 延迟 < 50ms，`monitorEventLoopDelay` 的 p99 < 50ms；子进程被 SIGKILL 后重启，下一个请求成功                                                                              |
| **COMMIT 后立即崩溃**       | 测试 op `__crashAfterCommit` 令 `deleteSession` / `setPassword` 在 COMMIT 之后 `process.kill(process.pid, "SIGKILL")` ⇒ 调用方得到 503 / `E_DB`、SSE 未被 revoke；子进程重启后：登出的 cookie ⇒ 401；改密后所有旧 cookie ⇒ 401；伪造时钟推进 55s ⇒ 相关 SSE 收到 `auth{expired}` 并关闭                                                    |
| **准入与洪泛**              | 500 个并发 `/api/history`（有效 cookie，各不同 sid）⇒ 在途 ≤ 64、排队 ≤ 128、其余 **立即**（< 20ms）503 `E_BUSY`；排队者最坏 ≤ 2s；事件循环 p99 < 50ms；同一 sid 20 个并发 ⇒ 1 个在途 IPC（spy 子进程日志）、8 个挂起、12 个 429；同一客户端 IP 20 个并发（不同 sid）⇒ 16 个进入、4 个 429；客户端中途断开 ⇒ waiter 被移除（队列长度回落） |
| **tick 与洪泛并存**         | 32 条 LAN SSE + 持续 3 分钟的 history 洪泛（64 个交互槽始终满、队列始终 ≥ 100）+ 伪造时钟把其中 8 条会话推到 12h+1s ⇒ 这 8 条在**下一个 55s tick 内**（实测 < 60s）收到 `auth{expired}`；其余 24 条保持；spy 断言 tick 的 touch 都走保留槽、交互槽从未被 tick 占用；洪泛请求的 503 比例不因 tick 变化                                      |
| **SSE 撤销**                | 打开 SSE → logout ⇒ 在 200 返回之前收到 `auth{revoked}` 且流关闭；同 tick 内先 `publish` 再 `revoke` ⇒ 撤销后没有任何业务帧（录制流）；passwd ⇒ 该用户全部 SSE 关闭、其它用户不受影响；伪造时钟到 12h+1s ⇒ 下一个 55s tick 关闭（`expired`）；tick 期间 db 子进程被 kill ⇒ SSE 保持、日志一条；`boundOrigin` 变化（注入）⇒ 关闭            |
| 登出 / 改密 / 到期          | 登出后**立刻**（同一 tick 的下一个请求）401；改密后其它会话 401、新登录成功且 epoch=2；伪造时钟：11h59m 有活动 ⇒ 200 并续期，12h+1s 无活动 ⇒ 401；每 11h 活动一次到 7d+1s ⇒ 401（绝对上限不被滑动突破）                                                                                                                                    |
| db 不可用不放宽             | kill 查询子进程后、退避重启完成前：带有效 cookie 的 `/api/history` ⇒ 503 且 < 2.5s 返回；已打开的 SSE 继续收到 ping；重启完成后同一 cookie ⇒ 200                                                                                                                                                                                           |
| 静态与 healthz 无 IPC       | 1000 次 `GET /`、`/app.js`、`/healthz`（带与不带 cookie）⇒ store spy 零调用                                                                                                                                                                                                                                                                |
| 锁占用                      | 测试中另开一个 `sqlite3` 子进程执行 `BEGIN EXCLUSIVE` ⇒ 查询在 busy_timeout（200ms）后返回 BUSY ⇒ 503，而不是等满 2s                                                                                                                                                                                                                       |
| 崩溃上限                    | 对查询子进程发 `kill -9` ⇒ 在途请求立即 reject；10 分钟内连续 4 次 ⇒ `off/db-unavailable`，LAN 端口被关闭；`/webhub restart` 后恢复                                                                                                                                                                                                        |
| 超大库                      | 稀疏的 65 MiB db 或 17 MiB 的 wal ⇒ `db-too-large`，没有启动任何子进程（spy），文件原样保留                                                                                                                                                                                                                                                |
| checkpoint 卡住             | 占住锁 ⇒ 维护子进程的 open-check-migrate 在 deadline（测试注入 500ms）后被 SIGKILL ⇒ `off/db-timeout`；pid 不再存在；hub 的 close 不被拖过 deadline                                                                                                                                                                                        |
| 中断恢复                    | 在 `setPassword` COMMIT 之前 SIGKILL 查询子进程 ⇒ 旧状态完整；COMMIT 之后、checkpoint 之前 SIGKILL ⇒ 下一次启动 TRUNCATE 后是新状态，db/wal/shm 中 grep 不到旧明文                                                                                                                                                                         |
| 损坏                        | 垃圾文件、`user_version=99`、owner 不对 ⇒ `db-invalid`，文件保留                                                                                                                                                                                                                                                                           |
| touch 节流                  | 60s 内连续 100 次校验 ⇒ 只有 1 次 UPDATE（spy 子进程日志）；`expires_at` 不超过 `absolute_expires_at`                                                                                                                                                                                                                                      |

---

## 5. 密码、KDF 与初始密码

### 5.1 KDF（`hub/kdf.ts`）

| 项         | 规定                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 参数       | 新写入：`N=32768, r=8, p=1, keyLen=32, salt=16B`；`maxmem = 128·N·r + 1 MiB`                                                                                                                                   |
| 读取校验   | 全部是安全整数；N 为 2 的幂且在 2^14..2^16；r 在 1..16；p 在 1..2；`128·N·r ≤ 32 MiB`；salt 16..64B；hash 恰好 32B；`kdf==='scrypt'`。任一不满足 ⇒ `corrupt`（登录返回 E_AUTH，status 显示 `db-invalid: kdf`） |
| 池         | 并发 2，内存预算 **64 MiB**；槽位在 `try/finally` 中释放，release 幂等；排队由 §6.2 的准入队列负责                                                                                                             |
| 常量工作量 | 没有用户、用户名错、密码错，都恰好执行一次 KDF（没有用户时用 dummy 记录）；用户名比较用 `timingSafeEqual(sha256, sha256)`，结果按位与                                                                          |
| 密码约束   | 长度 10..256；hub 端再校验一次                                                                                                                                                                                 |

### 5.2 初始密码（L6：**用户接受的风险**；L17）

在用户第一次改密码之前，初始密码以明文存在 0600 的 `hub.db`（0700 目录）中，和 `token` 文件受到同等保护；按 §1，同 uid 进程本来就能读它。控制措施：

| 措施                   | 规定                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 展示                   | 明文只在 TUI 的 `/webhub status` 中显示（L14），通过 `ctx.ui.notify` 输出，不写入会话文件；rpc/print/json 模式下显示「（初始密码仅在 TUI 中显示）」，但「请尽快修改初始密码」的提醒照样显示                                                                                                                                                     |
| 传输                   | 只出现在 `lan_res{op:"info"}` 的响应里；hub 与 agent 两侧都不记录日志（§8.3 的审计日志只写 `initialPasswordReturned:true`）                                                                                                                                                                                                                     |
| 删除                   | `setPassword` 事务 ⇒ `initial_password=NULL` + `secure_delete` ⇒ **提交后立即**由维护子进程执行 `wal_checkpoint(TRUNCATE)`；失败则 warnings 中加 `initial-password-residue`，并在下一次启动时的恢复阶段优先执行 TRUNCATE                                                                                                                        |
| 提醒（只提醒、不过期） | 只要初始密码还在使用：TUI status 每次都显示「请尽快修改初始密码」；网页在**每次登录后和每次加载页面时**（`/api/session` 返回 `initialPasswordInUse:true`）显示提醒条；第一次有人用初始密码登录 ⇒ 审计日志 + status 中多一行事实性说明「已有设备（<ip>，<时间>）用初始密码登录过」；**任何时候都不会因此拒绝登录**，与生成时间、hub 是否重启无关 |
| 崩溃路径               | `uncaughtException` 的日志只写 `err.stack`；管理处理函数抛出的错误都是固定文案，不拼接输入；HubLog 包一层脱敏：字段名匹配 `/pass(word)?\|initial/i` 的值一律替换成 `[redacted]`                                                                                                                                                                 |

| 测试（LS / LD / LI） | 断言                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改密中断             | 见 §4.3 的「中断恢复」「COMMIT 后立即崩溃」                                                                                                                                                     |
| WAL 恢复             | 提交后 checkpoint 失败（注入）⇒ 重启 ⇒ 启动恢复阶段执行 TRUNCATE ⇒ 三个文件中都 grep 不到旧明文                                                                                                 |
| 提醒持续且不强制     | 伪造时钟到生成后 25h ⇒ 用初始密码登录成功、响应带 `initialPassword:true`；登录后再次加载页面 ⇒ 仍显示提醒；hub 重启后在网页登录 ⇒ 仍显示提醒；status 中仍有「请尽快修改初始密码」（LE、LF、LI） |
| 重启后不可读         | 改密 → 重启 hub → `lan_req info` 不再返回初始密码；db 中该字段为 NULL                                                                                                                           |
| socket / 日志        | 在 passwd、info 处理函数中注入异常（让 store 抛错）⇒ `hub.log` 中 grep 不到密码或初始密码；`lan_req` 从不进入 registry/bus（spy）；回显错误中不包含输入内容                                     |
| 会话文件             | 集成测试：在 TUI 模拟环境下执行 `/webhub status` 后，会话 jsonl 中 grep 不到初始密码                                                                                                            |

---

## 6. 登录、限流与资源上限

### 6.1 登录流水线

conn-guard（TCP 层，§6.3）→ `buildContext`（§2.5：快照、代理解析、canonical）→ 白名单 → CSRF（JSON + `X-PWH: 1` + `Origin` 规范化后等于 `ctx.externalOrigin`）→ body ≤ 4 KiB（deadline 10s）→ 饱和检查（§6.2：未见过的 `ctx.clientIp` 在饱和状态下直接 429）→ `limiter.admit(ctx.clientIp)`（每 IP 退避）→ KDF 准入（§6.2 的公平调度；取得席位的瞬间该 socket 进入 `login-pending`，§6.3）→ `kdf.run` → `finally` 释放 ticket 和槽位、socket 退出 `login-pending` → 成功：`createSession(bound_origin = ctx.externalOrigin, created_ip = ctx.clientIp)` + 设置 `pwh_lan` cookie（§6.4），socket 进入 `authed`；失败：`limiter.fail(ctx.clientIp)` 并返回 401 `E_AUTH`（不区分失败原因）。
**持有有效会话的请求完全不经过限流器**（但受 §4.2 的进行中配额约束）。

### 6.2 限流与公平调度（`ratelimit.ts` + `kdf-admission.ts`；没有任何基于 IP 的全局豁免；全部以 `ctx.clientIp` 计）

| 维度         | 规则                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 每 IP 退避   | 15 分钟窗口；免费失败次数 F（正常 5，收紧 1）；之后锁定 `base × 2^(k−F−1)`（正常 30s，收紧 60s），上限 15 分钟；成功只清零**该 IP**                                                                                                                                                                                                                                                                          |
| 全局失败计数 | 10 分钟窗口内 > 50 次 ⇒ 收紧模式；< 25 ⇒ 退出（滞回）                                                                                                                                                                                                                                                                                                                                                        |
| 污点记忆     | 失败过的 IP 进入 `tainted` 集合，保留 **24h**（`TAINT_CAP = 4096` 项，**满了不淘汰**）；成功登录会清除该 IP 的污点；**「新鲜」= 不在 tainted 中**                                                                                                                                                                                                                                                            |
| **饱和**     | `tainted.size ≥ TAINT_CAP` ⇒ 进入饱和：来自**未见过**地址（不在 tainted 中）的登录请求直接 429 `E_RATE`，`Retry-After: 60`，body `{error:"E_RATE", saturated:true}`；不写污点、不进任何队列。tainted 中的地址照常走 tainted 通道（受每 IP 退避约束）。条目按 24h TTL 过期后 `size < TAINT_CAP` ⇒ 自动解除；`/webhub unlock` 与 hub 重启立即清空。进入 / 退出饱和写审计，status warnings 带 `login-saturated` |
| KDF 令牌     | 正常 2/s（容量 10），收紧 0.5/s；KDF 并发 2（64 MiB）                                                                                                                                                                                                                                                                                                                                                        |
| 等待席位     | 每 IP 最多 **1** 个等待者；两个类别分开：`fresh` **4 个保留席位**，`tainted` 24 个；席位满 ⇒ 429，`Retry-After: 2`，并且**不给该 IP 记污点**（容量拒绝不算失败）                                                                                                                                                                                                                                             |
| 调度         | 有令牌时：两个类别都有等待者 ⇒ **交替**服务（fresh 至少拿到一半令牌），fresh 优先；类别内部按 IP **轮询**（每 IP 最多 1 个等待者，所以就是按到达顺序）；等待超过 20s ⇒ 429 `Retry-After: 2`（同样不记污点）                                                                                                                                                                                                  |
| 退避表       | 每 IP 退避表最多 4096 项，满了淘汰到期最早的条目；**从不因为退避表满而拒绝新 IP**（污点表是另一张表，见「饱和」）                                                                                                                                                                                                                                                                                            |
| 已登录会话   | 带有效 cookie 的请求完全不经过这里                                                                                                                                                                                                                                                                                                                                                                           |
| 恢复         | 令牌自动补充；滞回自动退出收紧模式；`/webhub unlock` 立即清空全部状态（退避、污点、队列、饱和）；hub 重启也会清空；loopback token 登录不受影响                                                                                                                                                                                                                                                               |

**合法新 IP 在持续洪泛下的最大等待上界**（收紧模式最坏情况，令牌率 r = 0.5/s，fresh 至少得到 r/2 = 0.25/s）：

- 只要合法 IP 拿到了 fresh 席位，前面最多有 3 个 fresh 等待者 ⇒ **等待 ≤ 4 / 0.25 = 16s**（在 20s 的等待上限之内）。
- 设 A = 攻击者手中**尚未进入污点表**的地址数。每个地址最多占用 fresh 席位一次：被服务后立刻入表 24h，污点表**不回收**，所以同一个地址不可能循环变回新鲜；攻击者最多能占住 fresh 席位 `A / 0.25 = 4A` 秒。
- A 的**硬上限是 `TAINT_CAP = 4096`**：污点表满即饱和，未见过的地址一律 429，攻击者再也拿不到 fresh 服务。于是上界 = **`4·min(A, 4096) + 16s`**。LAN 上 A 还受直连网段可用地址数约束（伪造源地址无法完成 TCP 握手）：/24 网段 A ≤ 254 ⇒ 最坏约 **1032s ≈ 17.2 分钟**（L21 接受）。经受信任代理时 A 受代理可见的客户端地址数约束；代理被攻破则 A 无界——这是 §1.1 列为可信的代价。
- **不存在与 A 无关的公平保证**：hub 无法区分合法新地址与攻击者新地址（除非引入 PoW / 带外凭据等新机制，不在范围内）。饱和后合法的**新**地址也无法登录，直到 TTL 过期或本机 `unlock`——这是有意的取舍：若改为让未见过的地址进入 tainted 通道，攻击者就能用同样的新地址占满 24 个 tainted 席位，重新打开无界洪泛面（§13）。`taintedCount` 只用于观测（status 收紧 / 饱和行、审计），不参与公平性。

测试（LC `kdf-admission.test.ts`、`ratelimit.test.ts`，伪造时钟 + 注入 remoteAddress / 代理头）：① 300 个攻击 IP 持续洪泛（429 后立即重试），这些 IP 已经被记污点 ⇒ 合法新 IP 在 ≤16s 内被服务；② 250 个**新鲜**攻击 IP 同时涌入 ⇒ 合法新 IP 的等待 ≤ 4A + 16s，并且攻击 IP 被服务之后都进入 tainted；③ fresh 与 tainted 都有等待者时，fresh 分到的令牌 ≥ 50%；④ 容量或超时导致的 429 不记污点；⑤ 每 IP 等待者 ≤ 1；⑥ 污点 24h 过期；⑦ IP 重用：曾经成功登录过的 IP 被另一台设备用来连续失败 ⇒ 正常退避与记污点（没有豁免）；⑧ `unlock` 清空一切（含饱和）；⑨ 已登录会话在洪泛期间请求全部返回 200；⑩ 4096 个不同 IP 各失败一次 ⇒ 第 4097 个未见过的 IP ⇒ 429 `saturated:true`，不进队列、不写污点、`tainted.size` 仍为 4096；⑪ 饱和时 fresh 队列中已有的等待者照常被服务；⑫ 饱和状态下已在污点表中的 IP 用正确密码登录成功（走 tainted 通道）并被清除污点；⑬ 伪造时钟推进 24h ⇒ 条目批量过期、饱和解除、新 IP 恢复 fresh 通道；⑭ 退避表 4096 满载时来了新 IP ⇒ 正常处理（淘汰到期最早的条目，不 429）；⑮ 饱和期间带有效会话的请求 200；⑯ 攻击者重复使用已入表地址 ⇒ 只走 tainted 通道且受每 IP 退避约束，不获得额外重试；⑰ 经受信任代理的 5 个客户端 IP 各失败 6 次 ⇒ 各自被锁、互不影响、代理对端 IP 本身不进退避表。

### 6.3 连接与资源上限（`conn-guard.ts`；评审 v4 #2、v5 #3）

conn-guard 工作在 TCP 层、HTTP 解析之前，只知道 `peerIp`；`peerIp ∈ trustProxyFrom` 的连接进入**代理池**，其它进入**直连池**。两个池各自有上限与淘汰，互不干扰：一个代理后面的恶意客户端最多耗尽代理池，直连用户不受影响；直连洪泛也淘汰不到代理池的连接。

| 项                                     | 直连池                                                                                                                                                    | 代理池（每个受信任对端）                         | 全局                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 总连接                                 | 每 IP 32                                                                                                                                                  | 每对端 128                                       | `maxConnections` 256（两池之和，含 authed）                                                            |
| 未认证连接（`unauth + login-pending`） | 池上限 **64**；每 IP 8（超限 ⇒ 直接 destroy 新连接）                                                                                                      | 池上限 **48**（每对端；> 30 保证恒有可淘汰对象） | —                                                                                                      |
| HTTP 超时                              | `headersTimeout 10s`、`requestTimeout 15s`、`keepAliveTimeout 5s`、socket 空闲 `timeout 60s`（SSE 每 15s ping）——两池相同，且在 `clientIp` 解析之前就生效 | 同                                               | —                                                                                                      |
| SSE                                    | —                                                                                                                                                         | —                                                | LAN 全局 32 / 每 sid 8（§4.2）                                                                         |
| KDF                                    | —                                                                                                                                                         | —                                                | 并发 2（64 MiB）+ 等待席位 fresh 4 / tainted 24 ⇒ `login-pending` ≤ **30**（按 `clientIp` 分配，§6.2） |
| body                                   | login ≤ 4 KiB，其它沿用 64 KiB                                                                                                                            | 同                                               | —                                                                                                      |

连接类别（每条 socket 一个状态；`connection` 事件时分配单调递增的 `seq` 作为唯一 tie-breaker；计数增减在 `connection` 与 `close` 事件里；所有 socket `unref()`）：

| 类别            | 进入                                                                                                                        | 可淘汰                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `unauth`        | accept 之后，尚无请求取得 KDF 席位、也没有出现过有效会话（含正在读 headers / body 的请求）                                  | 是                                   |
| `login-pending` | 该 socket 上的登录请求已取得 KDF 等待席位或运行槽（§6.2）；请求结束（成功、失败、429、异常）时回到 `unauth` 或升为 `authed` | **否**                               |
| `authed`        | 该 socket 上任一请求携带了有效会话                                                                                          | 否（只受总连接与每 IP / 每对端约束） |

淘汰规则（新连接到达时**所在池**的 `unauth + login-pending` 已达池上限）：① 直连池：存在未认证连接 ≥ 2 条的 IP ⇒ 取其中条数最多的 IP（同数取含最小 `seq` 者），淘汰它的 `unauth` 连接中 `seq` 最小的一条；代理池：跳过此级（池内只有一个对端 IP）；② 否则淘汰**该池**全局 `unauth` 连接中 `seq` 最小的一条；③ 该池 `unauth` 为空（理论上不可能：`login-pending ≤ 30 < 48 < 64`，两池各恒有可淘汰对象）⇒ destroy 新连接并 `log.warn`。淘汰 = `socket.destroy()`（无 HTTP 响应；空闲 keep-alive 连接被关闭对浏览器无感，正在发送请求的连接由前端按网络错误重试）。选择、计数、destroy、接纳都在同一个同步的 `connection` 处理块中完成，没有 await；`login-pending` 的进入点（取得席位）也在主线程同步执行，所以一个 socket 不可能在被选中淘汰的同一 tick 内获得席位。

HTTP 层第二道配额（§4.2，按 `ctx.clientIp`）：每客户端 IP 进行中的需会话请求 ≤ 16、每 sid ≤ 8、`login-pending` 每 IP ≤ 1——代理后面的客户端在 HTTP 层被逐个约束，连接层的聚合池只防「解析出 clientIp 之前」的慢连接与洪泛。

残余风险：攻击者以 ≥ 64 个地址每秒新建连接可以反复淘汰合法用户**尚未发出登录请求**的空闲连接（发出请求并取得席位后就受保护）；代理后面的恶意客户端能让同代理的其它用户的空闲连接被淘汰（发出请求后受保护，且 HTTP 层配额按客户端 IP）；影响都是前端多重试几次，不是锁死。

测试（`tests/web-hub/http/conn-guard.test.ts`，真实 socket，注入 remoteAddress）：64 个 IP 各 1 条空闲连接 ⇒ 第 65 个 IP 接入、`seq` 最小者被 destroy；30 条 `login-pending`（注入 KDF 阻塞）+ 34 条空闲 ⇒ 新连接淘汰空闲中最旧者，`login-pending` 全部存活；再来 34 条新连接 ⇒ 空闲全部被换掉、受保护的仍在；某 IP 5 条 + 59 个 IP 各 1 条 ⇒ 淘汰该 IP 最旧的一条；同一 IP 第 9 条 ⇒ 被 destroy、别人不受影响；被淘汰 socket 的 `close` 使计数减 1；取得席位与淘汰选择在同一 tick 的竞态（注入）⇒ 已取得席位的 socket 不被淘汰；慢连接（只 connect 不发请求）60s 后被关闭、只发半个请求头 10s 后被关闭（两池都测）；**代理池**：受信任对端 48 条空闲 + 第 49 条 ⇒ 淘汰最旧、直连池的连接一条不动；直连 64 条洪泛时代理池的空闲连接不被淘汰；受信任对端 129 条 ⇒ 第 129 条 destroy；`X-Forwarded-For` 不影响连接层计数。

### 6.4 会话与 cookie（评审 v4 #7、v5 #3、#7）

`pwh_lan=<32B b64url>; HttpOnly; SameSite=Strict; Path=/`，`ctx.scheme === "https"` 时追加 `; Secure`（同名 cookie，属性按创建它的请求决定；直连 http 下不能用 `Secure` 与 `__Host-` 前缀）；库中只存 `sha256(sid)`；12h 滑动、7 天绝对上限、绑定 epoch，**hub 重启后保留**（L7）；登出删除库中记录并同步关闭该会话的 SSE（§4.2）；loopback 的 `pwh_sid` 与 LAN 的 cookie、会话存储完全隔离。

**origin 绑定**：`createSession` 记录 `bound_origin = ctx.externalOrigin`（canonical，如 `http://192.168.31.25:7879`、`http://myhost.local`（80 端口）、`https://hub.example.com`）；每个需要会话的请求校验 `session.boundOrigin === ctx.externalOrigin`，不匹配 ⇒ 401，**不**删除会话、不写 db。浏览器本来就按 origin 隔离 cookie，所以合法用户无感（用 IP 登录后改用 `.local` 访问需要再登录一次）；服务端校验防的是把一个 origin 上拿到的 cookie 注入到另一个 origin 的请求里。

测试（LC `tests/web-hub/http/lan-hostbind.test.ts`）：在 `http://192.168.31.25:7879` 登录的 cookie 带到 `myhost.local:7879` ⇒ 401；反向 ⇒ 401；带到 `127.0.0.1:7879` ⇒ 401；同一 Host 大小写不同 ⇒ 200；`lan.port = 80` 时 `Host: myhost.local` 与 `Host: myhost.local:80` 规范化为同一 origin ⇒ 200；经代理（`https://hub.example.com`）创建的会话直连使用 ⇒ 401，直连会话经代理 ⇒ 401；**同主机名双入口**（`hub.example.com` 同时在 `extraHosts` 与 `externalOrigins`）：直连 `http://hub.example.com:7879` 的会话经代理 ⇒ 401、代理会话直连 ⇒ 401，两条会话在 db 中 `bound_origin` 分别为 `http://hub.example.com:7879` 与 `https://hub.example.com`；401 之后原 origin 上同一 cookie 仍 200（会话没有被删）；登出只删自己的会话。

---

## 7. HTTP 层

| listener | 绑定                     | 登录     | 白名单                                                                                       | Origin（POST）                                  | authMode（`index.html`）    |
| -------- | ------------------------ | -------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| loopback | `127.0.0.1:<port>`（P1） | token    | 不变（`127.0.0.1:<port>` / `localhost:<port>`）                                              | 有则必须同源（不变）                            | `data-auth-mode="token"`    |
| lan      | `0.0.0.0:<lan.port>`     | 用户密码 | 直连：`ctx.hostKey ∈ hostKeys`；经受信任代理：`ctx.externalOrigin ∈ externalOrigins`（§2.4） | **必须存在**，规范化后等于 `ctx.externalOrigin` | `data-auth-mode="password"` |

- `http.ts` 提供 `createLanTransport(frontendCtx)`（实现 `LanTransport`）：`node:http` server，`clientError` ⇒ destroy；server 与 socket 全部 unref；`allowHalfOpen:false`；每个请求先 `buildContext(req, "lan", handle.current())`。loopback 的请求也构造 `RequestContext`（`kind:"loopback"`，`clientIp = peerIp`，`scheme = "http"`），但 P1 路径的处理逻辑逐字节不变（只是把 `allowedHost` / `csrfOk` 的输入换成 ctx）。
- `static.ts` 新增 `serveIndex(res, { authMode })`：读取 `index.html` 后把 `data-auth-mode="__AUTH_MODE__"` 替换为字面 `token` / `password`（模板中只有这一个占位符，测试断言替换后不含 `__AUTH_MODE__`）；其它静态文件原样，缓存头不变。
- 端口占用 ⇒ `listen-failed`，不回落到随机端口（与 P1 的 loopback 行为不同，有意为之：LAN 端口要写进代理配置和防火墙规则）。
- `/healthz` 在 LAN 上返回 `{ ok, version, authMode: "password", plaintext: ctx.scheme === "http" }`（诊断用；前端不依赖）；`GET /api/session`（需要 cookie）返回 `{ username, initialPasswordInUse }`；安全头与 P1 相同；**不发 HSTS**（由代理决定）。
- `OPTIONS` 预检请求 ⇒ 404，**不带**任何 `Access-Control-*` 头。
- 静态资源与 SSE 与 loopback 使用同一套代码。

---

## 8. 控制面

### 8.1 帧

| 方向      | 帧                                                                                                                                        | 说明                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| hub→agent | `hello_ack.caps?: string[]`                                                                                                               | `ctl.v1`（hub 始终带）、`lan.v1`（收到 `config.lan` 时带）；只在 hub 装配了 admin 端口时输出（P1 的 agent-server 单测不受影响）；PROTO 保持 1.0 |
| agent→hub | `lan_req {rid, op:"info"}` · `{rid, op:"passwd", username, password}` · `{rid, op:"unlock"}`                                              | 只在 hello 之后接受；每个连接同时只处理 1 个请求；**不进 registry、bus 和普通日志**；按 §1 **不做**额外鉴权                                     |
| hub→agent | `lan_res {rid, ok:true, info?: {username, initialPassword?, initialLogin?: {ip, at}, lan: LanStatus}}` · `{rid, ok:false, code, message}` | `initialPassword` 只在 `op:"info"` 的响应里出现                                                                                                 |
| agent→hub | `hub_ctl {rid, op:"shutdown", reason:"restart"}` → `hub_ctl_ack {rid}`                                                                    | 先 ack，再执行 `close("restart")`                                                                                                               |

旧 hub 会忽略未知帧 ⇒ agent 先检查 `caps`，没有对应能力就直接判定「不支持」，不发请求。请求超时 3s（timer unref，连接关闭时统一 reject）。

### 8.2 `/webhub restart`（L4、L14）

| 情形                                                           | 行为                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub 在线且带 `ctl.v1`                                          | `hub_ctl shutdown` → 等 ack（≤2s）→ 等进程退出（≤5s）→ `respawnSoon()`                                                                                                                                                                                        |
| 管理帧无响应（hub 挂死），且 hub.json 带身份字段，平台为 Linux | 安全性校验：`/proc/<pid>/stat` 第 22 字段等于 `procStartTicks`、`/proc/<pid>/cmdline` 与 `hub.json.argv` 逐项相等（3 项、以 `jiti-cli.mjs` 和 `/src/web-hub/hub/main.ts` 结尾）、real/effective uid 等于当前 uid；发信号前重新读一次 starttime 比对 ⇒ SIGTERM |
| **P1 旧 hub**（hub.json 没有 `procStartTicks`/`argv`）         | **拒绝发信号**：「hub（pid N）是旧版本，无法安全确认身份。请执行 `ps -p N -o args=`，确认输出以 …/src/web-hub/hub/main.ts 结尾后手动 `kill N`（只需要这一次）；也可以等它空闲自动退出。」                                                                     |
| 非 Linux 且管理帧无响应                                        | 拒绝，给出同样的手动步骤                                                                                                                                                                                                                                      |

### 8.3 审计日志（L11）

hub 写入 `hub.log`：`{"audit":"admin","op":"info|passwd|unlock|shutdown","agentKey","agentPid","ok","code?","initialPasswordReturned?","username?"}`。`agentPid` 取自 hello 帧，属于自报信息，只用于追溯。审计日志**永远不**包含密码或初始密码；passwd 只记录用户名。LAN 侧还会审计：第一次用初始密码登录（ip）、进入和退出收紧模式、进入和退出饱和、`unlock`。

---

## 9. 配置与状态

### 9.1 settings（`webHub.lan.*`，non-live）

| 键                           | 默认    | 说明                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webHub.lan.enabled`         | `false` |                                                                                                                                                                                                                                                                                                                       |
| `webHub.lan.port`            | `7879`  | 1..65535，且不等于 `webHub.port`                                                                                                                                                                                                                                                                                      |
| `webHub.lan.extraHosts`      | `""`    | 逗号分隔的主机名 / IPv4；按 `classifyHostToken` 校验（L16）；非法项进入 `invalidExtraHosts: InvalidHostToken[]`（status 列出）                                                                                                                                                                                        |
| `webHub.lan.trustProxyFrom`  | `""`    | 逗号分隔的 IPv4 字面量（如 `127.0.0.1` 或 `127.0.0.1, 192.168.31.10`）；只有来自这些对端的 `X-Forwarded-*` 被采信（L24）                                                                                                                                                                                              |
| `webHub.lan.externalOrigins` | `""`    | 逗号分隔的 **https** origin（如 `https://hub.example.com`、`https://hub.home.arpa:8443`）；`http://` 一律拒绝（`origin-not-https`，status 提示）；经受信任代理的请求只接受这些 origin；与 `trustProxyFrom` 必须同时非空或同时为空，否则 settings 解析记 warning 并**把两者都当作空**（fail-closed，不采信任何转发头） |

`HubLanConfig = { port; extraHosts: string[]; trustProxyFrom: string[]; externalOrigins: string[] }`（§1.4.1），经 `PI_WEBHUB_CONFIG.lan` 传给 hub（hub 不读 pi 设置文件，arch §13.3）；`main.ts` 的 `parseHubLanConfig` 对四个字段再校验一次，任一项非法 ⇒ `off/bad-config`（detail 含 `字段[下标]=值: 原因`，原因用 `HostTokenRejectReason` 或 `origin-syntax` / `origin-not-https` / `proxy-config-mismatch`）。

### 9.2 `LanStatus` / `LanOffReason`

```ts
export type LanOffReason =
  | "sqlite-unavailable"
  | "db-too-large"
  | "db-timeout"
  | "db-invalid"
  | "db-unavailable"
  | "listen-failed"
  | "bad-config"
  | "timeout";
export type LanStatus =
  | { state: "starting" }
  | {
      state: "on";
      port: number;
      hosts: string[]; // 直连白名单的主机部分（不含端口），IPv4 优先、其后名字
      omitted: { host: string; reason: HostTokenRejectReason }[];
      proxy?: { trustedFrom: string[]; externalOrigins: string[] }; // 只在配置了代理时存在
      warnings: string[];
    }
  | { state: "off"; reason: LanOffReason; detail?: string };
```

写入 `hub.json.lan`，不含任何机密。`warnings` 的取值：`db-checkpoint-failed`、`initial-password-in-use`、`initial-password-residue`、`hostname-omitted:<HostTokenRejectReason>`、`invalid-extra-host:<token>:<reason>`、`db-restarting`、`login-tightened`、`login-saturated`、`proxy-xff-warnings`（60s 内出现过 §2.4 的解析告警）、`plaintext`（恒有，提醒直连为 HTTP 明文）。

### 9.3 `/webhub` 子命令与状态文案

| 子命令    | 行为                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`  | P1 那一行不变；设置里开了 LAN 时再加 `lan …` 行（取自 hub.json.lan）；在 TUI 下另外显示初始密码行（取自 `lan_req info`）                     |
| `open`    | 仍然打开 loopback 的 token URL；LAN 为 on 时再显示直连 URL 列表与（如有）对外 origin                                                         |
| `passwd`  | 仅 TUI，且 hub 必须带 `lan.v1` 能力；用户名 → 掩码输入密码两次 → `lan_req passwd` → 「已更新；已有局域网会话与页面全部失效；初始密码已删除」 |
| `unlock`  | `lan_req unlock` → 「已清空登录限流；收紧 / 饱和状态已解除」                                                                                 |
| `restart` | §8.2                                                                                                                                         |

| 情形                                        | 文案                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| on                                          | `lan=on http://192.168.31.25:7879/ (+N 个地址，/webhub open 查看)  ⚠ 直连为 HTTP 明文：密码与会话在局域网上未加密`；如有 `omitted`、`proxy`、`warnings`，各占一行                                     |
| 代理                                        | `代理：采信 127.0.0.1 的 X-Forwarded-*；对外 https://hub.example.com。注意：受信任代理若失陷，该入口的所有会话（密码、cookie、客户端地址）都随之失陷，且可绕过每 IP 限流。`                           |
| 初始密码（仅 TUI）                          | `初始密码：abcde-fghij-kmnpq-rstuv（用户 alice；请尽快执行 /webhub passwd 修改，修改后不再显示）`；rpc/print 下显示 `（初始密码仅在 TUI 中显示）请尽快修改初始密码。`                                 |
| 初始密码仍在使用（持续提醒，L17）           | `请尽快修改初始密码：在本机执行 /webhub passwd。`；如果已经有人用它登录过，再加一行 `已有设备（192.168.31.40，2026-09-26 21:03）用初始密码登录过。`（不会限制登录）                                   |
| 主机名 `numeric`                            | `提示：主机名「202507220006」是纯数字，浏览器会把它当作数值地址、无法用它访问，未纳入白名单。请用 IP 或 202507220006.local 访问。`                                                                    |
| 主机名 `denylisted` / `syntax` / `too-long` | `提示：主机名「dev」与常见顶级域同名（denylisted），未纳入白名单。请用 IP 或 dev.local 访问，或在 webHub.lan.extraHosts 中显式添加。` · `提示：主机名「a_b」不是合法主机名（syntax），未纳入白名单。` |
| extraHosts / 代理配置非法项                 | `忽略无效的 extraHosts：foo_bar（syntax）、dev（denylisted）、202507220006（numeric）。` · `忽略代理配置：trustProxyFrom 与 externalOrigins 必须同时设置。`                                           |
| 收紧 / 饱和                                 | `登录限流：收紧模式（10 分钟内 N 次失败，M 个地址）。` · 红字 `登录限流：饱和——24h 内失败地址已达 4096，来自新地址的登录被拒绝；执行 /webhub unlock 解除。`                                           |
| off/sqlite-unavailable                      | `未开启：当前运行时没有 node:sqlite（需要 Node ≥22.13）。`                                                                                                                                            |
| off/db-invalid                              | `未开启：hub.db 无法使用（<detail>）。把 <path> 移走后执行 /webhub restart 会重建（生成新的初始密码，旧会话失效）。`                                                                                  |
| off/db-unavailable                          | `未开启：数据库子进程在 10 分钟内连续失败 4 次，局域网入口已关闭。详见 hub.log；执行 /webhub restart 重试。`                                                                                          |
| off/db-too-large · db-timeout               | `未开启：hub.db 异常大（<size>），为了避免挂起没有打开它。请检查 <path>。` · `未开启：数据库检查超时（5s），详见 hub.log。`                                                                           |
| off/listen-failed · timeout · bad-config    | `未开启：端口 <port> 监听失败（<errno>），请修改 webHub.lan.port。` · `未开启：局域网入口启动超时（30s），详见 hub.log。` · `未开启：hub 收到的 LAN 配置无效（<detail>）。`                           |
| 设置开、hub.json 中没有 `lan`               | `未生效：当前 hub（pid N）以仅本机模式运行（由其它 pi 进程或旧版本拉起）。执行 /webhub restart。`                                                                                                     |
| 设置关、hub 的 lan=on                       | `注意：设置已关闭 LAN，但当前 hub 仍在局域网监听。执行 /webhub restart。`                                                                                                                             |
| restart：旧 hub                             | 见 §8.2                                                                                                                                                                                               |

---

## 10. 前端（`src/web-hub/web/**`，LF；评审 #2）

| 项                    | 规定                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模式来源              | `mountApp` 读 `doc.documentElement.dataset.authMode`：`"token"` ⇒ P1 行为；`"password"` ⇒ 密码模式；**其它任何值或缺失 ⇒ 错误模式**：显示 `Cannot determine sign-in mode (stale page?). Reload.`，不读 `#t=`、不读 localStorage、不发任何 `/api/login`、不打开 SSE。**不**用 `/healthz` 探测，**不**按 `location` 猜测，**没有**回退到 token 的路径                     |
| token 只在 token 模式 | `readHashToken` 与 `storage.getItem(TOKEN_KEY)` 只在 `authMode === "token"` 时调用；password 模式启动时若地址栏有 `#t=` ⇒ 只做 `replaceState` 清掉、不发送；测试用 spy 断言 password 模式下 `fetch(API.login)` 的 body 从不含 `token` 字段                                                                                                                              |
| 表单                  | `index.html` 中静态写 `<html data-auth-mode="__AUTH_MODE__">` 与 `<form id="login" hidden>`：username（`autocomplete="username"`）、password（`type=password`，`autocomplete="current-password"`）、提交按钮、`<p id="login-error" role="alert">`；`render/login.js` 只操作 `hidden`、`disabled`、`textContent`（**仍然禁止 innerHTML**）                               |
| 流程                  | password 模式：SSE 返回 401 或流 CLOSED ⇒ 显示表单；收到 `event: auth`（`revoked` / `expired`）⇒ 关闭流、清空状态、显示表单并提示 `Signed out on another tab or by the host.` / `Session expired — please sign in again.`；登录成功后清空密码框并重开流；**密码不写入 localStorage**，`reloginOnce` 恒为 false                                                          |
| 错误文案              | 401 `Invalid username or password.` · 429 `Too many attempts. Try again in N s.`（按 Retry-After 倒计时）· 429 且 `saturated:true` ⇒ `Sign-in from new addresses is temporarily blocked. Ask the host to run "/webhub unlock".`（不自动重试）· 429 `E_RATE`（进行中配额）⇒ `Too many requests, retrying…` · 503 `Hub is busy, retrying…` · 网络错误 `Cannot reach hub.` |
| 503 / E_BUSY 的处理   | **不是**认证失败：不清 cookie、不显示登录表单；按 `Retry-After`（缺省 2s）自动重试最多 5 次，之后显示 `Hub database unavailable — retry` 按钮；SSE 流在 503 时按现有的重连退避处理（客户端 `onConn` 不走 `"auth"` 分支）                                                                                                                                                |
| 明文提示              | 表单上方的静态文字，仅 `location.protocol === "http:"` 时显示（这里用 `location` 只决定一行提示文案，不决定认证方式）：`This page is served over plain HTTP: your password and session travel unencrypted on this network.`                                                                                                                                             |
| 初始密码              | login 响应带 `initialPassword:true`，或 `/api/session` 返回 `initialPasswordInUse:true`（每次加载页面都会查询）⇒ 显示持续提醒条 `Please change the initial password soon (run "/webhub passwd" on the host).`；不影响任何功能                                                                                                                                           |
| 排队等待              | login 请求超时放宽到 25s；收到普通 429 ⇒ 显示 `Hub is busy, retrying in N s…` 并按 Retry-After 自动重试，直到用户取消                                                                                                                                                                                                                                                   |
| 421                   | 不重试；显示 `This address is not on the hub's allow-list. Use one of the addresses shown by "/webhub open".`                                                                                                                                                                                                                                                           |
| 登出                  | topbar 上的 `Sign out`（仅 password 模式）；成功后本页面的 SSE 已被服务端关闭，前端直接显示表单                                                                                                                                                                                                                                                                         |

---

## 11. 包拆分

### S1-W1 · IF 接口包（串行；**W1 通过前其它任何包不得开工**）

用户决定 v8 之后不再做文档复审：**W1 把 §1.3、§1.4、§3.1 冻结的全部接口写成代码**（类型 + 纯函数实现 + 桩 + 契约测试），由评审员审代码、`npm run typecheck` 兜底；通过后 W2 各包并行施工，各包只允许**填实**桩、不得改签名（改签名 = 回到 W1 重审）。

| 项                                                          | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件域                                                      | `src/web-hub/protocol/{lan,messages,paths,http-contract}.ts`、`src/web-hub/web/contract.js`、`src/web-hub/hub/{ports,lifecycle,lan-assembly,hub-json,hub,main,singleton,sse}.ts`、`src/web-hub/hub/http.ts`（只加 `listen(opts)` 与 `buildContext` 的 loopback 分支）、既有测试按 §1.3.4（`tests/web-hub/protocol/paths.test.ts`、`tests/web-hub/hub/singleton.test.ts`、`tests/web-hub/http/helpers.ts`、`tests/web-hub/agent/helpers.ts`）、新增 `tests/web-hub/helpers/paths.ts`、`tests/web-hub/contract/**`（见「契约测试」）、`tests/web-hub/protocol/{lan,messages-lan}.test.ts`、`tests/web-hub/hub/{hub-json,startup-cancel,lifecycle}.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 落地清单 A：类型（只声明）                                  | `protocol/paths.ts`：`DirPolicy`、`DirIdentity`、`SocketIdentity`、`PrivateDirReason`、`PrivateDirError`、`FsDeps`、`HubPaths`（+`socketDir`、`policies`、`dbFile`）；`protocol/lan.ts`：`HostTokenKind`、`HostTokenRejectReason`、`HostTokenResult`、`InvalidHostToken`；`protocol/http-contract.ts`：`SSE_EVENTS` 加 `"auth"`、`SseAuthPayload = { reason: "revoked" \| "expired" }`、`API_ERRORS` 加 `"E_BUSY"`、`"E_DB"`；`web/contract.js`：`SSE_EVENTS` 同步加 `"auth"`、`API_ERRORS` 同步；`protocol/messages.ts`：`lan_req` / `lan_res` / `hub_ctl` / `hub_ctl_ack` 帧 schema 与 `hello_ack.caps?`；`hub/ports.ts`：§1.4.1 全部（`ListenerKind`、`HubLanConfig`、`HubConfig.lan`、`RequestContext`、`LanFrontendDeps`、`FrontendDeps.lan`、`LanFacade`、`LanAssembly`、`HttpFrontend.lan` + `listen(opts?: { signal?: AbortSignal })`）+ §2.3（`HostSnapshot`、`LanListenerHandle`、`LanTransport`、`HostsPort`）+ §4（`LanStorePort`）+ §5.1（`KdfPort`）+ §6.2（`LoginLimiterPort`、`KdfAdmissionPort`）+ §9.2（`LanStatus`、`LanOffReason`）；`hub/singleton.ts`：`SingletonResult`（`identity`、`reason` 含 `"aborted"`）、`SingletonDeps`（`fs`、`signal`）、`FenceLoss`（含 `"io"`）；`hub/hub.ts`：`StartHubDeps`（含 `lanConfigError`）、`RunningHub`（`identity`、`lan?`、`lanStatus()`）、`HUB_START_DEADLINE_MS`、`HUB_CLOSE_DEADLINE_MS`；`hub/hub-json.ts`：`HubRecord`、`HubJsonWriter`；`hub/lifecycle.ts`：`Scope`；`hub/sse.ts`：`SseClient.auth?`/`revoked?`、`SseHub.revoke`/`list`、`attach` 第 4 参数 |
| 落地清单 B：完整实现（纯函数 / 小组件，W1 即最终）          | `classifyHostToken`、`SINGLE_LABEL_DENYLIST`（不含 localhost）、`canonicalHostKey`、`canonicalOrigin`、`parseOrigin`、`hostKey`；`resolveHubPaths`（`socketDir` + `policies` 三常量）；`parseHubLanConfig`（main.ts，导出）；帧 schema 的编解码与拒绝；`createHubJsonWriter`；`createScope`（§3）；`fenceLossOf`；`withSignal`；`startHub` 的启动取消链与 `close` 顺序（§1.4.2；LAN 相关分支在 `fe.lan === undefined` 时不执行）；`acquireSingleton` 的 `signal` 处理与 `identity`（用 `lstat` 取 `{dev,ino}`，**不含** LP 的 policy 强制与 `verifyBoundSocket` 的 symlink/属主校验——那是 LP）；`startFence(path, identity, onLost(why), …, deps)` 的签名与 `io` 计数（校验函数先用「lstat 非 symlink + dev/ino 相等」的最小实现，LP 替换为 `verifyBoundSocket`）；`ensurePrivateDir(dir, policy, deps)` 异步化并保持 P1 行为（`STATE_DIR_POLICY` 语义；其它两个 policy 的强制由 LP 填实）；`sse.ts` 的 `revoke` / `list` / `auth` 字段（≈30 行，W1 即最终）；`http.ts` 的 `listen({signal})` 与 `buildContext(req, "loopback")`（loopback 分支：把现有 `allowedHost` / `csrfOk` 的输入集中到 ctx，判定逻辑逐字节不变）                                                                                                                                                                                                                                                                                                                                                                                                            |
| 落地清单 C：桩（抛 `E_NOT_IMPLEMENTED:<包>`，由对应包填实） | `lan-assembly.ts` `defaultLanAssembly.build` ⇒ `LD`；`http.ts` `buildContext(req, "lan", …)` 与 `createLanTransport` ⇒ `LC`；`paths.ts` 中 `XDG_SOCKET_DIR_POLICY` / `TMP_SOCKET_DIR_POLICY` 的强制分支与 `verifyBoundSocket` ⇒ `LP`（W1 的 `verifyBoundSocket` 只做 lstat + dev/ino 比对；symlink / 属主 / sticky 校验抛 `E_NOT_IMPLEMENTED:LP`——**注意**这意味着 W1 合入前 LP 的安全修复尚未生效，与 v7 之前「S0 先合」不同，见 §16 Q-2）；`ports.ts` 的端口类型没有桩（纯类型）；`LanStorePort` / `KdfPort` / `LoginLimiterPort` / `KdfAdmissionPort` / `HostsPort` 的 W1 假件只存在于 `tests/web-hub/contract/fakes.ts`（供 W2 各包的测试复用），不进 `src/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| typecheck                                                   | `npm run typecheck` 全绿是 W1 的合入门槛之一；额外的编译期契约测试 `tests/web-hub/contract/types.test-d.ts`（vitest `expectTypeOf`）：P1 形态的 `FrontendDeps`（无 `lan`）可赋给新类型；`HubConfig` 无 `lan` 可赋；`RunningHub` 新字段为可选或函数；`SseEventName` 包含 `"auth"`；`HostTokenResult` 的 `ok:false` 分支 `reason` 恰为五个字面量；`FenceLoss` 恰为七个字面量；`SingletonResult.failed.reason` 包含 `"aborted"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 契约测试（`tests/web-hub/contract/**` + 上列新增测试）      | ① `stubs.test.ts`：每个桩被调用时抛 `E_NOT_IMPLEMENTED:<包>`，错误消息含包名（W2 填实后该用例必须被对应包**删除**，否则说明桩未替换）；② `lan.test.ts`：§2.1 全分类表 + 分类优先级 + §2.2 规范化用例；③ `paths.test.ts`（既有，按 §1.3.4 改）+ `policies` 快照；④ `messages-lan.test.ts`：帧往返与拒绝；⑤ `contract.test.ts`（既有 mirror 测试自动覆盖 `auth` 与新 API_ERRORS）；⑥ `hub-json.test.ts`：`write` 一次 + `patchLan` 合并 + `removeIfOurs` 只删自己 pid 的文件 + 写失败只记日志；⑦ `startup-cancel.test.ts`：注入永不 resolve / 延迟 resolve 的 `fs.lstat`、延迟的 `frontend.listen`、延迟的 `lanAssembly.build`（各一）⇒ `startHub` 在注入的 deadline 后 reject `start timeout`；**延迟结果 resolve 之后**，`acquireSingleton(paths)` 再次调用必须返回 `owner`（socket / lock / guard 都已释放，迟到的 bind 已自我清理）；`process.exit` 未被调用；⑧ `lifecycle.test.ts`：`Scope` 的 timer unref、defer 逆序、dispose 幂等；⑨ `singleton.test.ts`（既有，按 §1.3.4 改）+ `startFence` 的 `why` 断言 + 注入 3 次超时 ⇒ `onLost("io")`、2 次超时 + 1 次成功 ⇒ 不触发；⑩ `sse.test.ts` 追加：`attach(…, auth)` / `revoke(pred, reason)` 先停 publish 再发 `auth` 帧再 end、`list()`；⑪ `hub-lan-config.test.ts`：`deps.lanConfigError` ⇒ hub.json.lan 为 `off/bad-config` 且 `fe.lan === undefined`；`config.lan` 合法但 `lanAssembly` 是桩 ⇒ `startHub` reject `E_NOT_IMPLEMENTED:LD` 并完成清理                                                                                                                        |
| 合入门槛                                                    | 四件套全绿 + 评审员代码评审通过（评审对象：签名与 §1.3 / §1.4 / §3.1 逐条一致、桩清单完整、契约测试覆盖上表 ①–⑪）。通过后 W2 开工；W2 期间任何包发现签名需要改动 ⇒ 停下该包，改 W1 文件并重新过 typecheck + 契约测试，再继续                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### S1-W2（LP ∥ LS ∥ LC ∥ LE ∥ LF）

| 包             | 文件域                                                                                                                                                                                                                                                                                                                                | 新增 / 修改的测试要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LP** P1 硬化 | `src/web-hub/protocol/paths.ts`（policy 强制 + `verifyBoundSocket` 填实）、`src/web-hub/hub/singleton.ts`（bind 后 `verifyBoundSocket`、fence 用同一函数、release 的 lstat 比对）、`tests/web-hub/protocol/paths-private-dir.test.ts`、`tests/web-hub/hub/singleton-hardening.test.ts`、`tests/integration/web-hub-hardening.test.ts` | §1.3 的行为部分（§1.3.5 迁移测试全部）；删除 `stubs.test.ts` 中 LP 的桩用例；`main.ts` 的 `umask` 已由 W1 落地；不改 `hub.ts`（调用链在 W1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **LS** store   | `src/web-hub/hub/{db,db-client,db-child,kdf,lan-store}.ts`、`tests/web-hub/hub/{db,db-client,db-child,kdf,lan-store}.test.ts`                                                                                                                                                                                                         | §4.3 全部（含「准入与洪泛」「tick 与洪泛并存」「COMMIT 后立即崩溃」「db 不可用不放宽」「touch 节流」）；`db-client` 的两条通道、去重、AbortSignal 回收；§5.2 表；查询与维护脚本的每个 op；重启退避与 10 分钟内 4 次的上限；`LanStorePort` 全部是异步接口；测试钩子（`__block`、`__crashAfterCommit`）只在 `PI_WEBHUB_DB_TEST=1` 时编译进脚本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **LC** http    | `src/web-hub/hub/{http,auth,lan-auth,proxy,ratelimit,kdf-admission,conn-guard,net-hosts,sse,static}.ts`、`tests/web-hub/http/lan-*.test.ts`、`tests/web-hub/http/lan-helpers.ts`、`tests/web-hub/http/{ratelimit,kdf-admission,conn-guard,proxy}.test.ts`、`tests/web-hub/hub/net-hosts.test.ts`                                      | `buildContext` 与 §2.5 的流水线；§2.2 规范化用例；§2.4 代理测试（`lan-proxy.test.ts` + `proxy.test.ts` 纯函数）；§6.2 的 ①–⑰；§6.3 的两池 conn-guard 测试；§6.4 的 origin 绑定测试；`sse.revoke` 与 `auth` 事件（§4.2「SSE 撤销」中属于 http 层的部分，用假 store）；`serveIndex` 注入 `data-auth-mode` 且不含占位符、其它静态文件字节不变；每客户端 IP 进行中配额 16 / 每 sid 8 / SSE 上限先于 IPC（spy）；静态与 healthz 零 IPC；login 途中 store 抛异常 ⇒ ticket 与 KDF 槽位都被释放、socket 退出 `login-pending`；每 IP 退避序列 30/60/120s 与 Retry-After；cookie 属性（直连无 `Secure`、代理 https 有 `Secure`）；无 HSTS；`net-hosts`：接口枚举、纯数字主机名进 `omitted`、`.local` 生成、extraHosts 合并、`externalOrigins` 不进 `hostKeys`、集合相等判定；自动化跨源；多地址耗尽（300 个 IP × 6 次失败）⇒ 收紧模式、KDF 并发 ≤ 2、等待队列 ≤ 28、每 IP 等待者 ≤ 1；`unlock` 后立即退出收紧；滞回退出；P1 `tests/web-hub/http/**` 全绿不改 |
| **LE** agent   | `src/web-hub/agent/{index,connection,lan-status,passwd-prompt,restart,proc-identity}.ts`、`tests/web-hub/agent/{lan-status,passwd-prompt,restart,proc-identity,connection-admin,wiring-lan}.test.ts`                                                                                                                                  | `request()` 超时 3s、连接关闭时全部 reject、没有 cap 时不发送；掩码组件从不渲染明文；status 文案逐行覆盖（含明文提示、`numeric`、代理行、饱和）；lan 关闭时 spawn 的 env 与 P1 深相等；`PI_WEBHUB_CONFIG.lan` 的序列化含四个字段；旧 hub ⇒ §8.2 文案且**不调用** `process.kill`；ctl 路径不读 `/proc`；挂死 hub + 身份字段齐全 ⇒ SIGTERM；PID 复用、相似路径、检查之后被替换、uid 不符 ⇒ 拒绝；非 TUI 不显示初始密码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **LF** web     | `src/web-hub/web/**`、`tests/web-hub/web/{login,client-password,auth-mode}.test.ts`                                                                                                                                                                                                                                                   | §10 全部：`data-auth-mode` 三态（token / password / 缺失 ⇒ 错误模式，不发凭据）；password 模式下 `#t=` 只被清掉、`fetch(API.login)` body 从不含 `token`（spy）；`event: auth` 处理；401 或 CLOSED ⇒ 表单；成功 ⇒ 重开流、密码框清空；401/429（倒计时）/429 saturated（不重试）/429 E_RATE（重试）/503（重试 5 次、不清 cookie、不显示表单）/421（不重试）/网络错误的文案；localStorage 从不写入密码（spy）；Sign out；初始密码横幅；明文提示只看 `location.protocol`；`no-innerhtml` 仍然全绿；token 模式的 P1 测试不改                                                                                                                                                                                                                                                                                                                                                                                                                            |

### S1-W3（LD ∥ LI）

| 包              | 文件域                                                                                                                                                                                                                             | 要点与测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LD** hub 接线 | `src/web-hub/hub/{hub,main,agent-server,admin,lifecycle,lan-controller}.ts`、`tests/web-hub/hub/{hub-lan,agent-server-admin,admin,lifecycle,lan-controller}.test.ts`                                                               | 按 §1.4 的生命周期接线：`startHub` 构造 `LanFrontendDeps`（store / kdf / limiter / admission / hosts / scope / onStatus）→ `fe.listen()` → 写 hub.json → `fe.lan?.start()` → `onStatus` 重写 hub.json.lan；`admin.ts` 实现 info/passwd（成功后 `fe.lan.revoke({userId})`）/unlock/shutdown 并写审计（§8.3）；HubLog 脱敏；hub.json 写入 `procStartTicks`、`argv`；`main.ts` 的 `parseHubLanConfig`（L16 第二处 + 代理配置）；§3 的 controller 测试；Scope dispose；测试：`lan_req` 不进日志、bus、registry（spy）；hub.json 不含机密；shutdown 先 ack 后 close；没有 lan 时不创建 db、不启动子进程、不 bind 第二个端口、`fe.lan === undefined`；首次初始密码登录 ⇒ warning 与审计；passwd 后所有 LAN SSE 收到 `auth{revoked}`                                                                                                  |
| **LI** 装配     | `src/config/{settings,setting-specs}.ts`、`src/commands/webhub.ts`、`tests/config/web-hub-settings.test.ts`、`tests/commands/webhub-lan.test.ts`、`tests/integration/web-hub-lan.test.ts`、`AGENTS.md`、`docs/dev/web-hub/arch.md` | 五个 settings 键（extraHosts / trustProxyFrom / externalOrigins 的校验与 `invalidExtraHosts`，L16 第一处；代理两项不同时设置 ⇒ warning 且都置空）；`/webhub passwd`（仅 TUI、带参数时拒绝、两次输入不一致或太短时拒绝）、`unlock`、`restart`、`open` 的 LAN URL 列表与对外 origin；status 中初始密码只在 TUI 显示；e2e（`sandboxHome()`，真实拉起 hub）：开启 LAN ⇒ 本机非 loopback IP 上 `http.request` 登录成功并收到 SSE `hello` ⇒ 用本机 `node:http` 起一个最小代理（设置 `X-Forwarded-*`，对端 127.0.0.1 ∈ trustProxyFrom）⇒ 经代理以 `https://hub.test` origin 登录成功、cookie 带 `Secure`、直连拿该 cookie ⇒ 401 ⇒ TUI 下能读到初始密码 ⇒ passwd ⇒ 不再返回、旧 cookie 401、已开 SSE 收到 `auth{revoked}`；restart 后是新 pid、会话仍有效；会话 jsonl 中没有初始密码；AGENTS.md 的 web-hub 段补 LAN 一句、arch §9 更新 |

### 冲突预检（v7 已实跑，2 个 spec 全部 exit 0；spec 与 v6 相同）

spec 就放在下面的 JSON 块里（每块第一行是 `// spec: <name>.json` 注释，其余是 `conflict-check.mjs` 可读的 JSON 数组；键名 `id`，glob 无花括号）。提取并运行：

````sh
mkdir -p /tmp/lan-plan-v6 && node -e '
const fs=require("fs");const t=fs.readFileSync("docs/dev/web-hub/lan-plan.md","utf8");
for(const m of t.matchAll(/```json\n\/\/ spec: (\S+)\n([\s\S]*?)```/g))fs.writeFileSync(`/tmp/lan-plan-v6/${m[1]}`,m[2]);'
for s in s1-w2 s1-w3; do node skills/dev-flow/scripts/conflict-check.mjs /tmp/lan-plan-v6/$s.json --cwd "$PWD" || exit 1; done
````

W1 只有一个包，不需要预检；W2 五包（含 LP）与 W3 两包的 spec 如下。W1 → W2 串行是因为 W2 各包都依赖 W1 落地的签名与桩。

```json
// spec: s1-w2.json
[
  {
    "id": "LP:hardening",
    "globs": [
      "src/web-hub/protocol/paths.ts",
      "src/web-hub/hub/singleton.ts",
      "tests/web-hub/protocol/paths-private-dir.test.ts",
      "tests/web-hub/hub/singleton-hardening.test.ts",
      "tests/integration/web-hub-hardening.test.ts"
    ]
  },
  {
    "id": "LS:store",
    "globs": [
      "src/web-hub/hub/db.ts",
      "src/web-hub/hub/db-client.ts",
      "src/web-hub/hub/db-child.ts",
      "src/web-hub/hub/kdf.ts",
      "src/web-hub/hub/lan-store.ts",
      "tests/web-hub/hub/db.test.ts",
      "tests/web-hub/hub/db-client.test.ts",
      "tests/web-hub/hub/db-child.test.ts",
      "tests/web-hub/hub/kdf.test.ts",
      "tests/web-hub/hub/lan-store.test.ts"
    ]
  },
  {
    "id": "LC:http",
    "globs": [
      "src/web-hub/hub/http.ts",
      "src/web-hub/hub/auth.ts",
      "src/web-hub/hub/lan-auth.ts",
      "src/web-hub/hub/proxy.ts",
      "src/web-hub/hub/ratelimit.ts",
      "src/web-hub/hub/kdf-admission.ts",
      "src/web-hub/hub/conn-guard.ts",
      "src/web-hub/hub/net-hosts.ts",
      "src/web-hub/hub/sse.ts",
      "src/web-hub/hub/static.ts",
      "tests/web-hub/http/lan-*.test.ts",
      "tests/web-hub/http/lan-helpers.ts",
      "tests/web-hub/http/ratelimit.test.ts",
      "tests/web-hub/http/kdf-admission.test.ts",
      "tests/web-hub/http/conn-guard.test.ts",
      "tests/web-hub/http/proxy.test.ts",
      "tests/web-hub/hub/net-hosts.test.ts"
    ]
  },
  {
    "id": "LE:agent",
    "globs": [
      "src/web-hub/agent/index.ts",
      "src/web-hub/agent/connection.ts",
      "src/web-hub/agent/lan-status.ts",
      "src/web-hub/agent/passwd-prompt.ts",
      "src/web-hub/agent/restart.ts",
      "src/web-hub/agent/proc-identity.ts",
      "tests/web-hub/agent/lan-status.test.ts",
      "tests/web-hub/agent/passwd-prompt.test.ts",
      "tests/web-hub/agent/restart.test.ts",
      "tests/web-hub/agent/proc-identity.test.ts",
      "tests/web-hub/agent/connection-admin.test.ts",
      "tests/web-hub/agent/wiring-lan.test.ts"
    ]
  },
  {
    "id": "LF:web",
    "globs": [
      "src/web-hub/web/**",
      "tests/web-hub/web/login.test.ts",
      "tests/web-hub/web/client-password.test.ts",
      "tests/web-hub/web/auth-mode.test.ts"
    ]
  }
]
```

```json
// spec: s1-w3.json
[
  {
    "id": "LD:hub-wiring",
    "globs": [
      "src/web-hub/hub/hub.ts",
      "src/web-hub/hub/main.ts",
      "src/web-hub/hub/agent-server.ts",
      "src/web-hub/hub/admin.ts",
      "src/web-hub/hub/lifecycle.ts",
      "src/web-hub/hub/lan-controller.ts",
      "tests/web-hub/hub/hub-lan.test.ts",
      "tests/web-hub/hub/agent-server-admin.test.ts",
      "tests/web-hub/hub/admin.test.ts",
      "tests/web-hub/hub/lifecycle.test.ts",
      "tests/web-hub/hub/lan-controller.test.ts"
    ]
  },
  {
    "id": "LI:assembly",
    "globs": [
      "src/config/settings.ts",
      "src/config/setting-specs.ts",
      "src/commands/webhub.ts",
      "tests/config/web-hub-settings.test.ts",
      "tests/commands/webhub-lan.test.ts",
      "tests/integration/web-hub-lan.test.ts",
      "AGENTS.md",
      "docs/dev/web-hub/arch.md"
    ]
  }
]
```

**既有测试的改动边界**（v7 起取代「P1 测试零改动」）：W1 允许修改的既有文件与断言**只有** §1.3.4 列出的那些（`paths.test.ts`、`singleton.test.ts` 的形态变化 + 两个 helpers 的 `HubPaths` 构造），每处都是「同步 → 异步」「`inode` → `identity`」「`toEqual` 补新字段」三类之一，且新增断言只会更强。W2/W3 各包对 `tests/web-hub/**` 与 `tests/integration/web-hub-{disabled,e2e,spawn}.test.ts` 的既有文件**不改**（LP 只新增文件；`stubs.test.ts` 中自己的桩用例除外——必须删除），靠四点保证：`caps` 只在装配了 admin 端口时输出（`agent-server.test.ts:55` 对 hello_ack 做精确 `toEqual`）；PROTO 保持 1.0（`hub.test.ts:63/69`）；`HttpFrontend`、`FrontendDeps`、`HubConfig`、`RunningHub` 的新增字段都是可选的或不被既有 `toEqual` 覆盖（`hub.test.ts:25` 的 fake）；`deps.lan === undefined` 时 `createHttpFrontend` 除 `index.html` 多一个 `data-auth-mode="token"` 属性外与 P1 等价，而 `static.test.ts:20` 的假 `index.html` 不含占位符、`api.test.ts` 不比对 `/` 正文。唯一确定的 W3 例外：`tests/config/web-hub-settings.test.ts` 第 12 行的 `defaults` 精确 `toEqual` 需要补上 `lan: { enabled: false, port: 7879, extraHosts: "", trustProxyFrom: "", externalOrigins: "" }`（`src/config/settings.ts:614` 的默认值同步）。

规模（LOC，t=测试）：W1 ≈ 700 + 600t（其中 ≈ 300 是类型与桩）；LP ≈ 150 + 250t；S1 合计 ≈ 2400 + 2300t。安全相关的包（LP、LC、LS、LE 的 proc-identity）使用 thinking high；W1 用 opus 级模型（接口一次写对的价值最高）。

### 11.1 安全测试矩阵（逐项对应到文件）

| 要求                                                                                                  | 文件                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 目录 / socket 硬化（policy、symlink、属主、竞态、fence、umask、`io` 映射）                         | W1：`tests/web-hub/protocol/paths.test.ts`、`tests/web-hub/hub/singleton.test.ts`、`tests/web-hub/contract/stubs.test.ts`；LP：`tests/web-hub/protocol/paths-private-dir.test.ts`、`tests/web-hub/hub/singleton-hardening.test.ts`、`tests/integration/web-hub-hardening.test.ts` |
| 组合契约：无 lan 时与 P1 等价、有 lan 时生命周期顺序、启动取消链、`lanConfigError`、hub.json 唯一写入 | W1：`tests/web-hub/contract/types.test-d.ts`、`tests/web-hub/hub/{startup-cancel,hub-json,hub-lan-config}.test.ts`；LD：`tests/web-hub/hub/hub-lan.test.ts`、`tests/web-hub/http/lan-context.test.ts`                                                                             |
| authMode 由 listener 决定、缺失不回退、`#t=` 不发往 LAN                                               | `tests/web-hub/http/lan-static.test.ts`（`serveIndex`）、`tests/web-hub/web/auth-mode.test.ts`                                                                                                                                                                                    |
| 受信任代理：非受信任对端伪造 XFF、链解析、Proto/Host、Secure、origin 白名单                           | `tests/web-hub/http/proxy.test.ts`、`tests/web-hub/http/lan-proxy.test.ts`、`tests/integration/web-hub-lan.test.ts`                                                                                                                                                               |
| Host 规范化（80/443、大小写、非法端口）                                                               | `tests/web-hub/protocol/lan.test.ts`、`tests/web-hub/http/lan-host.test.ts`                                                                                                                                                                                                       |
| 会话 origin 绑定（IP ↔ `.local` ↔ 127.0.0.1 ↔ 代理 origin）                                           | `tests/web-hub/http/lan-hostbind.test.ts`                                                                                                                                                                                                                                         |
| SSE 撤销（logout / passwd 同步、到期 ≤60s、同 tick publish、db 不可用不误关）                         | `tests/web-hub/http/lan-sse-revoke.test.ts`、`tests/web-hub/hub/db-client.test.ts`                                                                                                                                                                                                |
| IPC 准入（全局 / 每 sid / 每 IP / SSE 先于 IPC / 静态零 IPC / tick 低优先级 / 事件循环延迟）          | `tests/web-hub/hub/db-client.test.ts`、`tests/web-hub/http/lan-admission.test.ts`                                                                                                                                                                                                 |
| X-Forwarded-For 被忽略（非受信任）                                                                    | `tests/web-hub/http/lan-proxy.test.ts`、`conn-guard.test.ts`                                                                                                                                                                                                                      |
| 未认证连接两池、64 IP 分散占用、受保护类别、竞态                                                      | `tests/web-hub/http/conn-guard.test.ts`（真实 socket）                                                                                                                                                                                                                            |
| 限流恢复、IP 重用、退避表满载、多地址耗尽、饱和、代理后客户端                                         | `tests/web-hub/http/ratelimit.test.ts`、`lan-login.test.ts`                                                                                                                                                                                                                       |
| 公平调度与等待上界                                                                                    | `tests/web-hub/http/kdf-admission.test.ts`                                                                                                                                                                                                                                        |
| 撤销零残留（登出 / 改密 / COMMIT 后崩溃 / 到期）                                                      | `tests/web-hub/hub/db-client.test.ts`、`tests/web-hub/http/lan-login.test.ts`                                                                                                                                                                                                     |
| db 不可用不放宽（503、SSE 保持）                                                                      | `tests/web-hub/hub/db-client.test.ts`、`tests/web-hub/http/lan-session.test.ts`                                                                                                                                                                                                   |
| 迟到回调、close 与 start 并发                                                                         | `tests/web-hub/hub/lan-controller.test.ts`                                                                                                                                                                                                                                        |
| SQLite 超大、卡住、中断恢复、崩溃上限                                                                 | `tests/web-hub/hub/db.test.ts`、`db-child.test.ts`                                                                                                                                                                                                                                |
| 主线程不碰 SQLite、卡住时仍然响应                                                                     | `tests/web-hub/hub/db-client.test.ts`                                                                                                                                                                                                                                             |
| 初始密码不泄露 / 持续提醒                                                                             | `tests/web-hub/hub/admin.test.ts`、`tests/integration/web-hub-lan.test.ts`、`tests/web-hub/web/login.test.ts`、`tests/commands/webhub-lan.test.ts`                                                                                                                                |
| 跨源（自动化）                                                                                        | `tests/web-hub/http/lan-security.test.ts`                                                                                                                                                                                                                                         |
| L16 两处校验、`numeric` 契约贯穿                                                                      | `tests/config/web-hub-settings.test.ts`、`tests/web-hub/protocol/lan.test.ts`、`tests/web-hub/hub/net-hosts.test.ts`、`tests/web-hub/agent/lan-status.test.ts`                                                                                                                    |
| SSE `auth` 事件契约（协议 / 前端镜像 / hub 类型）                                                     | W1：`tests/web-hub/web/contract.test.ts`（既有镜像）、`tests/web-hub/http/sse.test.ts`（追加 revoke/list）、`tests/web-hub/contract/types.test-d.ts`                                                                                                                              |
| restart 身份校验                                                                                      | `tests/web-hub/agent/{restart,proc-identity}.test.ts`                                                                                                                                                                                                                             |

---

## 12. 真机验收（S1 整体执行，通过后合入）

`H=~/.pi/agent/web-hub`，`IP=` 本机局域网 IPv4，`LP=7879`，`C=` 另一台机器（Chromium）。代理项用本机 Caddy 或 nginx（任一）在 `:8443` 终止 TLS 并转发到 `127.0.0.1:$LP`，设置 `X-Forwarded-For/Proto/Host`；配置 `trustProxyFrom=127.0.0.1`、`externalOrigins=https://hub.home.arpa:8443`，C 的 hosts 文件把 `hub.home.arpa` 指向 `$IP`，并信任代理证书（代理自己的事）。

| #   | 步骤                                                                                                                                                                                                                                                | 预期                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | LP：`stat -c '%a %U' $H $H/hub.sock $H/hub.json $H/hub.log`（socket 走 `/tmp` 回落时改用该目录）                                                                                                                                                    | 700 / 600 / 600 / 600，属主是当前用户                                                                                                                                                                                           |
| 1   | LAN 关闭：`ss -ltnp`；`ls $H/hub.db`；`curl -s http://127.0.0.1:7878/ \| grep -o 'data-auth-mode="[a-z]*"'`                                                                                                                                         | 只有 `127.0.0.1:7878`；hub.db 不存在；`data-auth-mode="token"`                                                                                                                                                                  |
| 2   | 开启 LAN → `/reload` → `/webhub restart` → `/webhub status`（TUI）；然后在 rpc 模式下也执行一次 status                                                                                                                                              | `lan=on http://$IP:$LP/ … ⚠ 直连为 HTTP 明文`；TUI 中显示初始密码，rpc 中不显示；db 文件全是 600；status 有「主机名纯数字」提示（本机）                                                                                         |
| 3   | `/webhub open`；`curl -s http://$IP:$LP/ \| grep -o 'data-auth-mode="[a-z]*"'`；`curl -s http://$IP:$LP/healthz`；`curl -s http://127.0.0.1:7878/healthz`                                                                                           | 列出所有白名单地址（不含裸的 `202507220006`）；LAN 页面 `data-auth-mode="password"`；LAN healthz `authMode:"password"`，loopback healthz `authMode:"token"`                                                                     |
| 4   | 在 C 上用 Chromium 访问 `http://$IP:$LP/#t=deadbeef`；打开 DevTools Network                                                                                                                                                                         | 显示密码表单与明文提示；地址栏 `#t=` 被清掉；**没有**任何 `/api/login` 请求被发出；`/healthz` 未被页面请求                                                                                                                      |
| 5   | healthz 失败模拟：在 C 上用 DevTools 把 `/healthz` 设为 block，刷新                                                                                                                                                                                 | 页面行为与 #4 相同（前端不依赖 healthz）                                                                                                                                                                                        |
| 6   | 在 C 上用初始密码登录                                                                                                                                                                                                                               | 网页显示提醒条；主机 status 中出现「已有设备…用初始密码登录过」；hub.log 中有审计记录                                                                                                                                           |
| 7   | 第二个浏览器（或隐身窗口）也登录并打开页面；`/webhub passwd`；观察两个页面；`strings $H/hub.db* \| grep <初始密码>`                                                                                                                                 | 两个页面**立即**（<1s，不等刷新）显示 "Signed out … by the host"；grep 没有结果；旧 cookie 重放返回 401                                                                                                                         |
| 8   | 登出：两个标签页登录同一会话（同一浏览器），在其中一个点 `Sign out`                                                                                                                                                                                 | 另一个标签页立即断流并显示表单                                                                                                                                                                                                  |
| 9   | Host 绑定：用 IP 登录后，把 cookie（DevTools 复制）用 `curl -H "Host: 202507220006.local:$LP" -H "Cookie: pwh_lan=…" http://$IP:$LP/api/session`                                                                                                    | 401；换回 `Host: $IP:$LP` ⇒ 200                                                                                                                                                                                                 |
| 10  | 浏览器保持登录，主机执行 `/webhub restart`                                                                                                                                                                                                          | 页面自动重连，**不需要重新登录**                                                                                                                                                                                                |
| 11  | 跨站：在 C 上 `python3 -m http.server` 提供一个页面，页面脚本执行 `fetch("http://$IP:$LP/api/unsubscribe",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","X-PWH":"1"},body:"{}"})`；在已登录的浏览器中打开该页面   | DevTools 显示预检失败；hub 日志中没有该 POST 的处理记录                                                                                                                                                                         |
| 12  | DNS 重绑定：`curl -H "Host: evil.test:$LP" http://$IP:$LP/`                                                                                                                                                                                         | 421                                                                                                                                                                                                                             |
| 13  | **IP 变化**：`sudo ip addr add 192.168.31.200/24 dev <iface>`；不重启 hub，`curl http://192.168.31.200:$LP/healthz` 两次（间隔 6s）                                                                                                                 | 第一次 421，第二次 200（节流重算）；`ip addr del` 后 ≤ 60s 变回 421                                                                                                                                                             |
| 14  | **80 端口 canonical**：临时 `webHub.lan.port=80`（需要 `CAP_NET_BIND_SERVICE` 或 `authbind`；没有则跳过并记录）→ restart；C 访问 `http://202507220006.local/` 并登录；`curl -H "Host: 202507220006.local:80" -H "Cookie: …" http://$IP/api/session` | 登录成功；带 `:80` 与不带端口的 Host 都 200（同一 canonical origin）                                                                                                                                                            |
| 15  | **代理 HTTPS**：C 访问 `https://hub.home.arpa:8443/` 并登录；DevTools 查看 cookie 属性；再用 `curl -k -H "Origin: http://hub.home.arpa:8443" -H "Content-Type: application/json" -H "X-PWH: 1" -X POST https://hub.home.arpa:8443/api/logout`       | 登录成功、cookie 带 `Secure`；curl 的错误 Origin ⇒ 403；页面正常的 POST（`Origin: https://hub.home.arpa:8443`）⇒ 200                                                                                                            |
| 16  | **伪造代理头**：从 C **直连** `curl -H "X-Forwarded-For: 10.9.9.9" -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: hub.home.arpa:8443" -H "Host: $IP:$LP" http://$IP:$LP/api/login …` 连续失败 6 次；然后从 C 正常登录                          | 被锁的是 C 的真实 IP（第 6 次 429），`10.9.9.9` 不出现在日志；直连声称 `hub.home.arpa` 的 Host ⇒ 421                                                                                                                            |
| 17  | 代理会话与直连会话互用：把 #15 的 cookie 直连发到 `http://$IP:$LP/api/session`；把 #6 的 cookie 经代理发                                                                                                                                            | 都是 401                                                                                                                                                                                                                        |
| 18  | 错误密码 6 次 ⇒ `401×5, 429`；在 C 上配置 20 个别名地址持续失败 ⇒ 收紧模式；此时第二台客户端（新 IP）登录；已登录的浏览器继续操作；最后执行 `/webhub unlock`                                                                                        | 已登录会话不受影响；新 IP 在 ≤16s 内登录成功（前端显示「排队中」）；unlock 后立即恢复                                                                                                                                           |
| 19  | 连接洪泛：在 C 上 20 个别名地址各开 4 条裸连接（`exec 3<>/dev/tcp/$IP/$LP; sleep 90`，共 80 > 64），同时在第二台客户端登录；同时经代理的页面继续使用                                                                                                | 最旧的直连裸连接被关闭；登录成功；`ss -tn` 显示直连未认证连接 ≤ 64；代理页面不受影响                                                                                                                                            |
| 20  | **touch 洪泛**：在已登录的 C 上 `seq 500 \| xargs -P 100 -I{} curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: pwh_lan=…" "http://$IP:$LP/api/history?agent=x&before=y"`；同时在本机 loopback 页面操作                                          | 状态码只有 200/404/429/503；主机 `hub.log` 无 deadline 超时；loopback 页面不卡；`ss` 中在途 IPC 不可见但 hub RSS 增长 < 50 MiB                                                                                                  |
| 21  | 静态资源不触发 IPC：`ab -n 1000 -c 20 http://$IP:$LP/app.js`；同时 `strace -f -e trace=write -p <hub pid>` 过滤到查询子进程 stdin                                                                                                                   | 无 `touchSession` 写入                                                                                                                                                                                                          |
| 22  | **到期断流**：临时把会话滑动时长调为 2 分钟（测试环境变量 `PI_WEBHUB_SESSION_TTL_MS`，仅测试用）→ 登录后不操作                                                                                                                                      | 页面在 2 分钟 + ≤ 60s 内收到 `auth{expired}` 并显示表单；这 ≤ 60s 内页面仍能显示事件（用户可见的接受项）                                                                                                                        |
| 23  | 占住 db 锁：`sqlite3 $H/hub.db 'BEGIN EXCLUSIVE; SELECT 1;' &`（保持 30s）同时执行 `/webhub restart`；另开一次，在 LAN 已经 on 的状态下占锁并刷新网页                                                                                               | 前者 5s 后 `lan=off/db-timeout`；后者请求很快返回 503、前端显示重试中，已开页面**不**被踢出，锁释放后自动恢复；hub 可以正常关闭                                                                                                 |
| 24  | 旧 hub：用 P1 版本拉起 hub，再用新版本执行 `/webhub restart`                                                                                                                                                                                        | 拒绝发信号，给出 §8.2 的手动 kill 文案                                                                                                                                                                                          |
| 25  | 初始密码提醒：用初始密码登录 → 刷新页面 → `/webhub restart` 后再登录                                                                                                                                                                                | 每次都显示提醒条，登录从不被拒绝；status 中持续显示「请尽快修改初始密码」                                                                                                                                                       |
| 26  | db 子进程：`pkill -9 -f PI_WEBHUB_DB_QUERY` 连续 4 次                                                                                                                                                                                               | 前 3 次自动恢复，期间请求 503 而不挂起、已开页面不被踢出；第 4 次后 `lan=off/db-unavailable`，`/webhub restart` 后恢复                                                                                                          |
| 27  | extraHosts：设置 `webHub.lan.extraHosts = "hub2.home.arpa, dev"` → `/reload` + restart；C 上 hosts 文件把 `hub2.home.arpa` 映射到 `$IP`                                                                                                             | `hub2.home.arpa` 可直连访问并登录；status 列出 `忽略无效的 extraHosts：dev（denylisted）`                                                                                                                                       |
| 29  | **代理配置错误**：临时把代理的 `X-Forwarded-Proto` 改为 `http`（或删掉）后从 C 经代理访问；再把代理的对外主机名改成不在 `externalOrigins` 中的名字                                                                                                  | 前者 400（页面显示代理配置错误）；后者 421；`hub.log` 各有一条 `proxy-proto` / `proxy-host` 告警（60s 内不重复）                                                                                                                |
| 30  | **同主机双入口**：把 `hub.home.arpa` 同时加入 `extraHosts` 与（已在）`externalOrigins`；C 直连 `http://hub.home.arpa:$LP/` 登录，把 cookie 经代理 `https://hub.home.arpa:8443/api/session` 发送；反向也做一次                                       | 两次都 401；`sqlite3 $H/hub.db "select bound_origin from sessions"` 显示两条不同的 origin                                                                                                                                       |
| 31  | **tick 不被饿死**：#20 的 touch 洪泛持续运行 3 分钟，同时另一浏览器用 `PI_WEBHUB_SESSION_TTL_MS=120000` 的会话保持打开不操作                                                                                                                        | 该浏览器在 2 分钟 + ≤ 60s 内收到 `auth{expired}`；洪泛期间 `hub.log` 无 `tick skipped`                                                                                                                                          |
| 32  | **启动超时**：`chmod 000 $H`（模拟不可访问）后 `/webhub restart`；恢复权限后再 restart                                                                                                                                                              | 前者 hub 进程在 ≤ 20s 内退出、agent 侧 status 显示启动失败原因（`owner-mismatch`/`io`）；后者正常                                                                                                                               |
| 34  | **有序关闭上限**：浏览器保持登录并打开 SSE，主机对 hub 进程 `kill -TERM <pid>`，同时 `date +%s.%N` 记时；再 `sqlite3 $H/hub.db "BEGIN EXCLUSIVE; SELECT 1;" &` 占锁后重复一次                                                                       | 两次都在 ≤ 10s 内退出（第一次通常 < 1s）；`hub.log` 末尾有 `close(SIGTERM)` 与每步耗时；hub.json 被删除；SSE 收到连接关闭（前端按重连处理，不显示登录表单）                                                                     |
| 35  | **crash 硬退出**（单测覆盖 3s；真机只做对照）：在 hub 进程上 `kill -SEGV <pid>`（模拟不可恢复崩溃）                                                                                                                                                 | 进程立即退出；agent 侧在下一次 `/webhub status` 时 respawn 新 hub；下一个 hub 的 singleton 流程回收 stale socket（P1 已有）；说明：JS 层 `uncaughtException` ⇒ 3s 硬退出由 `startup-cancel.test.ts` / `hub.test.ts` 的 spy 覆盖 |
| 36  | 关闭 LAN → `/reload` + `restart`                                                                                                                                                                                                                    | 回到 #1                                                                                                                                                                                                                         |

---

## 13. 风险与已排除方案

| 风险 / 方案                                                    | 处置                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直连 HTTP 明文：嗅探 / 重放密码与 cookie                       | L23a：超出范围；status 与登录页告知；HTTPS 走受信任代理（L24）                                                                                                                                                                                                                                        |
| 受信任代理失陷                                                 | **该代理入口的所有会话完全失陷**：可伪造客户端 IP / XFH / XFP、看到并重放密码与 cookie、篡改页面；hub 无法区分（L24 固有代价，写入 status）；收紧解析（XFP 必须 https、XFH 必须落在 externalOrigins）只挡配置错误与非受信任对端的伪造，不挡失陷的代理；直连入口的会话因 `bound_origin` 不同而不受影响 |
| 代理后面的恶意客户端                                           | 连接层：只耗尽代理池（48 未认证 / 128 总），直连不受影响；HTTP 层：每客户端 IP 进行中 16、KDF 每 IP 1 席位、每 IP 退避                                                                                                                                                                                |
| 到期后已开页面最多再显示 60s                                   | 用户可见接受项（§12 #22）；登出 / 改密为 0 延迟                                                                                                                                                                                                                                                       |
| 攻击者占用大量同网段地址                                       | 收紧模式 + fresh 保留席位 + 24h 污点 + 4096 饱和；上界 `4·min(A,4096)+16s`；已登录会话不受影响；本机 `unlock`                                                                                                                                                                                         |
| 饱和后合法新地址被拒                                           | 有意取舍（§6.2）；需要 4096 个不同失败地址才会触发；`unlock` 立即解除；status 红字提示                                                                                                                                                                                                                |
| 连接淘汰被攻击者用来反复踢掉合法用户的空闲连接                 | 只影响尚未取得 KDF 席位的空闲连接；前端重试；受保护类别保证排队中的登录不被打断                                                                                                                                                                                                                       |
| touch 洪泛拖慢事件循环 / 打满 IPC                              | 两条通道 + 全局 / 每 sid / 每 IP 配额 + 立即 503；排队者最坏 2s；tick 低优先级                                                                                                                                                                                                                        |
| SQLite 同步调用挂住                                            | 全部在可 SIGKILL 的子进程中；大小上限；主线程只做异步 IPC；残余风险是磁盘整体挂死占住线程池                                                                                                                                                                                                           |
| db 子进程反复崩溃                                              | 退避重启，10 分钟内 4 次 ⇒ fail-closed（L22）；已打开的 SSE 不受影响，新请求 503 后前端重试                                                                                                                                                                                                           |
| SQLite 仍是 experimental API                                   | 只用 `DatabaseSync` 的基础 API；缺失时 fail-closed；peer 升级时回归                                                                                                                                                                                                                                   |
| 纯数字主机名                                                   | 不进白名单；status 提示用 IP 或 `.local`                                                                                                                                                                                                                                                              |
| 其它 uid 预置 `/tmp` 回落目录                                  | LP：按组件 `DirPolicy`、lstat 拒 symlink、属主 + 0700、sticky 父目录、bind / fence 复核 `{dev,ino}`；失败即 `failed`，不回落                                                                                                                                                                          |
| 陈旧的 `index.html`（缓存）导致 authMode 缺失                  | 前端进入错误模式、不发凭据（fail-closed）；`index.html` 的 `Cache-Control` 沿用 P1（no-cache）                                                                                                                                                                                                        |
| tick 复核被交互 IPC 饿死                                       | 保留槽（在途上限之外的 1 个）专供 tick / purge；持续洪泛下 ≤ 60s 仍成立（§4.2、§12 #31）                                                                                                                                                                                                              |
| hub 启动 / 关闭在文件系统卡住时挂起                            | hub 侧 fs 全部 `fs.promises`（线程池）+ 启动 20s / 关闭 10s 整体 deadline ⇒ `process.exit`；agent 侧 spawn 观察者本来就有超时（§3.1）；残余：P1 的 `log.ts` `appendFileSync`、`writeHubJson` 同步写（小文件、状态目录本地盘）                                                                         |
| 启动超时后残留半成品（socket / lock / guard / listener）       | 启动取消链：一个 `AbortController` 贯穿所有 await，迟到结果自我清理；契约测试「延迟 resolve 后再次 acquire 必为 owner」（§1.4.2、§3.1）                                                                                                                                                               |
| crash 时 3s 硬退出可能留下未 unlink 的 socket / hub.json       | 有意保持（进程状态不可信）；下一个 hub 的 singleton 流程回收 stale socket，`hub.json` 由 pid 存活性判定（P1 已有）                                                                                                                                                                                    |
| 文档与代码漂移（v8 后不再复审文档）                            | W1 把全部冻结接口写成代码并由评审员审代码；`stubs.test.ts` 让「桩未替换」在 W2 合入时暴露；之后的偏差只在 §15 追加记录                                                                                                                                                                                |
| 已排除：tick 与交互共用 IPC 槽并靠「超过一个周期强制抢占」     | 抢占仍要等一个周期，且需要在交互队列中插队的复杂逻辑；保留槽更简单且上界更紧（v6 #3，主会话拍板）                                                                                                                                                                                                     |
| 已排除：`externalOrigins` 允许 `http://`                       | 会让代理与直连的 `bound_origin` 可能相同、cookie 可互用；且 http 代理毫无意义（v6 #4）                                                                                                                                                                                                                |
| 已排除：`X-Forwarded-Host` 优先于 `Host` 任意采信              | 失陷或误配的代理可让请求落在任意 origin；改为必须 ∈ externalOrigins（v6 #5）                                                                                                                                                                                                                          |
| 已排除：前端用 `/healthz` 或 `location.protocol` 判定 authMode | healthz 失败或被拦截时会回退；`location` 在代理场景下不可靠（评审 v5 #2）                                                                                                                                                                                                                             |
| 已排除：会话缓存（v4）                                         | 撤销有残留窗口、db 不可用时放宽；L19 已接受每请求一次 IPC                                                                                                                                                                                                                                             |
| 已排除：污点表 LRU 回收（v4）                                  | >4096 地址循环可让旧地址重新变「新鲜」，上界失效                                                                                                                                                                                                                                                      |
| 已排除：饱和后让未见过的地址进入 tainted 通道                  | 重新打开无界洪泛面                                                                                                                                                                                                                                                                                    |
| 已排除：淘汰「全局最旧未认证连接」且不分类别                   | 会先杀掉正在排队等 KDF 的合法登录；改为受保护类别 + 两级规则                                                                                                                                                                                                                                          |
| 已排除：受信任代理对端直接跳过每 IP 连接上限（v6 草案）        | 一个恶意客户端可占满 64 个全局未认证连接、连累直连用户（评审 v5 #3 复议）；改为独立代理池                                                                                                                                                                                                             |
| 已排除：CIDR 形式的 `trustProxyFrom`、`Forwarded` 头           | 精确字面量足够（代理在本机或固定地址）；RFC 7239 解析面大、常见代理不发                                                                                                                                                                                                                               |
| 已排除：目录检查失败时换下一个候选路径                         | agent 侧无 fs 也要算出同一路径；改为 fail-closed                                                                                                                                                                                                                                                      |
| 已排除：每客户端信任自签 leaf、本地 CA、不安全裸主机名入口     | 随 L23 移出范围；设计存档于 §14                                                                                                                                                                                                                                                                       |
| 已排除：pi 进程直接读写 hub.db                                 | 运行时可能没有 node:sqlite；多个写者需要加锁                                                                                                                                                                                                                                                          |
| 已排除：HSTS、HTTP Basic Auth、IPv6                            | HSTS 由代理决定；后两者同 v1 理由                                                                                                                                                                                                                                                                     |
| 已排除：单一全局 FIFO 等待队列（v3）                           | 可被多 IP 洪泛占满，合法新 IP 没有等待上界                                                                                                                                                                                                                                                            |
| 已排除：按「近期成功登录过的 IP」做全局豁免（v2）              | DHCP 或 IP 重用会继承豁免                                                                                                                                                                                                                                                                             |
| 已排除：worker_threads 执行 SQLite                             | 实测无法被 terminate，并且会拖住进程退出                                                                                                                                                                                                                                                              |
| 已排除：为管理帧增加逐连接鉴权                                 | L11：同 uid 完全可信，鉴权没有防护价值                                                                                                                                                                                                                                                                |

---

## 14. 存档：v4 的 TLS / 本地 CA 设计（供将来 HTTPS 阶段）

本方案 v4（2026-09-26，892 行，随本文件的 git 历史保存；主会话另存了 `/tmp/lan-plan-v4/v4.md`，建议以 `docs/dev/web-hub/lan-plan-v4-tls-archive.md` 归档，见 §16 Q-1）包含完整的 HTTPS 设计：带 `nameConstraints`（精确 /32 + 精确主机名、配方 A 子域排除）的本地 CA、leaf 签发与验证、openssl runner（可 SIGKILL）、CA 轮换并删除旧私钥、`/webhub ca` 与安装指引、`tlsHosts`/`unsafeBareHosts` 双集合与 I1–I5 不变量、自带证书的私钥检查。`lan-spike-results.md`（Chromium 152，配方 A）仍然有效：Chromium 对手动信任的本地 CA 执行 nameConstraints 与子域排除；Chromium 的信任锚库是 `$HOME/.pki/nssdb`（snap 版为 `~/snap/chromium/current/.pki/nssdb`），不读 `--user-data-dir`。将来若在 hub 内做 HTTPS：只替换 `LanTransport.bind()`（§2.2）为 `node:https` + `setSecureContext`，认证、限流、路由、会话绑定全部不变；cookie 加 `Secure` 并改名 `__Host-pwh_lan`；Origin 校验改 `https://`。

---

## 15. 评审修订记录

### 15.1 v1 → v2（gpt-sol，打回）

> 其中 #3（已知 IP 豁免全局限流）与 #11（S1 单独验收）的处置已在 v3 中被推翻，见 15.2。

| #   | 级别 | 评审问题                             | 处置                                                                                                                                                                                                                                      |
| --- | ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞 | 首次信任可被中间人                   | 改用带 nameConstraints、`pathlen:0`、`keyCertSign` 的本地 CA（§2.1）；给出浏览器支持结论和 S2-W0 实测闸门，以及功能性/安全性两种失败的兜底（§2.2）；CA 分发与带外核对（§2.6）；残余风险写明                                               |
| 2   | 严重 | TLS 上下文与白名单必须原子替换       | `LanSnapshot` 冻结对象，`swap` 同步提交；白名单恒为「期望集合 ∩ 已验证 leaf 的 SAN」；自带证书白名单 = 期望集合 ∩ SAN，交集为空时拒绝（§3、Q4）；补测「新 IP + 重签失败」「自带证书 SAN 不足」（LR、LU）                                  |
| 3   | 严重 | 资源上限与全局锁死                   | 连接、握手、未认证、SSE、KDF（2×32 MiB）上限都给出数字（§7.3）；池与 ticket 在 finally 中释放；全局限流改成只针对陌生 IP 的令牌桶，已知 IP 豁免，`/webhub unlock` 可在本机恢复（§7.2）；补多 IP、慢 TLS、并发 KDF、异常路径测试（LC、LS） |
| 4   | 严重 | restart 身份校验                     | 首选 socket `hub_ctl`；回退路径只在 Linux 上启用，校验 starttime、argv 精确匹配、uid、hub.json 与 socket 的所有权，发信号前二次校验；pidfd 不可用的原因写明；其它情况 fail-closed（§9.2）；补测 PID 复用、相似路径、检查后被替换（LE）    |
| 5   | 严重 | LAN 启动的 generation 与取消         | 引入 `gen`、`closed` 和 Scope；超时时 abort 并 SIGKILL openssl；迟到的 bind 立即关闭、不调用 onStatus；close 之后全部 no-op（§4）；补测（LK）                                                                                             |
| 6   | 严重 | 自带私钥的权限                       | §2.5：普通文件、uid、无 077 权限、O_NOFOLLOW + fstat、symlink 所有权检查，否则 `key-unsafe`                                                                                                                                               |
| 7   | 一般 | 证书有效期起点与 KDF 参数校验        | 所有证书检查 `notBefore ≤ now < notAfter`（§2.1/2.3/2.5）；KDF 参数严格校验，异常统一为 corrupt（§6）                                                                                                                                     |
| 8   | 一般 | 每个请求只用一份快照，按固定顺序提交 | §3 的 ①–⑦ 顺序，请求入口只读一次快照                                                                                                                                                                                                      |
| 9   | 一般 | 统一的生命周期                       | `lifecycle.ts` 的 Scope 统一管理 abort、定时器 unref、defer；openssl runner 的 kill、等待、临时目录清理（§2.4、§4）；真实进程测试（LB）                                                                                                   |
| 10  | 一般 | 测试补充                             | XFF 被忽略、慢 TLS、连接上限、限流恢复、私钥权限、原子切换、迟到回调、swap 后已有 SSE 保持且新连接用新证书（LC、LB、LK、LR）；真机跨站请求 #10、中间人模拟 #7                                                                             |
| 11  | 建议 | 按风险分阶段                         | S1 基础（不对外暴露）→ S2 本地 CA 与上线 → S3 热轮换、自带证书、extraHosts，每阶段 fail-closed、可独立验收（§0）                                                                                                                          |
| —   | 用户 | L4–L10                               | L4 → §9；L5 → §5、§9.1（hub 独占 db，pi 通过 socket 操作）；L6 → Q13、§10.3；L7 → Q9、§7.4；L8 → 沿用；L9 → §2；L10 → S3 完整范围                                                                                                         |

### 15.2 v2 → v3（gpt-sol 复审，打回；用户决策 L11–L14）

| 问题                                  | 处置                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 Blocker #1：管理 socket 的信任边界 | L11：新增 §1.1 威胁模型，明确同 uid 完全可信（它们本来就能读 0600 的 db、token、CA key），对其它 uid 的保护只来自 0700 目录与 0600 的 socket/文件；管理操作仍走现有 socket，每个操作写审计日志且不含密码（§9.3）；删除管理帧逐连接鉴权之类的设计；restart 的 `/proc` 校验降级为安全性（safety）措施                                                             |
| #1 的其余部分：首次信任               | 残余风险写入 §1.1；指纹按 8 组显示以便逐组核对；登录页红字提示；`/ca.crt` 不需要登录的理由写明（§2.6）                                                                                                                                                                                                                                                          |
| 新 #2：CA 约束范围                    | L12：改为精确 /32 + 精确主机名 + localhost/127.0.0.1（§2.1），删除 `caIpScope`；IP 变化的完整文案（§10.3）以及仅本机可用时的文案。**核实 DNS 约束放行子域**：本机实测 `permitted;DNS=myhost` 放行 `sub.myhost`，加上 `excluded;DNS=.myhost` 后只剩精确名（文首 ①）；据此制定子域排除规则、单标签 hostname 规则与 TLD 名单（§2.2），并在 spike 中加入 C4/C5 用例 |
| #4：限流                              | §7.2 重做：删除「近期成功登录的 IP」豁免；全局只约束失败次数（收紧模式，带滞回）与 KDF 资源（令牌桶 + 有界 FIFO，每 IP 最多 1 个等待者，Retry-After 很短）；已登录会话不经过限流；IP 表满时淘汰到期最早的条目，从不拒绝新 IP；`/webhub unlock` 可在本机恢复。补测：IP 重用、4096 满载、多地址耗尽（LC）                                                         |
| #5：SQLite 零 hang                    | 实测 worker 无法中断原生调用，并且会拖住进程退出（文首 ④），所以 §5.2 改为：打开前检查大小上限（db 64 MiB / wal 16 MiB）；open、恢复、quick_check、迁移、checkpoint 全部放进可以 SIGKILL 的子进程，带 5s/3s deadline，超时 ⇒ fail-closed；主线程关闭自动 checkpoint，busy_timeout 50ms，并给出上界论证。补测：超大库、锁占用导致卡住、中断恢复（§5.3）          |
| #6：初始密码明文                      | 明确为 L6 接受的风险（§6.2）；改密后立即做 TRUNCATE checkpoint，失败时在下次启动恢复阶段优先执行；日志脱敏；崩溃路径只使用固定文案；缩短暴露窗口：首次用初始密码登录后红字提示与审计、24h 未改持续提醒、网页横幅。补测：改密中断、WAL 恢复、重启后不可读、socket/日志/会话文件不泄露                                                                            |
| `lan-spike-results.md` 不存在         | 新增包 SP（S1-W2 并行），产物为 `lan-spike-results.md` 与 `lan-spike/gen.sh`，是 **S2-W1 开工前的闸门**；C1–C5 × Chrome/Firefox/Safari；失败时按 L14 处理：绝不自动改用无约束 CA（§2.2）                                                                                                                                                                        |
| #10：测试缺口                         | §12.1 安全测试矩阵把每一项要求对应到具体测试文件；增加自动化跨源测试（OPTIONS 不带 ACAO、异源 POST ⇒ 403）；真实浏览器验收项：§13 #4、#7、#8（用真 CA 签越界证书，让浏览器拒绝）、#10                                                                                                                                                                           |
| L13：合入策略                         | §0：S1 只进特性分支 `feat/web-hub-lan`，S1+S2 按 §13 一并验收后才合入 master；S3 另行合入                                                                                                                                                                                                                                                                       |
| L14：无约束 CA                        | §2.8：只有「设置为 false + 执行 rotate 时输入 `UNCONSTRAINED`」才会生成；代码中没有任何自动路径；status 与 `/webhub ca` 每次都显著提示；CN 中带 `UNCONSTRAINED`                                                                                                                                                                                                 |
| L14：初始密码只在 TUI 显示            | §6.2、§10.3；测试放在 LE、LI                                                                                                                                                                                                                                                                                                                                    |
| L14：P1 旧 hub                        | §9.2：缺少身份字段 ⇒ 拒绝发信号，给出手动 `ps` 核对 + `kill` 一次的文案；验收 §13 #16                                                                                                                                                                                                                                                                           |
| L14：轮换后删除旧 CA 私钥             | §2.7：暂存 → 覆写并 unlink 旧 key → rename → swap，带崩溃恢复日志；`retired/` 中只保留证书。验收 §13 #12：状态目录中没有任何私钥与旧 CA 公钥配对，用旧证书签发时 openssl 报 key mismatch。`ca rotate` 从 S3 提前到 S2（精确 /32 下 IP 一变就需要它）                                                                                                            |
| 文档自洽                              | v3 完整重述了 v2 中「沿用」的细节（接口、schema、上限、文案、前端），不依赖已被覆盖的旧版本                                                                                                                                                                                                                                                                     |

### 15.3 v3 → v4（gpt-sol 复审，打回；用户决策 L15–L19）

| #   | 级别 | 问题                   | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞 | L15 与原子快照规则冲突 | §3：`allowedHosts` 拆成 `tlsHosts`（语义不变：必须被已验证 leaf SAN 覆盖）和 `unsafeBareHosts`（只有开关打开时才有，且只能来自被省略的系统裸主机名）；`buildSnapshot` 的不变量 I1–I5 在提交前校验；请求按分类路由、两个集合互不回退；Origin 按同一分类校验；会话绑定 Host 与分类；响应头 `X-PWH-Host-Class`、`/healthz.hostClass`；`LanStatus.unsafeHosts` 与警告；MITM 可伪造网页标注，写明是 L15 接受的风险；补测：安全入口拒绝越界 Host、开关打开时裸入口通过、开关关闭时 421、把 IP、`.local`、CA 覆盖名字作为 unsafe 项时 `buildSnapshot` 抛错 |
| 2   | 严重 | spike 闸门             | 按 L18 只测 Chromium（本机 snap 152）：方法（certutil 或 certificate-manager 导入、回环 /8 上的服务、`--host-resolver-rules`、CDP 探测、deveye 人工复核）、用例 C1–C6、结果文件的固定格式（含 JSON 块）、各种结果的处置；Firefox/Safari 标「未验证」并按「不保证遵守」处理；系统裸主机名一律不进 CA；结果文件缺失 ⇒ `tls-recipe.test.ts` 失败、S2 不能开工；不安全入口没有任何默认打开的路径（§2.2）                                                                                                                                                |
| 3   | 一般 | 限流公平性             | §7.2：每 IP 最多 1 个等待者 + 按类别分开的席位（fresh 保留 4）+ 两类交替、类内轮询 + 24h 污点记忆；容量造成的 429 不记污点；给出上界：拿到席位后 ≤16s，最坏 `4A + 16s`；§7.3 全局未认证连接满载时腾出位置给新 IP；补测 ①–⑨                                                                                                                                                                                                                                                                                                                          |
| 4   | 一般 | SQLite 主线程          | L19：§5 改为主线程完全不导入、不打开 SQLite；常驻查询子进程（每个请求 2s deadline）+ 短命维护子进程；超时或崩溃 ⇒ 在途请求 503，退避重启，10 分钟内 4 次 ⇒ `off/db-unavailable`；会话缓存 30s；重写零 hang 论证；补测「主线程从不加载 sqlite」「子进程被 `Atomics.wait` 卡住时 `/healthz` 仍 <50ms、事件循环 p99 <50ms」、崩溃上限                                                                                                                                                                                                                  |
| 5   | 建议 | L17 文案               | 统一为持续、非强制的「请尽快修改初始密码」（TUI、rpc 提醒、网页每次登录与每次加载页面）；删除 v3 中「请立即」和 24h 分界的说法；补测：生成后超过 24h、已用初始密码登录、hub 重启后在网页登录，都仍显示提醒且登录不被拒绝（§6.2）                                                                                                                                                                                                                                                                                                                    |
| —   | 核对 | L16 三处校验           | 同一个 `classifyHostToken` + `SINGLE_LABEL_DENYLIST`（`protocol/lan.ts`）：settings 解析时丢弃并列出、env 解析时 fail-closed（bad-config）、CA 生成前再断言；三处各自有测试（§2.2、§12.1）                                                                                                                                                                                                                                                                                                                                                          |

### 15.4 v4 → v5（gpt-sol 复审，打回；用户决策 L20–L23；作者换为 fable）

> v4 复审的 7 条意见中，#1（spike 闸门）与 #5（无约束 CA 的 `caCovers`）的对象随 L23（HTTP-only）一并移出范围；其余 5 条在本版闭合。v4 中已经通过评审的部分（SQLite 子进程与零 hang 论证、KDF 与常量工作量、初始密码 L6/L17、公平调度的 fresh/tainted 双通道、管理帧与审计、restart 身份校验、P1 测试零改动）原样保留。

| #   | 级别 | 问题                                                                        | 处置                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞 | spike 产物不存在；「本机无 certutil」与 L20 矛盾                            | spike 已于 v5 期间完成（`lan-spike-results.md`：Chromium 152 遵守 nameConstraints，配方 A，纯数字主机名不可导航）。随后用户决策 L23：hub 不做 HTTPS ⇒ 闸门、配方常量、`tls-recipe.test.ts` 全部删除；spike 结论与 v4 的 CA 设计存档于 §14；certutil 的矛盾随之消失。spike 的「纯数字主机名」发现被吸收为 `classifyHostToken` 的 `numeric` 分类（§2.1、Q13）                                         |
| 2   | 严重 | 未认证连接 64 上限、64 个 IP 各占 1 条时无淘汰对象                          | §6.3：引入连接类别（`unauth` / `login-pending` / `authed`）与单调 `seq`；两级确定性淘汰（先「≥2 条的 IP 中占用最多者的最旧一条」，否则「全局最旧的 `unauth`」）；`login-pending`（已取得 KDF 席位）与 `authed` 不可淘汰，席位总数 30 < 64 保证恒有可淘汰对象；选择与接纳在同一同步块中完成；补测 64 IP 分散占用、30 受保护 + 34 空闲、竞态、被淘汰后计数                                            |
| 3   | 严重 | 30s 会话缓存：COMMIT 后崩溃仍放行、缺 expires_at、DB 不可用时放宽           | **删除缓存**（§4.2、Q6）：每个需要会话的请求做一次 `touchSession` IPC（L19 接受），子进程 SQL 与主线程双重判定 `expires_at` / `absolute_expires_at`；登出 / 改密先落库后回复，子进程 COMMIT 后崩溃 ⇒ 调用方 503 但撤销已生效；db 不可用 ⇒ 503、不存在放行路径；给出撤销事件的最大残留窗口表（全部为 0）；补测 COMMIT 后立即崩溃、登出、改密、12h/7d 到期、db 不可用期间 503 且 SSE 保持、touch 节流 |
| 4   | 严重 | P1 socket 回落目录 stat 跟随 symlink、检查与 bind 非原子、listen 后才 chmod | 新增 S0 包 LP（§1.3、Q16）：`ensurePrivateDir` 改 lstat、拒 symlink（`stateDir` 允许自己拥有的 symlink）、属主 + 0700 校验、属主不对不 chmod；不回落到下一个候选（路径解析保持纯函数）；bind 前记目录 `{ino,dev}`、listen 后 lstat 复核 socket 与目录；hub 进程入口 `umask 077`；fs/getuid 可注入；补测 symlink、跨 uid、竞态、umask；P1 现有测试不改。建议直接合入 master（§16 Q-2）               |
| 5   | 严重 | 无约束 CA 下 `caCovers` 未定义，与 I4 冲突                                  | 随 L23 移出范围（无 CA 即无 `caCovers`、无 I1–I5）；v4 设计存档于 §14，将来若恢复 HTTPS 需按两种模式分别定义                                                                                                                                                                                                                                                                                        |
| 6   | 一般 | `4A + 16s` 仅在 A 有上限时成立                                              | §6.2、Q15：A 定义为「尚未进入污点表的攻击者地址数」，硬上限 `TAINT_CAP = 4096`——污点表满即饱和，**不做 LRU 回收**（回收会让旧地址重新变新鲜、上界失效），来自未见过地址的登录一律 429 `saturated`，直到 24h TTL 过期或 `unlock`；上界 `4·min(A, 4096) + 16s`，/24 网段 ≈ 17.2 分钟（L21）；明确写出不存在与 A 无关的公平保证，以及为何不让未见过的地址进入 tainted 通道；补测 ⑩–⑯                   |
| 7   | 一般 | TLS 会话也应做 Host/Class 双重绑定                                          | §6.4、Q7：所有 LAN 会话记录 `bound_host` 并在每个请求上校验（class 随 TLS 消失而删除）；不匹配 ⇒ 401 且不删会话；补测 IP ↔ `.local` ↔ 127.0.0.1 之间的 cookie 注入                                                                                                                                                                                                                                  |
| —   | 用户 | L23：先支持 http，https 由用户另行处理                                      | §0、§1.1、Q1、Q20：删除 S2/S3 的 TLS 内容，extraHosts 提前到 S1；Host 白名单退化为单集合（§2）；cookie 去掉 `Secure`/`__Host-`；Origin 改 `http://`；`/healthz.authMode` 替代 `location.protocol` 判断模式；链路层嗅探写入威胁模型为超出范围，status 与登录页告知；反向代理的限流限制写明；`LanTransport` 保留为插槽                                                                                |
| —   | 用户 | L20–L22                                                                     | L20 随 TLS 作废；L21 → §6.2 上界的接受依据；L22 → §4.2 崩溃上限与 `off/db-unavailable`                                                                                                                                                                                                                                                                                                              |
| —   | 简化 | 收窄                                                                        | 删除会话缓存（-1 个状态源）；删除 TLS 全部（S1 从 ≈1800+1700t 的一部分变成整个范围 ≈1900+1800t，v4 三阶段合计 ≈3300+3150t）；`HostSnapshot` 只剩一个集合；`LanOffReason` 从 16 个减到 8 个；settings 从 6 个键减到 3 个                                                                                                                                                                             |

### 15.5 v5 → v6（gpt-sol 复审，打回；用户决策 L24）

| #   | 级别 | 问题                                                                             | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞 | 现有 ports/hub/main/http 只描述一个 loopback listener，未冻结组合契约            | 新增 §1.4：`ListenerKind`、`HubConfig.lan`、`RequestContext`（listener 类别、canonical hostKey、外部 origin、客户端 IP 来源、快照）、`LanFrontendDeps` / `FrontendDeps.lan`、`LanFacade` / `HttpFrontend.lan`；端口、生命周期顺序（loopback → hub.json → lan.start → onStatus 重写）、authMode 来源、hub.json / `lan_res` 返回结构、P1 兼容点全部写明；LA 冻结这些类型后 W2 才开工（§11）                                                                                                                                          |
| 2   | 严重 | authMode 必须由 listener 决定；healthz 失败不得回退 token、不得把 `#t=` 发往 LAN | §1.4、§7、§10：`static.ts` 的 `serveIndex` 按 listener 注入 `<html data-auth-mode>`；前端只读该属性，缺失 / 非法 ⇒ 错误模式（不读 `#t=`、不读 localStorage、不发 login、不开 SSE）；password 模式下 `#t=` 只被清掉；`/healthz.authMode` 降为诊断；补测 `auth-mode.test.ts`、`lan-static.test.ts`、验收 #1/#3/#4/#5                                                                                                                                                                                                                 |
| 3   | 严重 | 按 L24 设计受信任代理                                                            | §2.4 + §6.3 + §6.4：`trustProxyFrom`（IPv4 字面量）与 `externalOrigins` 成对配置；只在对端 ∈ trustProxyFrom 时解析 `X-Forwarded-For`（从右往左第一个不受信任的合法 IPv4，否则用对端并告警）/ `Proto` / `Host`；经代理的白名单是 `externalOrigins`（直连用 `hostKeys`，https origin 只可能经代理产生）；Origin/CSRF 按 canonical 外部 origin；https 时 cookie 加 `Secure`；`bound_origin` 绑定；限流 / KDF 按 clientIp；连接层独立代理池（48/128）+ HTTP 层每客户端 IP 配额；补测伪造 XFF、链解析、两池、代理会话互用、e2e 最小代理 |
| 4   | 严重 | 已建立 SSE 的撤销                                                                | §4.2：SSE 绑定 `{sidHash, userId, epoch}`；登出 / 改密在 db 提交成功后、响应前**同步** `revoke`（先停 publish 再发 `auth{revoked}` 再 end）；55s tick 经低优先级通道复核，到期 ⇒ `auth{expired}`；db 不可用不误关；用户可见结论「登出 / 改密 0、到期 ≤ 60s」写入 Q11、§13 与验收 #7/#8/#22；补测同 tick publish、passwd 关闭该用户全部 SSE、COMMIT 后崩溃 ⇒ 下一 tick 关闭                                                                                                                                                         |
| 5   | 严重 | touchSession IPC 的 admission / backpressure                                     | §4.2「IPC 准入」：交互通道在途 64 / 排队 128、超出立即 503 `E_BUSY`、排队者最坏 2s（不掩盖）；同 sid 去重且挂起响应 ≤ 8；每客户端 IP 进行中 ≤ 16；SSE 上限先于 IPC；tick / purge 走低优先级通道（在途 < 32 才发、并发 2）；客户端断开 ⇒ waiter 回收；静态与 healthz 零 IPC；补测 500 并发 history、同 sid / 同 IP 并发、tick 与洪泛并存、事件循环 p99、静态零 IPC（spy）、验收 #20/#21                                                                                                                                             |
| 6   | 严重 | P1 硬化接口：按路径组件定义策略、bind 与 fence 统一校验、竞态测试                | §1.3 重写：`DirPolicy`（create / recursive / allowOwnedSymlink / repairMode / parentMustBeSticky）随 `HubPaths.policies` 由 `resolveHubPaths` 纯计算返回；三处调用点（`main.ts`、`hub.ts:44`、`singleton.ts:75-78`）显式传 policy；`verifyBoundSocket` 在 bind 后与 `startFence` 中复用，校验非 symlink + isSocket + uid + 目录 `{dev,ino}`；`FsDeps` 可注入；补测每种 policy 的反例、bind 后目录被替换、fence 期间 socket 变 symlink                                                                                              |
| 7   | 一般 | Host 先解析为唯一 canonical hostKey                                              | §2.2：`canonicalHostKey`（小写、显式端口、按 scheme 补 80/443、拒绝非法端口 / IPv6）、`canonicalOrigin`（浏览器形式）、`parseOrigin`；白名单、Origin 比较、`bound_origin` 只用 canonical 值；补测 80/443 省略、大小写、`:080`、带斜杠的 Origin、验收 #14                                                                                                                                                                                                                                                                           |
| 8   | 一般 | `numeric` 契约统一                                                               | §2.1：`HostTokenRejectReason` 类型贯穿 `classifyHostToken`、`invalidExtraHosts: InvalidHostToken[]`、`bad-config` detail、`HostSnapshot.omitted`、`LanStatus.omitted`、status 文案；`numeric` 明确为 `ok:false` 的原因而不是 kind；测试矩阵加一行                                                                                                                                                                                                                                                                                  |
| 9   | 一般 | 验收矩阵与冲突预检 spec                                                          | §12 补 #1/#3（listener-specific healthz 与 `data-auth-mode`）、#5（healthz 被拦截）、#7/#8（passwd / logout 后 SSE）、#14（80 端口 canonical）、#15–#17（代理 HTTPS Origin、伪造代理头、会话互用）、#20（touch 洪泛）、#21（静态零 IPC）、#22（到期 ≤ 60s）；§11 的 spec 改为每个 spec 一个可提取的 JSON 块（首行 `// spec: <name>.json`），并给出提取 + 运行命令；v6 已实跑 exit 0                                                                                                                                                |
| —   | 用户 | L24                                                                              | 推翻 L23b；§1.1 新增受信任代理与代理后客户端两行；Q6、§2.4、§6.3、§9.1 新增 `trustProxyFrom` / `externalOrigins`；§16 Q-3 关闭                                                                                                                                                                                                                                                                                                                                                                                                     |
| —   | 简化 | 收窄                                                                             | `trustProxyFrom` 只接受 IPv4 字面量（不做 CIDR）、只解析 `X-Forwarded-*`（不做 RFC 7239）；代理白名单只看 `externalOrigins`（不与接口集合混合）；authMode 用一个 HTML 属性而不是新的 API                                                                                                                                                                                                                                                                                                                                           |

### 15.6 v6 → v7（gpt-sol 复审，打回；取舍由主会话拍板）

> v6 复审：9 条旧项中 4 条基本闭合、3 条部分、2 条（#1 契约、#6 硬化接口）未闭合；新增 1 阻塞 + 4 严重 + 2 一般。本表按新编号。

| #    | 级别 | 问题                                                                                                            | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 阻塞 | 「P1 测试一行不改」与 `HubPaths` 新字段（`paths.test.ts:21` 精确 `toEqual`、`http/helpers.ts:84` 字面构造）冲突 | **放弃该承诺**（Q22）：§1.3.4 逐项列出 LP 修改的既有断言（`paths.test.ts` 7 处、`singleton.test.ts` 4 处、两个 helpers 的 `HubPaths` 构造）及理由——全部是「同步 → 异步」「`inode` → `identity`」「`toEqual` 补新字段」，新增断言只更强；明确不允许删用例或放宽 mode / 次数 / 文案；§11 的「零改动」段改写为「改动边界」                                                                                                                                                                                                                                                                                                      |
| 2    | 严重 | 冻结 `SingletonResult` / `startFence` / `RunningHub` 的完整新签名与 identity 生命周期                           | §1.3.1–1.3.2 给出 `DirIdentity` / `SocketIdentity {socket, dir}` / `PrivateDirError` / `FsDeps`（`fs/promises`）/ `SingletonResult.owner.identity`（替代 `inode`）/ `SingletonDeps.fs` / `startFence(path, identity, onLost(why: FenceLoss), …, deps)` / `RunningHub.identity` + `lan` / `startHub(deps.fs, deps.lanAssembly)`；identity 的唯一创建点（bind 成功后 `verifyBoundSocket`）、持有者（owner → fence / RunningHub）、释放语义（`release()` 用 lstat + 非 symlink 比对 `identity.socket`；release 后失效）；§1.3.3 逐行列出 `hub.ts:44/46/127`、`singleton.ts:75-78/125-137`、`main.ts:57` 的改动；§1.3.5 迁移测试 |
| 3    | 严重 | SSE 到期复核 tick 会被交互 IPC 饿死                                                                             | §4.2：IPC 在途上限 64 之外**预留 1 个槽**专供 tick / purge；tick 的 touch 在保留槽串行执行，永不占交互槽、也永不被交互槽阻塞；整批 20s deadline；另加按 `absoluteExpiresAt` 的本地硬计时；测试「32 SSE + 持续 3 分钟 history 洪泛 + 8 条到期 ⇒ 下一 tick 内 revoke（< 60s）」；验收 #31                                                                                                                                                                                                                                                                                                                                      |
| 4    | 严重 | `externalOrigins` 应只允许 https，使代理 / 直连 `bound_origin` 天然不同                                         | §2.4 配置校验 + §9.1：`http://` ⇒ `origin-not-https`（settings 丢弃 + status 提示；env `bad-config`）；直连恒 `http`、代理恒 `https` ⇒ 两类入口的 origin 集合不相交；§6.4 / §2.4 补「同主机名双入口 cookie 互用被拒」测试；验收 #30                                                                                                                                                                                                                                                                                                                                                                                          |
| 5    | 严重 | 威胁模型应写明受信任代理失陷的后果；收紧 XFH / XFP                                                              | §1.1 / §13：「受信任代理失陷 = 该代理入口的所有会话完全失陷（可伪造 IP / XFH / XFP、看到并重放密码与 cookie）」为 L24 固有代价，写入 status 文案；§2.4：XFP 必须恰为 `https`（否则 400 `proxy-proto`）、XFH（或缺失时的 Host）canonical 后 `https://<hostKey>` 必须 ∈ `externalOrigins`（否则 421 `proxy-host`），多值 / 非法 ⇒ 400；不再「XFH 优先于 Host」任意采信；补伪造头测试；验收 #29                                                                                                                                                                                                                                 |
| 6    | 一般 | `localhost` 应从 `SINGLE_LABEL_DENYLIST` 删除、由专用分支处理                                                   | §2.1：小名单去掉 `localhost`；分类改为十步显式优先级（ipv6 → ipv4 → too-long → syntax → **localhost** → numeric → denylisted → dot-local → fqdn → single-label）；加「分类优先级」测试（`localhost` / `LOCALHOST` / `localhost.local` / `a.localhost` / `127.0.0.1` / `123` / `123.local` / `dev` / `x.dev` / `a_b` / `::1`）                                                                                                                                                                                                                                                                                                |
| 7    | 一般 | 主线程 fs 调用的边界与启动 / 关闭整体超时                                                                       | 新增 §3.1：hub 侧 fs 全部 `fs.promises` 且只在启动 / bind / fence 路径；`HUB_START_DEADLINE_MS = 20s`、`LAN_START_DEADLINE_MS = 30s`（已有）、fence 单次 5s（连续 3 次 ⇒ `onLost("io")`）、`HUB_CLOSE_DEADLINE_MS = 10s` ⇒ `process.exit`；零 hang 论证补文件系统部分；不引入子进程；P1 遗留的两处同步写记入 §13 残余                                                                                                                                                                                                                                                                                                        |
| 旧 1 | —    | §1.4 契约只是文字描述                                                                                           | §1.4 重写为对照 `ports.ts:12-87`、`hub.ts:22-28/37-176`、`main.ts:36-80`、`http.ts:233-…`、`static.ts:28/38/79`、`sse.ts:26-39/67` 的签名级清单（1.4.1–1.4.6）：每个新增类型 / 字段 / 函数与每个变更的内部函数签名；`LanAssembly` 接缝让 `startHub` 可注入假件                                                                                                                                                                                                                                                                                                                                                               |
| 旧 6 | —    | 硬化接口未真正闭合                                                                                              | 同 #2；`DirPolicy` 三个具名常量（`STATE_DIR_POLICY` / `XDG_SOCKET_DIR_POLICY` / `TMP_SOCKET_DIR_POLICY`）由 `resolveHubPaths` 纯计算选出并可被测试精确断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| —    | 简化 | 收窄                                                                                                            | 代理入口只有一种合法形态（https + 配置的 origin），解析分支从 6 个减到 3 个；`localhost` 专用分支替代小名单特例；tick 保留槽替代抢占逻辑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 15.7 v7 → v8（gpt-sol 复审，打回；安全取舍已全部闭合，只剩接口 / 生命周期不一致；用户决定 v8 为最后一版文档）

| #   | 级别 | 问题                                                         | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞 | `FenceLoss` 未纳入 `"io"`                                    | §1.3.2：`FenceLoss` 七个字面量含 `"io"`，每个的触发条件写在类型注释里；`fenceLossOf(err, identity, seen)` 给出 `PrivateDirError.reason` / ENOENT / identity 不匹配 / 超时与其它 I/O 错误 → `FenceLoss` 的完整映射；`startFence` 的 `deps.checkDeadlineMs = 5s`、`ioStrikes = 3`；§3.1 fence 行同步                                                                                                                                                              |
| 2   | 严重 | 启动超时没有取消链                                           | §1.4.2 / §3.1：`startup: AbortController` 是唯一取消源，`HUB_START_DEADLINE_MS` 定时器 abort 它；signal 传给 `acquireSingleton`（`SingletonDeps.signal`，abort 后自我清理并返回 `failed/aborted`）、`HttpFrontend.listen({signal})`（迟到 listening ⇒ 自己 close）、每个 fs 操作的 `withSignal`、`lanAssembly.build`；失败路径 `cleanup` 逆序回收 + `rootScope.dispose()`；契约测试 ⑦「延迟 resolve 后再次 acquire 必为 owner」                                 |
| 3   | 严重 | 无效 LAN 配置的状态传递未冻结                                | §1.3.2 `StartHubDeps.lanConfigError?: { detail }`（与 `config.lan` 互斥）；§1.4.3 `main.ts` 在 `parseHubLanConfig` 失败时删掉 `config.lan` 并传 `lanConfigError`；§1.4.2 `HubRecord.lan` 的三种来源、`HubJsonWriter` 是唯一写入路径、`RunningHub.lanStatus()`；契约测试 ⑪；Q23                                                                                                                                                                                  |
| 4   | 严重 | `rootScope` / `defaultLanAssembly` / `rewriteHubJson` 未定义 | §1.4.2 重写：顶部三条静态导入（`./lan-assembly.js`、`./lifecycle.js`、`./hub-json.js`）；`rootScope` 由 `startHub` 步骤 ③ 创建、`close()` 在 `fe.close` 之后 `single.release` 之前 dispose、启动失败路径在 cleanup 之后 dispose；`rewriteHubJson` 替换为 `HubJsonWriter { write, patchLan, current, removeIfOurs }` + `createHubJsonWriter(file, log)`；完整的 `close(reason)` 顺序表；片段中的 `withSignal`、`identityFields`、`bounded`、`cleanup` 全部有定义 |
| 5   | 严重 | SSE `auth` 事件的协议 / 前端镜像未纳入冻结包                 | §1.4.6 / §11 W1 文件域：`protocol/http-contract.ts:17-34` 的 `SSE_EVENTS` 加 `"auth"`、新增 `SseAuthPayload`、`API_ERRORS` 加 `E_BUSY` / `E_DB`；`web/contract.js:10` 同步；`tests/web-hub/web/contract.test.ts:8` 的镜像测试自动覆盖；`sse.ts` 的 `auth?` / `revoked?` / `revoke` / `list` 在 W1 完整实现；矩阵加一行                                                                                                                                          |
| 6   | 一般 | crash handler 的 `STEP_DEADLINE_MS = 3s` 与 10s 是否统一     | **保持 3s 为 crash 专用硬退出**：进程状态不可信，尽快 respawn 优于完整清理；信号 / idle / fence 路径用 `HUB_CLOSE_DEADLINE_MS = 10s`；写入 §1.4.2 表、§3.1 表、§13、验收 #34（SIGTERM ≤ 10s）/ #35（crash 对照）与 W1 单测（`process.exit` spy）                                                                                                                                                                                                                |
| —   | 用户 | v8 之后不再做文档复审                                        | §11 W1 重定义为**接口包**：落地清单 A（类型）/ B（完整实现）/ C（桩，抛 `E_NOT_IMPLEMENTED:<包>`）、typecheck 门槛与编译期契约测试、契约测试 ①–⑪、合入门槛「代码评审 + 四件套」；W1 通过前其它包不得开工；W2 只填实桩、改签名 ⇒ 回 W1；LP 的硬化行为从 S0 移到 W2（依赖 W1 的签名），§16 Q-2 相应更新；Q24                                                                                                                                                      |

### 15.8 W1 代码评审（gpt-sol，打回；实施偏差记录，不再更新方案正文——Q24）

按 Q24「之后的分歧以代码 + typecheck + 契约测试为准，方案文档只在 §15 追加实施偏差记录」处理：W1 代码评审打回 10 项（typecheck 未覆盖 `types.test-d.ts`、`lan.port` 未与 `webHub.port` 互斥校验、`externalOrigins` 未反查 `classifyHostToken`、`lan_req`/`lan_res` 判别联合不严格、singleton 启动路径残留同步 fs、fence 单次检查两次 lstat 各领一份预算、`hub-json` 的 patchLan/close 时序、`ConnGuard` 冻结为 `unknown`，以及本行）均已在代码与测试中修复（commit 见 `feat/web-hub-lan` 分支），不逐条改写本文件正文。唯一影响正文措辞的一项：§11 落地清单 B 中「`hostKey`」一词判定为文档笔误——按 §2.2 的 `RequestContext.hostKey` 字段理解，未实现为独立导出函数；`hub/http.ts`/`protocol/lan.ts` 均以此为准。

**W2 实施偏差（主会话授权，2026-09-26）**：

- 冻结接口加法例外 ①：`protocol/paths.ts` 的 `FsDeps` 新增可选字段 `onWarn?`（TMP 宽模式 `chmod 0700` 时的 warning sink，§1.3.1；hub.ts 默认接 `log.warn`）。纯加法、可选，不改变任何既有调用方；另导出纯函数 `identityEquals`，`verifyBoundSocket` 的 `dirBefore` 比较由调用方统一经它完成（契约写在 paths.ts 头注释，源码扫描测试穷举调用点）。
- 冻结接口加法例外 ②：`hub/ports.ts` 的 `ConnLease` 新增 `leaveLoginPending()`（登录终结路径回到可淘汰状态）。
- LC 架构偏差接受：LAN 生命周期（bind → 60s tick → 421 重算 → revoke）由 `hub/http.ts` 自持；W3-LD 不再另写 `lan-controller.ts`，只做 startHub 接线 / admin / hub.json。
- LE 定下的 `WebHubSettings.lan` / `WebHubControl.lan` 接口由 W3-LI 直接采用。

### 15.9 W2 验收打回（LC http / LF web / KDF 并发，修复包 B，2026-09-27）

LC 验收（真机 + 代码评审）打回 5 项、LF 打回 4 项，均在修复包 B 中处置，均为**在冻结签名之内**的填实/纠正，除下面两条主会话显式授权的偏差：

1. **`ConnLease` 新增 `leaveLoginPending()`**（唯一被授权的签名改动）：`enterLoginPending()`/`enterAuthed()` 只覆盖了 §6.3 类表「成功」分支，登录终结的 401/429/异常/超时分支此前无法把 socket 放回可淘汰的 `unauth`——新增方法是那三个分支缺失的逆操作，`hub/ports.ts`/`hub/conn-guard.ts`/`tests/web-hub/contract/fakes.ts`/`types.test-d.ts` 同步落地。
2. **KDF 并发 2 的落点选在 `kdf.ts`（选项 A，非装配层）**：`createKdf()` 内部持有一个 `createKdfSemaphore(2)`，`run()` 排队等待槽位再执行 scrypt，`finally` 释放；`kdf-admission.ts` 的 `acquire().release` 保持空实现——它仲裁的是 §6.2 的公平调度令牌桶（服务时即弹出等待队列，没有需要释放的状态），并发/内存预算是 `kdf.ts` 自己的资源池，两者正交，`release()` 为空是设计使然而非缺陷（原 docstring 已这样写，只是 `kdf.ts` 一侧此前没有落地）。内存预算：`validateKdfParams` 已保证任何从库读出的记录 `128·n·r ≤ 32 MiB`，并发 2 × 32 MiB = 64 MiB 与 §5.1 一致；`defaultKdfParams()`（仅 `setPassword` 改密这一条极少触发的管理路径用到）算出 ≈33 MiB，两个并发改密操作合计 ≈66 MiB，超出 64 MiB 名义预算 ~3%——已接受，不在 LAN 攻击面上（改密不是未鉴权端点，不受洪泛影响）。
3. **SSE 到期复核**（`hub/http.ts`，55s tick）只调用冻结的 `LanStorePort.touchSession`，不是 `lan-store.ts` 内部注释里提到的 `touchSessionReserved`——那需要给 `LanFrontendDeps.store` 加字段（W1 冻结签名改动，本包无权限）。改为运行期鸭子类型探测：若具体 store 实例上恰好存在 `touchSessionReserved` 方法就用它（不占交互槽位的可选优化），否则退回 `touchSession`；两者对调用方是同一保证（成功/失败/expired 的判定逻辑不变）。
4. **登录 429 discriminator**：`API_ERRORS` 新增 `"E_LOCKED"`（`protocol/http-contract.ts` + `web/contract.js` 镜像同步）——加性扩展，不改变任何既有取值的含义：`limiter.admit()` 的普通每 IP 退避锁定 ⇒ `E_LOCKED`（前端走倒计时、不自动重试分支）；`saturated:true` 时仍按 §6.2 原文吐 `error:"E_RATE"`（字面量不变）；`admission.acquire()` 的 KDF 公平调度队列满/等待超时 ⇒ `E_RATE`（前端自动重试分支，此前所有登录 429 一律 `E_RATE`，导致倒计时分支永远不可达）。
5. **初始密码字段名**：登录成功响应统一为方案 §10 原文的 `initialPassword:true`（此前 `hub/http.ts` 误发 `initialPasswordInUse`，与前端 `password-client.js` 读取的字段名不一致）；`GET /api/session` 保持 `initialPasswordInUse`（§7/§5.2 原文，未受影响）。
6. **`web/contract.js` 的 `API.session`/`API.logout`（additive exception）**：这两个端点路径在 `protocol/http-contract.ts` 侧没有对应导出（那侧只有 SSE_EVENTS/API_ERRORS 等线上帧式契约，从未有 `API` 路径表），因此无法用现有的镜像比对测试覆盖；补一条直接断言 `API.session === "/api/session"`/`API.logout === "/api/logout"` 的组件/契约测试，防回归。

---

## 16. 待用户确认

| #   | 问题                                                                                                                                                                                                                                          | 默认（不回复即按此执行）                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Q-1 | v4 全文尚未提交（本文件在 git 中是 untracked）；是否把 v4 归档为 `docs/dev/web-hub/lan-plan-v4-tls-archive.md`（供将来 HTTPS 阶段）                                                                                                           | 归档为独立文件（由主会话复制，本方案作者只改本文件）                                |
| Q-2 | **更新**：LP（P1 硬化行为）现在依赖 W1 落地的签名，无法先于 W1 合入 master。是否接受「LP 随 S1 一并合入」（P1 的 `/tmp` 回落目录缺口在 S1 合入前继续存在；缓解：本机 socket 不走 `/tmp` 回落——`$HOME` 短、`hub.sock` 在 0700 的 stateDir 内） | 接受随 S1 合入；若不接受，替代方案是把 W1 + LP 先合（两包合并评审），再开 W2 其余包 |
| Q-3 | （已由 L24 关闭）                                                                                                                                                                                                                             | —                                                                                   |
| Q-4 | （已关闭）                                                                                                                                                                                                                                    | —                                                                                   |
| Q-5 | （已接受）                                                                                                                                                                                                                                    | —                                                                                   |
| Q-6 | 请主会话把 L24 的两个 settings 键名（`webHub.lan.trustProxyFrom`、`webHub.lan.externalOrigins`，后者只允许 https）与「v8 为最后一版文档、W1 接口包代码评审」补入 `lan-requirements.md`                                                        | —                                                                                   |

## 用户确认（v8，开工）

- 2026-09-26 用户确认 v8 开工。Q-2：LP 随 LAN 特性整体合入（不单独先合 master）。施工：W1 接口包（代码评审 + typecheck 门槛）→ W2 → W3，全部在分支 `feat/web-hub-lan` 上，一并验收后合入 master。
