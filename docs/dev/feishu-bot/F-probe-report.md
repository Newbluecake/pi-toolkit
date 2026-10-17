# F-probe 实现与自验报告

日期：2026-10-17。范围：已批准 `plan.md` 的 F-probe 包；**未实现任何机器人代码，未接触真实飞书租户，没有提交 commit**。

## 交付

- `scripts/dev/feishu-probe.ts`：Node 22.22 原生类型剥离入口；参数检查、P1–P8 选择/跳过、中文操作提示、V1–V12 汇总、退出码及中断保存。
- `scripts/dev/feishu-probe/codec.ts`：手写 pbbp2 Frame/Header、uint64 bigint、未知 wire 0/1/2/5 跳过、严格截断/溢出检查、乱序分片/重复检查/TTL/容量、SDK 形状 ACK。
- `scripts/dev/feishu-probe/qr.ts`：自包含 byte-mode QR-L（版本 1–40，固定合法 mask 0），半块字符与 quiet zone；精简改编自 Nayuki，保留完整 MIT 声明。
- `scripts/dev/feishu-probe/errors.ts`：安全错误分类、凭据检查明细和白名单 scope 提取（不保留原始 Error.message / API msg）。
- `scripts/dev/feishu-probe/safety.ts`：HTTPS/WSS allowlist、脱敏/哈希、私有目录、安全凭据读取、0600 原子写入。
- `scripts/dev/feishu-probe/runtime.ts`：有界 HTTP、内存 token、每次全新 endpoint、原生 WebSocket、ping/pong、分片事件/ACK、租户基线、限额观察、取消/清理。
- `scripts/dev/feishu-probe/steps.ts`：P1–P8 实际交互操作。
- `tests/scripts/feishu-probe-codec.test.ts`：28 个纯协议/脱敏/二维码/安全文件/参数测试。
- `tests/scripts/feishu-probe-runtime.test.ts`：15 个离线传输/步骤/原生 Node CLI 测试；fetch/WebSocket 全部替换，CLI 子进程用禁止网络的 preload。
- `tests/scripts/feishu-probe-registration.test.ts`：13 个 stub fetch + 假时钟 + 临时私有目录的 P1 状态机/安全诊断测试。
- `docs/dev/feishu-bot/probe-results.md`：真人操作指南、V# 分项“待填”模板及放行/裁剪记录。

未修改 `src/`、`package.json`/依赖、Vitest 配置、任何 web-hub 文件或既有其他工作区改动。
`vitest.config.ts` 的 `tests/**/*.test.ts` 已覆盖 `tests/scripts/**`，无需配置变更。

## 实现功能（不是租户验收结果）

| 步骤 | 实现的观察                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | PersonalAgent form device flow；accounts 两品牌 allowlist；扫码 URL + 终端 QR；interval、slow_down +5s、品牌切换、≤600s 到期；成功前不替换凭据；取消后不提交晚到结果 |
| P2   | fresh bootstrap、HTTP/API code、WS host/service_id（device_id 哈希）、ClientConfig、ping/pong；拒绝未授权目的地，绝不打印 WS query                                   |
| P3   | owner 私聊、envelope 字段/身份一致性、编码、原始 create_time 数值与单位推断、ACK {code:200}、有限重复观察；区分“发送 ACK”与“证明服务端接受”                          |
| P4   | 故意不 ACK→关闭→全新 endpoint/连接，按 event/message ID 匹配重投、延迟/窗口；两条活连接收样本、A/B 分布；不把“窗口内没收到”当永久不重投                              |
| P5   | schema-2.0 两张按钮卡；config.update_multi 缺省/true 对照；回调 app/tenant/operator/context、ACK 响应、控制台开关提示及改后重测；两张分别 PATCH                      |
| P6   | Typing 添加/删除；上传并发送生成的 16×16 PNG/文本；接收用户图片/文件后下载资源（≤8 MiB，仅内存），记录 HTTP/API code/字节数                                          |
| P7   | 普通群入群+@、reply_in_thread、响应/关联后续消息 thread_id；独立话题群 @；普通群新建话题需用户观察确认                                                               |
| P8   | 只在内存中生成错误 secret，分别测 bootstrap/auth API code；磁盘凭据不变；第二位用户搜索/可见性与私聊到达，独立运行时先固定 owner 租户基线                            |

