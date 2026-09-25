# web-hub 局域网访问 —— S2-W0 浏览器 spike 结果（Chromium only，L18）

> 闸门任务产物。范围按 `lan-plan.md` §2.2 的 S2-W0 表与 `lan-requirements.md` L9/L12/L15/L18：只测 Chromium（本机
> `/snap/bin/chromium`，snap 包，两个可执行名指向同一份 snap 安装）；Firefox / Safari **未验证**，按「不保证遵守
> nameConstraints」处理（arch/`/webhub ca` 后续要照此写警示文案）。
>
> 环境：Chromium **152.0.7977.64**（snap，headless=new）、OpenSSL 3.0.2、Node v22.22.1、Ubuntu 22.04（jammy）。
> 本机 hostname 恰好是全数字字符串 `202507220006`（sandbox 分配，非常规），过程中额外发现并记录了一个由此触发的
> Chromium URL 解析限制（见 §5），与 nameConstraints 本身无关。

## 0. 方法论与一次性环境问题（供复现/复盘）

1. **certutil**：本机现已有系统级 `/usr/bin/certutil`（`libnss3-tools`）。用它把测试 CA 导入 NSS 数据库，
   trust flag 用 `-t "C,,"`（"CT,C,C" 也验证等效）。
2. **NSS 数据库路径不是 `--user-data-dir`，而是 `$HOME/.pki/nssdb`**：这是本次 spike 踩到的关键坑。
   Chromium 152 在 Linux 上仍然从 `$HOME/.pki/nssdb`（NSS softoken）读取用户导入的信任锚，但**不**从
   `--user-data-dir` 指向的 profile 目录读取（`certutil -d sql:<user-data-dir> -A ...` 完全不生效，会看到
   `NET::ERR_CERT_AUTHORITY_INVALID`，即"CA 未被信任"而不是 nameConstraints 相关错误——说明证书链本身没问题，
   只是没人信任这张 CA）。
   而且由于 Chromium 是以 **snap 包**形式安装的，`snap run chromium`（`/snap/bin/chromium` 的实际入口）会强制把
   `$HOME` 重写为 `~/snap/chromium/<rev>`（snap 的沙盒私有目录），**无视调用方传入的 `HOME` 环境变量**——即便在子
   shell 里 `env HOME=/tmp/xxx chromium` 也不生效，因为改写发生在 `snap run` 内部（用 `snap run --shell chromium`
   验证过：`echo $HOME` 输出的仍是 `~/snap/chromium/<rev>`）。也验证过绕开 snap 直接跑内部 ELF
   (`/snap/chromium/<rev>/usr/lib/chromium-browser/chrome`) 不可行：缺 `GLIBC_2.38`（snap 的 core 基座库不在
   系统库搜索路径里，脱离 snap-confine 的挂载命名空间就用不了）。
   **本次采用的合规替代方案**：证书信任导入到 Chromium 实际会读的路径 —— `~/snap/chromium/<rev>/.pki/nssdb`。
   这是 Chromium 自己的 snap 私有用户目录（`ls` 确认导入前该目录下 NSS 数据库是空的：无任何已有证书，说明这个
   snap 用户从未手动信任过任何 CA），**不是** `/etc/ssl`、`/usr/share/ca-certificates`、系统级 p11-kit 之类的
   系统信任库，也不是任何其它程序共享的路径。每次切换 CA（A→B）之前用 `certutil -D` 精确删除本次导入的临时
   nickname（`pi-webhub-SPIKE-CA-*-TEMP`），全部测试结束后 `certutil -L` 确认该目录恢复到导入前的空列表。
   全程未触碰 `/etc/ssl`、`update-ca-certificates`、任何系统级信任库。
3. **snap 沙盒的确认结论**：因此"临时 Chromium profile"在这个 snap 安装下，退化为「临时的 `--user-data-dir`
   （历史/Cookies/缓存隔离）+ 精确导入/精确回滚的 snap 私有 NSS 数据库（信任锚隔离，通过导入前后
   `certutil -L` diff 为空来保证零残留）」，而不是字面意义上完全独立的用户目录树。这是 snap 包装带来的限制，
   不代表 Chromium 本身的证书验证逻辑与本文档结论无关——nameConstraints 判定的证据链（§2–§4）不受此影响。
