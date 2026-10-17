# 端口代理：真实浏览器验收

依据：`plan.md` v2 + §R1/§R2，尤其 §10。**本文件是用户执行的清单，不是已通过的验收记录。** 自动测试不能代替浏览器对 Cookie、Fetch Metadata、跨 origin 和新标签页的真实处理。

## 记录与阻塞规则

- 每条记录：日期、hub/UI 版本、系统、浏览器版本、访问方式（loopback token / LAN password / trusted reverse proxy）、结果、脱敏截图或 Network 状态码。不要保存一次性 code、Cookie、token、密码或带凭据的 Jupyter URL。
- **[阻塞]**：发布前必须通过；任何失败立即保留复现并停止放行，不能改成“已知限制”。浏览器 A 组为桌面 Chrome、桌面 Firefox、**iOS Safari（LAN，Safari ≥16.4）**；下文 3–14 至少在这三个环境各执行一次。iOS 用 Mac Safari 的远程 Web Inspector（设置 → Safari → 高级 → Web 检查器）。Chrome 可用 deveye 记录 Network/Console；其他浏览器保留等价证据。
- **[条件阻塞]**：有对应环境就必须通过；没有设备/应用/域名时写“未执行：缺少……”，不能写 PASS。需要的环境未齐备前，完整 §10 浏览器闸门仍未完成。
- **[残余验证]**：确认设计边界，不要求不存在已披露风险；若超出下述边界，则阻塞。
- 只使用临时目录、测试账号和无敏感信息的服务。本功能**不是页面沙箱**；LAN 开启后，已认证的用户能通过 hub 访问它能连到的回环/内网 HTTP 服务，这是明确接受的边界。

## 操作步骤

### 1. [阻塞] 启用设置并真正重启 hub

编辑 `~/.pi/agent/pi-subagent.json`，合并（不要覆盖其他现有配置）：

```json
{
  "webHub": {
    "enabled": true,
    "control": true,
    "proxy": {
      "enabled": true,
      "portRange": "7900-7949",
      "maxProxies": 8
    }
  }
}
```

先确认范围内端口可用，且 **webHub.port / webHub.lan.port 均不在范围内**。随后在 pi 执行：

```text
/reload
/webhub restart
/webhub status
/webhub open
```

**预期：** hub 正常启动，浏览器出现「打开本机端口」入口。LAN 关闭时状态包含 `proxy: on · loopback · 7900-7949 · max 8`；LAN 开启时是 `proxy: on · lan · 7900-7949 · max 8`。无“hub 未挂载端口代理”警告。此功能不是 live 设置：只 `/reload` 不足以更新旧 daemon。

若页面提示 UI 未构建，先按该提示安装与 hub 版本匹配的 UI；源码开发者可在仓库执行 `npm run build:web && npm run check:web` 后重启 hub。

### 2. [阻塞] 启动无敏感数据的本机 HTTP 样例

在 **hub 所在机器** 的单独终端执行，保持运行：

```sh
export PWH_PROXY_DEMO="$(mktemp -d /tmp/pwh-proxy-demo.XXXXXX)"
printf '<!doctype html><meta charset="utf-8"><title>proxy A</title><h1>proxy A works</h1>\n' > "$PWH_PROXY_DEMO/index.html"
printf 'Demo directory: %s\n' "$PWH_PROXY_DEMO"
python3 -m http.server 23434 --bind 127.0.0.1 --directory "$PWH_PROXY_DEMO"
```

另一终端运行 `curl -i http://127.0.0.1:23434/`。

**预期：** HTTP 200，正文 `proxy A works`；Python 访问日志可用于后续判断有没有真的接触上游。不要用项目根目录启动文件服务器。

### 3. [阻塞] TopBar 打开 → 一次性 enter → 303

登录 hub，开启 DevTools Network 的 Preserve log。点击顶部「打开本机端口」，输入 `http://127.0.0.1:23434/index.html?from=dialog`，点击「打开」。记录分配的代理 origin 为 **A**（例如 `http://H:7900`，H 是当前浏览器访问 hub 的主机名/IP）。