`--steps P1` 首次运行，然后 `--reuse --steps P2,P3,P4,P5,P6,P7,P8`。每步和子检查都能跳过；所有等待有限且可 Ctrl-C。
状态为 pass/fail/skipped/unknown；多子项事实必须查看分项，不能只看聚合状态。
`liveAttempted` / `untestedLive` 仅标记联网尝试，不表示验证通过。
报告最多每步 256 条/512 KiB，单观察 32 KiB，限额丢弃有计数；正文长度化、标识哈希、secret/token/device_code/URL 隐去。

## 上游依据与关键澄清

协议逐字节依据：

- `https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/ws-client/proto-buf/pbbp2.js`
- 同 commit 的 `ws-client/index.ts`、`enum.ts`、`data-cache.ts`（只读 HTTPS 获取到 `/tmp`，不作为依赖）。
- `LogIDNew`（field 9）实际为 **string**；只有 SeqID/LogID 为 uint64，使用 bigint 防止精度损失。
- 字节向量由临时加载真实 pinned `Frame.encode` 生成，非本探针自生成：仅将该文件 ESM export 改成临时 CJS；使用已有 dev `protobufjs/minimal`。测试内固化 ping、pong、分片/max-uint64、ACK hex，并正反验证。上游禁用了 util.Long，max-uint64 输入使用 `{low:-1,high:-1,unsigned:true}`，不经 JS number。
- ACK 回显帧字段和 headers，追加非负 `biz_rt`，payload 为 `{"code":200}`；不实现被 V1 删去的 card-response-in-ACK。
- 向方案作者咨询确认：P5 的 `update_multi` 是**卡片 JSON 中的 config 字段**，不是 PATCH 请求参数；P1 表单/返回值/品牌切换按研究中的 multica registration 行为。其租户可用性仍待真人测试。
- QR 改编参考 Nayuki `QR-Code-generator@3c6d0b3cefb4e049dc337e82237c9644399716a8`；固定 mask/byte mode 的三个矩阵 hash 与该版本真实输出一致，包括 UTF-8 与多块/版本信息 QR。

## 本轮验收修复（11 项）

**纠正首版验证边界：首版只测了协议/部分传输和 P5/P8，没有 P1 注册状态机测试；实现表不能视作 P1 已被测试覆盖，更不代表真实租户通过。** 本轮新增 P1 stub fetch 测试后才建立以下离线证据。

1. P1 根据 JSON error / credential 字段转移，HTTP 400 pending/slow_down 正常继续；未知/垃圾响应仍失败。
2. 注册 POST 仍严格 accounts allowlist；仅展示的 QR URL 单独允许 HTTPS .feishu.cn/.larksuite.com 子域，包括真实 open.feishu.cn/page/launcher 形状，拒绝 userinfo/非 443 端口。
3. schema-2.0 按钮使用 `behaviors:[{type:"callback",value:{n}}]`；回调仍按 `action.value.n` 关联。
4. 新增 13 个 P1/诊断测试：HTTP 400 pending→success、slow_down +5s、到期不写凭据、open.feishu launcher、跨品牌无延迟轮询、网络重试/上限、垃圾 body 拒绝、按 credential 字段而非状态识别成功。
5. 失败保留 unreachable / timeout / http-<status> / api-code-<n> / credential（以及协议/握手等补充类别），不保留任意错误文本；只提取固定 scope 命名空间下的 `[a-z_.:]+` 型标识。V3 测试直接验证缺失 scope 可见而 msg/secret 不泄漏。
6. payload_encoding 无论取何值都先尝试 UTF-8/JSON；仅实际解码失败才记录并 ACK/drop。
7. 暂时网络错误最多连续重试 4 次（1/2/4/8s 退避且不快于 poll interval），仍受总 expires 限制；品牌切换后立即重轮询。
8. 文档注明全局 WebSocket 不提供失败升级的响应头/body：握手阶段 1000040350 等只能观察 ws-handshake-failed，不能宣称取得真实平台代码。bootstrap JSON 的代码不受此限制。
9. P4 提示和运行示例建议 --timeout 300 或更长，避免把 90s 的负面样本当重投保证。
10. 重新核对 pinned SDK index.ts `handleEventData`：type≠event 立即 return，**不会 ACK legacy card**。本探针按 SDK 处理；计划 §2.3 表中“非 event ACK”描述与 pinned SDK 不一致，未擅改计划。
11. 凭据读取逐项诊断 symlink / owner / mode / size 等，并 lstat + O_NOFOLLOW/fstat 复核；上传图片改为有效 16×16 PNG，离线测试检查实际 FormData Blob 的 PNG 签名/IHDR 尺寸。