4. **验证服务端**：Node `https.createServer`，每个用例一个独立端口（`127.0.0.1` / `0.0.0.0` 按需绑定；IP 用例
   用 `127.0.0.2` 代替方案里假设的"同网段另一地址 `192.168.31.26`"，因为后者不在本机可控范围内，而
   `127.0.0.0/8` 整段天然路由到 loopback、无需 root 配置别名 IP。语义等价：CA 只 permit 了 `127.0.0.1/32`，
   `127.0.0.2` 同样落在"精确 IP 之外"这个测试意图里）。
5. **DNS 用例**用 Chromium 的 `--host-resolver-rules="MAP <name> 127.0.0.1"` 做名字→loopback 映射，不依赖真实
   DNS 或改 `/etc/hosts`（未改系统 `/etc/hosts`）。
6. **取证方式**：headless Chromium + 自写的最小 CDP 驱动脚本（Node 22 内置 `WebSocket`/`fetch`，走
   `Page.navigate` + `Network.loadingFailed` + `Page.captureScreenshot`），未使用 `--ignore-certificate-errors`
   或任何"忽略证书错误"开关；deveye 在本环境下 `browser create --headless` 需要远程 server（`DEVEYE_SERVER`），
   本机未配置，故直接用 CDP 协议驱动同一个真实 `/snap/bin/chromium` 二进制，观测到的是浏览器真实的证书验证行为。

## 1. CA 配方（严格照抄 `lan-plan.md` §2.1/§2.2）

两张 CA，`permitted;IP` 覆盖本机 `192.168.31.25/32` + `127.0.0.1/32`，`permitted;DNS` 覆盖
`localhost`、`<h>.local`、`<h>`（`RSA-3072`，`sha256`，`basicConstraints=critical,CA:TRUE,pathlen:0`，
`keyUsage=critical,keyCertSign,cRLSign`，`nameConstraints=critical,@nc`）：

- **CA A（带子域排除）**：额外加 `excluded;DNS=.localhost` / `.{h}.local` / `.{h}`。
- **CA B（不带排除）**：只有 permitted，没有 excluded。

因为本机真实 hostname `202507220006` 是全数字（见 §5 的额外发现），额外做了一组**同配方、非数字单标签
主机名**（`labhost`）的 CA A2/B2，专门用于 C4/C5（验证子域排除逻辑本身，不被数字主机名的解析限制干扰）。

```
X509v3 Name Constraints: critical
    Permitted:
      IP:192.168.31.25/255.255.255.255
      IP:127.0.0.1/255.255.255.255
      DNS:localhost
      DNS:202507220006.local
      DNS:202507220006
    Excluded:            <- 只在 CA A / A2 里出现
      DNS:.localhost
      DNS:.202507220006.local
      DNS:.202507220006
```

leaf：`RSA-2048`，`sha256`，397 天，`CA:FALSE`，`keyUsage=digitalSignature,keyEncipherment`，
`extendedKeyUsage=serverAuth`，`subjectAltName` 按用例设置。

## 2. 用例与结果（严格对照 `lan-plan.md` §2.2 表；C1–C5 定义以该表为准）

| 用例 | leaf SAN                                                         | 期望（CA A / CA A2） | 期望（CA B / CA B2） | **实测 A**                                | **实测 B**                  | 判定                                     |
| ---- | ---------------------------------------------------------------- | -------------------- | -------------------- | ----------------------------------------- | --------------------------- | ---------------------------------------- |
| C1   | `IP:192.168.31.25`、`DNS:202507220006.local`、`DNS:localhost`    | 通过                 | 通过                 | ✅ 三个名字全部 200 OK，无告警            | ✅ 同上                     | 功能：**符合期望**                       |
| C2   | `IP:127.0.0.2`（替代"同网段另一地址"，见 §0.4）                  | 拒绝                 | 拒绝                 | ✅ `NET::ERR_CERT_INVALID`                | ✅ `NET::ERR_CERT_INVALID`  | IP 精确约束：**符合期望**                |
| C3   | `DNS:evil.test`                                                  | 拒绝                 | 拒绝                 | ✅ `NET::ERR_CERT_INVALID`                | ✅ `NET::ERR_CERT_INVALID`  | DNS 约束：**符合期望**                   |
| C4   | `DNS:<h>`（单标签，精确；用 `labhost` 代替数字 hostname，见 §5） | 通过                 | 通过                 | ✅ 200 OK                                 | ✅ 200 OK                   | 功能（排除没有误伤精确名）：**符合期望** |
| C5   | `DNS:sub.<h>`、`DNS:x.<h>.local`（同用 `labhost`）               | 拒绝                 | 通过                 | ✅ 两个子域都被拒绝（`ERR_CERT_INVALID`） | ✅ 两个子域都通过（200 OK） | 子域排除：**符合期望**                   |