**预期：** 一个新标签页加载样例；先请求 `/__pwh_proxy__/enter?c=…`，得到 **303**，`Location` 为 `/index.html?from=dialog`，然后 HTTP 200。地址栏不再保留 enter code。303 设置独立 `pwh_px_<代理端口>`，属性为 **HttpOnly、SameSite=Lax、Path=/**。新页 `window.opener === null`。

在另一个未登录/无痕窗口直接访问 `A/index.html`：应为 **401** 和「链接已失效，请回到 hub 重新打开」。重放已消费的 enter URL：应为 **410**，不能再次获得会话。不要把 code 贴进报告。

### 4. [阻塞] 消息路径链接与 popup fallback

在临时 pi 会话发送包含 `http://127.0.0.1:23434/index.html?from=message#section` 的消息，等待消息落定（不是流式片段），在 hub 点击该路径链接；再试 Markdown 链接 `[样例](http://127.0.0.1:23434/index.html?from=markdown)`。

**预期：** 都通过代理打开，而不是直接访问手机/浏览器所在设备的 loopback；保留路径和 query；**fragment（`#…`）按设计被丢弃**（`hub/proxy/target.ts` 只取 path+query，UI 也不回填），最终地址不带 `#…` 属于正常；iOS Safari 的用户点击能打开新页，不被异步弹窗策略误拦。若主动配置浏览器阻止弹窗，应出现「浏览器拦截了新标签页，请手动打开」及可点击链接，点击后能打开；不能留下永久空白页。

### 5. [阻塞] 两个代理的应用 Cookie 隔离

在第二个终端，先把 `PWH_PROXY_DEMO` 设为步骤 2 打印的**实际临时目录**（环境变量不会自动跨终端继承），再把该目录服务在另一个端口：

```sh
python3 -m http.server 23436 --bind 127.0.0.1 --directory "$PWH_PROXY_DEMO"
```

从 TopBar 打开 `127.0.0.1:23436`，记录 origin 为 **B**，保持 A、B **都已兑换并且会话存活**。在 A 控制台执行 `document.cookie='demo=fromA; Path=/'`，刷新 A、B，在 Network 查看请求 Cookie。随后在 B 执行 `document.cookie='demo=fromB; Path=/'`，刷新两页。

**预期：** A/B 使用不同代理端口和不同 gate cookie 名；**应用 Cookie 并不按端口隔离**，同一主机的 `demo` 可能在两页共享或覆盖，这是浏览器的已知边界，不能宣称被隔离。安全要求是：各自 gate 绑定 origin/实例，A 不能冒充 B；步骤 8 验证这一点。`document.cookie` 不应包含任何**服务器签发的** `pwh_*`（HttpOnly）。主动注入的假 `pwh_*` 另按步骤 10 测试。

为检查上游隔离，在仓库另启现有测试 fixture（随机打印目标端口），通过 TopBar 打开打印的目标，在已兑换的代理页访问 `/headers`：

```sh
timeout 1800 npx tsx -e 'import {proxyUpstream} from "./tests/fixtures/proxy-upstream.ts"; void proxyUpstream().then(up => { console.log("target=127.0.0.1:"+up.port); setInterval(() => console.log("upstream requests="+up.requests.length+" ws="+up.upgraded.size), 5000); process.on("SIGTERM", () => { void up.close().then(() => process.exit(0)); }); });'
```

**预期：** 返回的 JSON `headers.cookie` 没有任何 `pwh_*`；应用 Cookie 可见。保留该 fixture 供步骤 8、11 使用。这与“Cookie 按端口隔离”是两回事。

### 6. [阻塞] 浏览器 WebSocket echo

可选最小 WS 服务（系统已有 Python `websockets` 包时，在另一终端执行；缺少时用步骤 7 的 Vite/Jupyter 完成真实 WS 验证，不要求给仓库安装依赖）：

```sh
python3 - <<'PY'
import asyncio
from websockets.asyncio.server import serve
async def echo(ws):
    async for message in ws:
        await ws.send(message)
async def main():
    async with serve(echo, "127.0.0.1", 23435):
        print("WS echo: 127.0.0.1:23435", flush=True)
        await asyncio.Future()
asyncio.run(main())
PY
```

从 TopBar 打开 `127.0.0.1:23435`（普通 HTTP 页面可能是 426，这是仅提供 WS 的样例，不是代理错误）。在这个**已兑换代理页**的控制台执行：

```js
window.echo = new WebSocket(location.origin.replace(/^http/, "ws") + "/");
echo.onopen = () => echo.send("proxy-browser-echo");
echo.onmessage = (e) => console.log("echo:", e.data);
echo.onclose = (e) => console.log("closed:", e.code);
```

**预期：** Network 有 101，消息面板/Console 收到原样 `proxy-browser-echo`。保持这个连接，供停止/登出/重启检查。仅看到 101 不算 echo 成功。

### 7. [条件阻塞] Vite HMR / Jupyter / NAS

1. 已有 Vite 项目：在 hub 机器运行其正常开发命令（如 `npm run dev -- --host 127.0.0.1 --port 23437`），从代理打开；修改页面可见文案。
   **预期：** HMR WS 为 101，页面无需手动刷新即更新。若项目硬编码了 HMR 的 host/port，记录并按项目要求调整，不能声称代理会重写脚本中的任意绝对 URL。
2. 已有 Jupyter：运行 `jupyter lab --ip=127.0.0.1 --port=23438 --no-browser`，通过 TopBar 输入其本机 HTTP 地址（token 仅本地使用，不留截图），完成 token 登录，执行临时 notebook 的 `1 + 1`。
   **预期：** 返回 `2`，kernel WS 持续可用；重连、保存正常。
3. 已有无敏感数据 NAS：分别输入 `http://<NAS内网IP>:<端口>/` 与 `http://nas.local:<端口>/`。
   **预期：** 两种形式均可达；主机名由 hub 一次解析后固定，不跟随重新解析去公网。主机名用对话框输入，不要求消息自动识别。纯 HTTPS/证书页面不在 v1 范围。

**最少必须有一个浏览器中的真实 WS 数据往返**（步骤 6 或本步骤）；只有静态页面不能放行。

### 8. [阻塞] A 组：跨端口请求不能操纵 hub / 其他代理

在 A 页控制台，把下列两个常量改成**真实直连** hub origin 与已兑换的另一个代理 origin。不要用未登录的新 B 页代替，这样无法排除“只是缺 cookie”的伪通过。

```js
const HUB = "http://H:实际hub端口";
const OTHER = "http://H:另一个代理端口";
fetch(HUB + "/api/proxy", { credentials: "include" }).catch(console.log);
window.probeSse = new EventSource(HUB + "/api/events", { withCredentials: true });
probeSse.onerror = () => {
  console.log("SSE blocked");
  probeSse.close();
};
const form = document.createElement("form");
form.method = "POST";
form.enctype = "text/plain";
form.action = HUB + "/api/cmd";
form.target = "_blank";
const input = document.createElement("input");
input.name = "proxy-csrf-probe";
input.value = "no-command";
form.append(input);
document.body.append(form);
form.submit();
form.remove();
window.hubWs = new WebSocket(HUB.replace(/^http/, "ws") + "/api/events");
window.otherWs = new WebSocket(OTHER.replace(/^http/, "ws") + "/ws");
```

**预期：**

- Network 显示 credentialed fetch、EventSource 和 form POST 都为 **403 `E_CSRF`**；没有 `Access-Control-Allow-Origin`。JS 可能只报 CORS 错误，**必须看服务端状态码，不能把任意网络失败当作 403**。form 没有产生任何命令/会话内容/命令结果（ledger 不应新增）。
- hub WS 不能得到 101；A → B 的 WS 应为 **403**。把 OTHER 指向步骤 5 的 fixture 代理，并与其终端计数对照：B 的 upstream requests / WS 数不应增加。
- hub 标签仍正常工作；新 EventSource 没有成功打开，也不应留下更多 hub SSE 连接。需要服务端佐证时，在 hub 机器用 `ss -ntp` 对照**实际 hub 端口**的 ESTAB 连接数，测试前后不增长（排除正常 API 的短连接/其他浏览器）。这不是新增的 stats API。内部 ledger 的权威回归另见自动 `T-A1`，浏览器不能直接读取它。
- A 页 `document.cookie` 不含服务器签发的 `pwh_*`。关掉测试弹出的标签页和探针连接。

### 9. [阻塞/残余验证] B 组：无 Origin / Fetch Metadata 的旧引擎模拟

**只在无敏感数据的测试 hub** 执行。用 DevTools 复制当前 hub Cookie 到本机 shell 变量 `HUB_COOKIE`（不要回显或写入文件/报告），设置 `HUB=http://127.0.0.1:<实际端口>`，执行：

```sh
curl -i -H 'X-PWH: 1' -H "Cookie: $HUB_COOKIE" "$HUB/api/proxy"
curl -i -H 'X-PWH: 1' -H "Cookie: $HUB_COOKIE" -H 'Origin: null' "$HUB/api/proxy"
curl --max-time 2 -i -N -H "Cookie: $HUB_COOKIE" "$HUB/api/events"
unset HUB_COOKIE
```

**预期：** 第一个 **200**（无两个浏览器头时保留旧行为），第二个 **403**，第三个 **200 SSE** 后在 2 秒主动结束（curl 28 在这里是主动时间上限，不是失败）。无 ACAO。不要并发堆积 SSE。已披露残余：无 Origin/Metadata 的客户端持有复制 Cookie 时能读 API/占 SSE；不是所有旧引擎请求都被 P4 拦截。B 组不能代替 A 组，也不要求它误拒绝合法 CLI。

### 10. [阻塞] Cookie 注入、冲突及手动恢复文案（§R2 #4）

> **按模式分开执行**：token（loopback）模式只做「唯一有效身份仍可认证」这一段——它的超限（8 候选）在浏览器里做不到：loopback 只接受 `127.0.0.1`/`localhost:<port>` 作 Host，host-only 且 `Path=/` 的 hub cookie 最多凑出约 6 个候选，所以 token 超限只由自动测试覆盖（`tests/web-hub/http/auth-identity.test.ts` 等），这里记「浏览器不可达，自动测试覆盖」。LAN（上限 3）两段都做；下方父 Domain（`hub.proxy.test`）那一行**只适用于 LAN**（依赖 `webHub.lan.extraHosts`）。

在一次性浏览器配置文件操作，**保留 hub 自己的有效登录**。从 A 页控制台对当前 host 执行（token 测 `pwh_sid`，LAN 测 `pwh_lan`）：

```js
const name = "pwh_sid"; // LAN 改为 pwh_lan
// token：两条 path 都跑（共 4 个 junk，未超 8）；LAN：只跑 ["/api"]（2 个 junk，未超 3），超限另测
for (const path of ["/api", "/api/history"]) {
  document.cookie = `${name}=junk-${path.replaceAll("/", "-")}; Path=${path}`;
  document.cookie = `${name}=domain-junk-${path.replaceAll("/", "-")}; Path=${path}; Domain=${location.hostname}`;
}
```

**预期：** 同一请求**仅一个有效身份**且候选不超限时仍认证为原用户；token 上限 8、LAN 上限 **3**，LAN 要先只注入两个 junk 验证唯一有效路径，再单独测试超限。用 DevTools 确认 Cookie 确实发出（IP 上浏览器可能拒绝 Domain；这种行改用专用测试域名，不算已测）。

再制造超限。浏览器按 Path 段匹配，不能靠 `/api/p`、`/api/pr` 等非段前缀给 `/api/proxy/open` 堆候选；host-only 与 `Domain=<同一host>` 也不保证形成两个存储项。为真实覆盖父 Domain，准备专用测试名 **`hub.proxy.test`**（hub/手机 DNS 或 hosts 指向 hub LAN-IP，LAN 的 `extraHosts` 同时加入这个名字，重载/重启后以这个名字登录和打开 A）。在 A 控制台执行：

```js
const cookieName = "pwh_sid"; // LAN 改为 pwh_lan
const paths = ["/api", "/api/", "/api/proxy", "/api/proxy/", "/api/proxy/open"];
for (const [i, path] of paths.entries()) {
  document.cookie = `${cookieName}=host-junk-${i}; Path=${path}`;
  document.cookie = `${cookieName}=parent-junk-${i}; Path=${path}; Domain=proxy.test`;
}
```

（仅 LAN）从 hub 对话框点击「打开」，检查 `/api/proxy/open` 的 Cookie header：只需 4 个不同值即可超出 LAN 的 3 候选（token 模式不做这一段，见本节开头）。**须用 Network 核对实际发出的候选数量**，不要把被浏览器拒存的 Cookie 算入测试。若没有可用测试 DNS/父 Domain，该行标为未执行，不能用 curl 代替浏览器 PASS。`/api/history` 的 junk 只会匹配该路径，另通过 Network 确认它不会污染 `/api/proxy`。非段 Path/父 Domain 不承诺自动清除，恢复按下文手动处理。

**预期：** 超限返回 **401 `E_AUTH{reason:cookie-conflict}`**，响应有 best-effort 清除 Cookie；在「打开本机端口」操作中可见文案：

> 检测到重复的登录 Cookie（可能来自同一主机的其他端口）。请在浏览器中清除本站 Cookie 后重新登录。

恢复操作：关闭测试代理页，在浏览器“网站数据/Cookie”管理中清除**同一 host 及其父 Domain** 的相关 Cookie（不仅 hub 端口），重新打开 `/webhub open` 链接或 LAN 登录，再开代理。

**预期：** 可以恢复；不能承诺自动清除涵盖所有非段 Path/父 Domain。另测两个不同有效 LAN sid：用另一个测试浏览器登录取得测试 sid，在受害者有自己有效会话时植入第二个有效 sid，触发 401/conflict，**绝不能静默切成另一身份**。没有受害者自己会话时可能被当成另一有效登录，是已披露残余；用测试账号记录后立即清理。禁止把复制的 sid 写进记录。

### 11. [阻塞] 恶意上游不能清掉或覆盖 hub 登录

使用步骤 5 的 fixture 代理访问 `/headers`，再从该代理页发起 `new WebSocket(location.origin.replace(/^http/,'ws')+'/ws-reject')`；还可在 Network 检查 fixture 的 `/ws` 101 握手（它是原始帧测试 fixture，不用于步骤 6 的标准浏览器 echo）。

**预期：** `/headers` 原本带 `Clear-Site-Data: "cookies","storage"`，`/ws-reject` 原本是带同类头的非 101 响应，101 握手也带该头；**浏览器收到的三种响应都不含 Clear-Site-Data，也不含上游设置的 pwh_sid/PwH_lan Set-Cookie**。普通 `app=ok` 可保留但没有 Domain 属性。每次返回 hub 页刷新仍登录，原 gate 会话仍可用。

### 12. [条件阻塞] 外部链接与 OAuth/SSO 式 GET callback

> 前置条件：可用的测试 DNS/hosts，让 `idp.other.test`（另一个 site）指向测试机器。没有时记「未执行：缺少测试 DNS」。

保持 A 已兑换。在**另一个 site** 的页面放一个指向 `A/index.html?external=1` 的链接，点击它做**顶层 GET**导航。可让自己的测试 DNS 将 `idp.other.test` 也指向测试机器，以该域名服务一份含 `<a href="http://H:代理A端口/index.html?external=1">外部链接</a>` 的静态页。它与 `hub.proxy.test` 是不同 site；只换端口仍属 same-site，不能当成 Lax 的 cross-site 验证。再用一个临时“假 IdP” HTTP 服务返回 `302 Location: A/index.html?code=fake-test-code`，以 `http://idp.other.test:23439/` 进入它。

可在另一终端用 Python 启动最小假 IdP（把 A 改为真实代理 origin；**不使用 enterUrl**）：

```sh
PROXY_A='http://H:代理A端口' python3 - <<'PY'
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
class IdP(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header('Location', os.environ['PROXY_A'] + '/index.html?code=fake-test-code')
        self.end_headers()
HTTPServer(('0.0.0.0', 23439), IdP).serve_forever()
PY
```

**预期：** 外部顶层链接和 302 callback 都携带 Lax gate、最终 HTTP 200，不要求重新兑换。测试结束立刻关掉临时 IdP。跨 origin POST / OAuth `form_post` 被拒绝是既定限制，不纳入可用性承诺。

### 13. [阻塞] 停止与重启后的持久端口 / 重新进入

1. 保持 echo/HMR/kernel WS 活跃，在 hub 对话框点该代理「停止」。
   **预期：** WS 立即关闭，该代理行移除/刷新后不再存在；代理端口连接被拒绝（不是继续转发），其他代理仍可用。重新打开同一目标仍使用已绑定端口。
2. 再打开同一目标，记下代理端口，保持页面及 WS。执行 `/webhub stop`。
   **预期：** hub 与代理监听均关闭，WS 断开；本机 `curl --max-time 2 http://127.0.0.1:<代理端口>/` 连接拒绝。
3. 执行 `/webhub start`（或单独验证 `/webhub restart`），重新登录 hub，再打开**完全相同的 host:port**。
   **预期：** 使用重启前相同代理端口；旧页面直接刷新在监听重建后为 **401**「链接已失效」，旧 enter code 为 **410**，只有从 hub 新生成的一次性链接重新进入才恢复。端口绑定持久化不等于登录持久化。不要删除 `ports.json` 来让测试通过。

### 14. [阻塞] 登出 / 密码变更 / token rotate 撤销

每个小项前都重新登录 hub、重新打开代理并确认 HTTP 和 WS 有效：

1. hub 页点登出。
2. LAN 模式在 pi 执行 `/webhub passwd`，完成密码变更。
3. loopback token 模式执行 `/webhub token rotate`。

**预期：** 对应父登录下的代理 WS 关闭；旧代理页下一次请求返回 **401**「链接已失效」，不能继续接触上游；旧 code 不可再次兑换。密码变更要求重新登录 LAN，token rotate 要从新 `/webhub open` 链接登录。本项 token 与 LAN 两条撤销链都必须覆盖。

### 15. [阻塞] LAN 开/关与 iOS Safari 实际可达性

先设置 `webHub.lan.enabled=true`（LAN 端口不能落在代理范围），`/reload` 后 `/webhub restart`，用 `/webhub passwd` 配置测试密码。在同一 LAN 的 iPhone Safari 登录 `http://<hub机器LAN-IP>:<LAN端口>/`，重复步骤 3–6、8、10–14。只在测试 LAN 放行代理范围的防火墙端口。

**预期：** 能通过 LAN host 的代理新页访问 hub 机器的回环服务；列表说明 LAN 可达且受一次性链接/独立会话保护，cap 为 `proxy.lan.v1`。错误主机名不可绕过 Host 检查。

再设置 LAN 关闭，`/reload` + `/webhub restart`，从本机 token 模式重新打开相同目标；从另一台机器访问该代理端口。

**预期：** 本机仍可用，另一主机连接拒绝/不可达；无 LAN 入口、无 `proxy.lan.v1`，状态显示 loopback。确认本机服务正常，不能把“整个 hub 没启动/防火墙全拦”当作 loopback-only 的证据。

### 16. [条件阻塞] trusted reverse proxy / SSH tunnel 提示

经已配置的可信反向代理（`trustProxyFrom` + `externalOrigins`）登录 LAN hub，在对话框打开/停止。

**预期：** **409 `E_PROXY_UNAVAILABLE{reason:reverse-proxy}`**，有“经反向代理访问时无法使用端口代理，请使用 hub 的直连地址”说明；列表仍能读取，不会新开监听。

经 SSH 隧道只转发 hub 端口时，按对话框提示同时转发代理范围后再打开。

**预期：** 提示明确需转发代理端口；只转发 hub 不保证代理可达，不能当成自动隧道功能。

### 17. [阻塞] 状态诊断与 feature-off

- 在测试配置中设 `webHub.control=false`，重载/重启后查看 `/webhub status`。
  **预期：** 提示代理属于控制面、未启用；不出现可用的代理入口。
- 改回 control 开启，确认正常 `proxy: on` 行；若有“hub 未挂载”警告，先检查版本、重载/重启、范围冲突，**不能带警告放行**。
- 仅在可丢弃测试 HOME 验证损坏 store：停止 hub、备份 `ports.json`、改成无效 JSON、重启并尝试打开。
  **预期：** 打开 fail-closed；`/webhub status` 提示损坏/不可写及手动恢复路径，不能静默清空。恢复须先 `/webhub stop`；优先还原备份。若选择删除该文件，必须接受“遗忘全部目标↔端口绑定、浏览器旧 origin 存储可能保留”的警告，并在浏览器清理相关数据。不在日用 HOME 做此项。
- 最后设置 `webHub.proxy.enabled=false`，`/reload` + `/webhub restart`。
  **预期：** 不再有 proxy 状态行/cap/UI 入口，新 API 为 404，无代理监听；已有磁盘绑定文件不要求被删除。恢复希望保留的配置，停止临时 HTTP/WS/IdP/fixture 服务，清除测试 Cookie，删除**自己创建的精确临时目录**。

## 结果模板

| 步骤                                | 浏览器/模式                                | PASS / FAIL / 未执行及原因 | 脱敏证据 |
| ----------------------------------- | ------------------------------------------ | -------------------------- | -------- |
| 1–17（分别填写，不合并成一个 PASS） | Chrome / Firefox / iOS Safari LAN / B组CLI |                            |          |

**当前状态：待用户执行。** 自动 T-I1 和 UI 契约测试的结果记在 `X3-report.md`，不作为本表的浏览器 PASS。

## 与 plan 的偏差

- plan §10.3 提到的 `proxy-probe.html` 未提供；本清单用浏览器控制台片段 + `tests/fixtures/proxy-upstream.ts` 等价替代（见 X3-report.md）。