## 自验

环境：Node **v22.22.1**。以下均通过：

```sh
timeout 280 npm run typecheck
npx tsc --noEmit --strict --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --target es2023 --skipLibCheck scripts/dev/feishu-probe.ts
node scripts/dev/feishu-probe.ts --help
npx vitest run tests/scripts
npm run build
npx prettier --check scripts/dev/feishu-probe.ts scripts/dev/feishu-probe/*.ts tests/scripts/feishu-probe*.test.ts docs/dev/feishu-bot/probe-results.md docs/dev/feishu-bot/F-probe-report.md
```

结果：项目类型检查通过；脚本独立严格类型检查通过；plain node 帮助成功且无网络/落盘；三套定向测试 **56/56**；项目 build 通过；上述文件 Prettier 通过。
原生 Node 子进程测试还真实验证：参数错误退出 2、Ctrl-C 退出 130、readline 原始 TTY Ctrl-C / EOF 取消、完整清理后退出、部分 JSON 可解析、目录 0700/报告 0600、未测事实保持 unknown，未联网步骤保留在 untestedLive 中。
未运行全仓库完整测试集；未进行真实浏览器/手机扫码、租户或飞书 API 验收。

## 尚未真人测试（不能据此放行依赖包）

| 步骤 | 未实测的租户事实                                                              |
| ---- | ----------------------------------------------------------------------------- |
| P1   | 真实扫码注册、PersonalAgent 授权页、品牌切换、返回 credentials/owner 字段     |
| P2   | V1，V6 ping/pong 的真实 host、ClientConfig、连接限制                          |
| P3   | V2a、V6、V10：默认消息订阅、真实编码/envelope、ACK 平台接受、create_time 单位 |
| P4   | V7：跨连接重投/延迟/horizon、双连接事件分配                                   |
| P5   | V2b、V5：默认回调/控制台开关、客户端 ACK 效果、update_multi 的 PATCH 要求     |
| P6   | V3、V9：默认 reaction/upload/send/download 权限、Typing 是否存在及 UI 效果    |
| P7   | V3、V4、V8：群 @/入群/话题群、普通群创建话题与 thread_id                      |
| P8   | V11、V12：真实错误凭据代码、非创建者可见性/私聊                               |

`probe-results.md` 仍全是“待填”，未制造真实租户报告或能力结论。
真人运行会留下测试应用/卡片/消息/附件；中断可能留下 Typing。探针不擅自删除这些平台对象。
有限采样不能证明无限期重投保证、随机分配规律或“send 成功=ACK 被接受”；相关结论需用户据报告/客户端观察填写。

## Main-session fix after round-2 verification (r_8CM42TPV, conditional pass)

P1 poll regression fixed: the documented brand-switch body `{user_info:{tenant_brand:"lark"}}` (no error, no credentials) now
switches domain and re-polls immediately (checked before the pending/success decision), and an empty `{}` / missing-or-empty
`error` without any credential field keeps polling (multica: authorize redirect window). Partial credentials
(`client_id` or `client_secret` alone) are still rejected. Tests updated to the documented shapes (58/58).