**逐条证据**（`openssl x509 -text` 摘录 + Chromium 实测）：

### C1 — 功能性（两张 CA 都应通过）

- leaf（CA A 版）SAN：`IP Address:192.168.31.25`（另两个变体加 `DNS:202507220006.local`、`DNS:localhost`）。
- `https://192.168.31.25:20001/`、`https://localhost:20001/`、`https://202507220006.local:20001/`
  （host-resolver-rules 映射到同一 Node https 服务器）：CDP `Network.loadingFailed` 为空、页面渲染出服务端返回的
  纯文本 `OK c1_leaf_A on ...`，无 `chrome-error://` 跳转 → **通过**。CA B 同证书结构，结果相同。

### C2 — IP 精确约束

- leaf SAN：`IP Address:127.0.0.2`（CA 只 permit 了 `127.0.0.1/32`，`127.0.0.2` 在约束之外）。
- `openssl verify -CAfile ca.crt leaf.crt` 先行复核：`verification failed`（两张 CA 都一样，约束在证书链层面
  就已经生效，与浏览器实现无关）。
- Chromium 导航到 `https://127.0.0.2:20003/`：`finalUrl=chrome-error://chromewebdata/`，
  `Network.loadingFailed.errorText = "net::ERR_CERT_INVALID"`，页面标题 "Privacy error"，正文含
  `Attackers might be trying to steal your information from 127.0.0.2`。**与 C1 的
  `NET::ERR_CERT_AUTHORITY_INVALID`（CA 不被信任）是不同的错误码**，`ERR_CERT_INVALID` specifically 是「CA 被信任，
  但这张 leaf 违反了它的 nameConstraints」——这正是我们要证明的行为。

### C3 — DNS 约束

- leaf SAN：`DNS:evil.test`。`--host-resolver-rules="MAP evil.test 127.0.0.1"` 让浏览器把它解析到我们的测试
  服务器（不依赖真实 DNS，也没有改 `/etc/hosts`）。
- 结果同 C2：`ERR_CERT_INVALID` + "Privacy error" 拦截页。两张 CA 一致。

### C4 — 单标签主机名，精确匹配不应被误伤

- 用 `labhost`（CA A2/B2）而非真实 hostname（原因见 §5）。leaf SAN：`DNS:labhost`。
- CA A2 带 `excluded;DNS=.labhost`，但 `labhost` 本身（不带前导子域标签）不匹配 `.labhost` 排除规则
  （openssl 的排除语义是"以 `.` 开头只匹配子域，不匹配自身"，与 `lan-plan.md` §2.2 的描述一致）。
- 实测：`https://labhost:20011/`（CA A2）、`https://labhost:20012/`（CA B2）均 200 OK，
  `navResult` 无 `errorText` 字段 → **排除没有误伤精确名**。

### C5 — 子域排除是否真的生效

- leaf SAN：`DNS:sub.labhost, DNS:x.labhost.local`。
- `openssl verify` 复核：CA A2（带排除）→ `verification failed`；CA B2（不带排除）→ `OK`。
  与 `lan-plan.md` 文档头部记录的本机 OpenSSL 行为一致。
- Chromium 实测：
  - CA A2：`https://sub.labhost:20013/` 与 `https://x.labhost.local:20013/` 均
    `net::ERR_CERT_INVALID` + "Privacy error"。
  - CA B2：同两个 URL（换绑到 c5_leaf_B2，端口 20014）均 200 OK，`navResult` 无错误。
  - → **Chromium（152，Linux）在"用户手动信任的本地 CA"上确实执行 nameConstraints 的子域排除
    （`excluded;DNS=.name`）语义，与 OpenSSL 一致**。

## 3. 截图证据

对 C3（CA B，`evil.test`）用 `Page.captureScreenshot` 抓了一张全尺寸 PNG：标准 Chromium "Your connection is not
private" 拦截页，红色警示三角图标，正文含
`Attackers might be trying to steal your information from evil.test`，底部 `NET::ERR_CERT_INVALID` 错误码文本，
「Advanced」/「Reload」按钮 —— 与本文档描述的文字取证一致，未额外保留图片文件（按任务要求只留本文档需要的摘录，
图片本身不进仓库）。

## 4. 关键结论：Chromium 是否遵守本地信任的 CA 的 nameConstraints

**是。** 在这台机器上，Chromium 152（headless，Linux，snap 包）对**用户手动信任的本地根 CA**：

1. 精确执行 IP `/32` permitted 约束（C2）—— 越界 IP 的 leaf 被拒，错误码 `ERR_CERT_INVALID`。
2. 精确执行 DNS permitted 约束（C3）—— 越界域名的 leaf 被拒，同错误码。
3. 精确名不受"子域排除"误伤（C4）。
4. `excluded;DNS=.name` 子域排除语义生效（C5）—— 子域的 leaf 被拒，与不带排除的对照组（全部通过）形成
   清晰对比。

这与 `lan-plan.md` 文档头部记录的 Google 官方说法（"Chrome 默认执行本地添加信任锚中的约束，企业策略
`EnforceLocalAnchorConstraintsEnabled`"）以及 OpenSSL 层面的复核结果完全一致，**没有观察到"约束本身导致功能失败"
或"约束不生效"的情况**——即 `lan-plan.md` §2.2 处置表中的「全部符合期望」分支。

## 5. 额外发现（与 nameConstraints 无关，但影响本机复现路径的选择）

本机 hostname `202507220006` 是**全数字字符串**。用它做单标签 DNS SAN（`DNS:202507220006`）时，
Chromium 的 CDP `Page.navigate` 对 `https://202507220006:<port>/` 直接返回
`{"error":{"code":-32000,"message":"Cannot navigate to invalid URL"}}`——浏览器的 URL
解析器把纯数字的单标签 host 当成畸形数值型地址处理，直接拒绝，**在证书验证之前就已经失败**，与
nameConstraints 无关。因此 C4/C5 改用合成的非数字单标签 `labhost`（同配方、同精确/排除规则）复测，
真实数字 hostname 的这一行为作为独立发现记录：**如果 web-hub 的目标主机凑巧是纯数字 hostname，
`<h>` 这个单标签 Host 白名单项在 Chromium 上天然不可达（URL 层拒绝，不是证书拒绝），需要在
`lan-plan.md` Q2/§2.2 的"单标签 hostname"分支里补一条边界说明**（不影响本次 spike 的主结论，也不影响
`caCovers`/白名单机制本身——受影响的只是"该主机名在浏览器地址栏里能不能被输入/导航到"这一独立前提）。

## 6. 最终 CA 配方建议

按 `lan-plan.md` §2.2 处置表「全部符合期望」分支：

- **配方定为 A**（带子域排除）：`permitted;IP=<每个接口 IP>/32` + `permitted;DNS=localhost,<h>.local,<h>`，
  每条 permitted DNS 都配 `excluded;DNS=.<name>`。
- **单标签 hostname 纳入**（`<h>` 本身，不含子域）——Chromium 一致遵守精确匹配 + 子域排除，CA 私钥泄露的
  风险面精确限定在"这几个 IP + 这几个精确名字"，不会放大到整个 TLD。
- 唯一的补充：`lan-plan.md` Q2 的单标签 hostname 处理要加一句边界说明——**如果 `<h>` 本身是纯数字字符串，
  Chromium 的 URL 解析器会在到达证书层之前就拒绝该地址栏输入**，此时"纳入 `<h>`"这条白名单项对该浏览器
  访客而言实际不可达；不影响 CA 精确性设计本身，只影响该场景下用户能否真的用这个名字访问（届时应引导用户
  优先用 IP 或 `<h>.local` 访问）。
- **Firefox / Safari：未验证**，按 L18 处置为「不保证遵守 nameConstraints」——`arch.md` §9 与 `/webhub ca`
  的文案应写明：在未验证的浏览器上，CA 私钥泄露的影响面可能扩大到任意站点（与 `lan-plan.md` §2.2 处置表中
  "某浏览器 C2/C3 失败"分支的说法一致，只是这里是"未测"而不是"测过且失败"）。
