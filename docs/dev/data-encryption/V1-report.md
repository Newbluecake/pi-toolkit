# V1 报告 — `pi-secure-vault/2` tar 包（convert-plan r3 §3 / §8.1 V1）

> 状态：实现 + 单测 + XC2 闸门完成，未接线（V5 `archive.mjs` / V6 接线负责）。未 commit。
> 文件域：`src/secure/bin/tar.mjs`（新）、`tests/secure/tar.test.ts`（新）、`tests/fixtures/secure-tar-corpus/gen.mjs`（新）、
> `tests/conformance/secure-convert-xc2.test.ts`（新，V7 并入 `secure-convert.test.ts`）、本报告。未碰 helper.mjs / `src/secure/*.ts`。

## 1. XC2 结果（冻结格式前的闸门，真 gocryptfs 1.8.0 / go-fuse 2.0.3，mktemp + 假口令 `-passfile`）

`tests/conformance/secure-convert-xc2.test.ts`（自门控：无 gocryptfs/fusermount3/flock//dev/fuse 即 skip；持跨套件 gocryptfs 测试锁；
xattr 断言另需 python3——Node 没有 listxattr）。实测事实与据此的格式决定：

| #   | 明文对象                                             | 密文表示（实测）                                                                                                                                      | 对格式的决定                                                                                  |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 普通文件                                             | 普通文件，名字 raw base64url（22 字符起），mode/ns-mtime 原样（XC1）                                                                                  | tar `0` 成员；mode 走 ustar，mtime 走 pax（含小数）                                           |
| 2   | 目录（含空目录）                                     | 目录 + `gocryptfs.diriv`（16 B，0440）；根目录另有 `gocryptfs.conf`（0400）                                                                           | tar `5` 成员，父先于子；根 `cipher/` 必须是首成员；conf/diriv 必须存在                        |
| 3   | 符号链接（相对 / 绝对 `/etc/passwd` / 逃逸 `../..`） | 符号链接，**目标文本是 raw base64url**（`[A-Za-z0-9_-]`，无 `/`、无 `.`），mode 0777                                                                  | MANIFEST `symlink{target_b64}`，字符集 `[A-Za-z0-9_=-]`、≤4096；文本不含 `/` ⇒ 只能指向同目录 |
| 4   | 3000 B 长目标                                        | 密文目标 4043 B（明文上限约 3039 B，受后端 4095 限制）                                                                                                | 4096 上限够用                                                                                 |
| 5   | 硬链接（3 路径）                                     | 密文同 ino、nlink 3                                                                                                                                   | MANIFEST `hardlink{of}`，内容只写一次                                                         |
| 6   | **硬链接的符号链接**（`link(2)` 不跟随）             | 密文是两个同 ino 的 symlink（nlink 2）——方案未覆盖                                                                                                    | 编成两个独立 `symlink` 条目（同目标文本）；`of` 仍只许指向普通文件。见偏差 D3                 |
| 7   | 250 B 长文件名                                       | `gocryptfs.longname.<43 b64>` 文件 + `.name` 旁注文件（都是普通文件）                                                                                 | 字符集需含 `.`；段长 ≤255 足够                                                                |
| 8   | setuid 文件                                          | 密文 mode **0o4755**                                                                                                                                  | 导出端 mode > 0o777 ⇒ 65（`mode-range`），与方案一致                                          |
| 9   | FIFO                                                 | 密文里是 **FIFO**（gocryptfs mknod 直通）                                                                                                             | 导出端 ⇒ 65（`special-file`）                                                                 |
| 10  | `user.demo` xattr                                    | 密文文件带一个加密的 `user.gocryptfs.<b64>` xattr（明文键名不可见）                                                                                   | tar 从不携带 xattr；导出端检测需 V5 用 `getfattr`（本机无 attr 包），缺失时告警               |
| 11  | `gocryptfs -init` 的 conf（XC3）                     | 键 `Creator/EncryptedKey/ScryptObject{Salt,N=65536,R=8,P=1,KeyLen=32}/Version=2/FeatureFlags`；flags = `GCMIV128 HKDF DirIV EMENames LongNames Raw64` | `CONF_FEATURE_FLAGS` 即此集合；严格校验见 §4                                                  |

**往返**：真密文树（文件、目录、空目录、5 层 >255 B 深路径、长文件名、空文件、2 MiB 文件、只读文件、相对/绝对/长目标链接、文件硬链接组 ×2、
硬链接的符号链接、ns mtime）→ `writePackage` → GNU `tar -tf` 可列出 → `readPackage` 进暂存根 → **用 gocryptfs 挂载暂存的 cipher** →
明文的类型/mode/nlink/硬链接分组/内容/链接文本逐项相等、mtime 差 ≤2 µs（见残留 R-V1-2）。结论：格式 `pi-secure-vault/2` 按 §3.1 冻结，补充 D1–D8 偏差。

实测运行（本机，2026-10-24）：见 §6。XC2 的锁等待受其他 agent 并行跑真挂载套件影响（见 §7 残留 R-V1-6）。

## 2. 导出 API（V5 使用；全部同步、无进程级副作用，V5 在 `__convert-work` worker 里调用）

```js
import {
  PKG_FORMAT,
  PKG_VERSION,
  PKG_ROOT,
  PKG_CIPHER,
  PKG_MANIFEST,
  PKG_PAX_NAME,
  PKG_CONF,
  PKG_DIRIV,
  EXIT_CONTENT /*65*/,
  EXIT_IO /*74*/,
  BUDGET,
  CONF_FEATURE_FLAGS,
  VAULT_NAME_RE,
  SCRYPT_MAX_MEM_BYTES,
  SCRYPT_MAX_WORK,
  entryUnits,
  prescanJson,
  PkgError,
  effectiveBudget,
  checkPkgPath,
  checkMtime,
  mtimeFromStat,
  validateGocryptfsConf,
  validateManifest,
  parsePax,
  memberHeaders,
  scanCipherTree,
  writePackage,
  readPackage,
  discardStaging,
} from "./tar.mjs";
```

| 函数                                                                                                                                                  | 说明                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `class PkgError extends Error { reason: string; detail: string; exitCode: 65 \| 74 }`                                                                 | 所有拒绝的唯一错误类型（所有导出入口都经 `guard`：任何非 PkgError 异常都会变成 65 `internal` 或 74 `io`）；`reason` 为稳定机器码（§3 列表）。detail 只含包内相对路径（`cipher/…`），不含暂存绝对路径                                                                                                                 |
| `writePackage({ cipherDir, fd, name, gocryptfsVersion, origRealWork, exportedAt?, budget?, onProgress? }) → { manifest, bytesWritten, members }`      | 把 `cipherDir` 写入**已打开的空 fd**（V5 负责 `<文件>.partial-<txid>` O_EXCL 0600、fsync、`link()` 发布、失败删 partial）。前提：已卸载 + 持 `mount.lock` + 租约空闲（§3.2）；读时发现 dev/ino/size/mtime 变化 ⇒ 74 `cipher-changed`。写前对 MANIFEST 做自检（`validateManifest`），永不产出自己读不进的包。不 fsync |
| `scanCipherTree(cipherDir, { budget? }) → entries[]`                                                                                                  | 只 lstat、从不跟随；确定性先序（名字按字节序）；FIFO/socket/设备、mode>0o777、非字母表名字/目标、超预算 ⇒ 65。V5 可先调用做导出预检                                                                                                                                                                                  |
| `readPackage({ pkgPath, stagingRoot, budget?, onProgress? }) → { manifest, conf, counts: {dirs,files,symlinks,hardlinks,members}, bytes, cipherDir }` | `stagingRoot` 必须**已存在、空、0700、本 uid、非符号链接**（V5 独占创建 `<dir 父>/.<名字>.import-<txid>`）。成功后 `stagingRoot/cipher` 是完整密文目录（目录 mode/mtime 已恢复），V5 再在暂存内建 `mount.lock`/`mount.lease` 并发布。抛 `PkgError` 后调用方必须 `discardStaging(stagingRoot)`                        |
| `discardStaging(stagingRoot, budget?)`                                                                                                                | lstat 遍历把目录改回 0700 后 `rmSync`；从不跟随符号链接，只碰暂存根之内                                                                                                                                                                                                                                              |
| `checkPkgPath(p, budget?) → { kind:"manifest" } \| { kind:"cipher", path, rel, segments, depth, parent }`                                             | **统一路径验证器**：tar 成员、MANIFEST 每个 `path`、硬链接 `of` 都经它                                                                                                                                                                                                                                               |
| `validateGocryptfsConf(bufOrString, budget?) → conf`                                                                                                  | conf 严格校验（XC3）                                                                                                                                                                                                                                                                                                 |
| `validateManifest(obj, budget?) → manifest`                                                                                                           | 结构校验（与成员的交叉核对在 `readPackage` 内）                                                                                                                                                                                                                                                                      |
| `entryUnits({ dirs, files, links }) → number`                                                                                                         | 唯一预算单位（+1 为 MANIFEST 成员）；V5 若要在导出前提示「过大」，用它与 `BUDGET.maxEntries` 比较                                                                                                                                                                                                                    |
| `prescanJson(text, { maxDepth, maxNodes, maxString? })`                                                                                               | 解析前的有界结构预扫描（读取器内部已对 MANIFEST/conf 使用）                                                                                                                                                                                                                                                          |
| `effectiveBudget(override)`                                                                                                                           | 预算覆盖**只能收紧**（测试/调用方传更小的值）；V5 生产路径不传                                                                                                                                                                                                                                                       |
| `onProgress({ phase: "write"\|"read"\|"link"\|"done", members, bytes })`                                                                              | 每个成员、每 64 MiB 数据、每条链接回调一次，供 worker 输出进度行喂 60 s 停滞看门狗（§5）                                                                                                                                                                                                                             |

V5 须知：

- 暂存布局是 `S/cipher/…`（去掉 `pi-secure-vault/` 前缀），发布时把 `S` 的顶层条目（`cipher`、V5 自建的 `mount.lock`/`mount.lease`）rename 进自建空 `<dir>`。
- 目录 mode 在最后恢复；Linux 跨父目录 rename **目录**需要对该目录本身有写权限——gocryptfs 根目录正常是 0o7xx（有 u+w），但恶意/异常包的根 mode 可能无 u+w，V5 的发布步骤应在 `ENOTEMPTY/EACCES` 时中止回滚（方案已写「身份不符或 ENOTEMPTY ⇒ 中止」，补 EACCES）。
- 密文 xattr 检测（§3.1）不在 V1：Node 无 listxattr，V5 用 `getfattr`（缺失时警告）。
- 退出码：内容问题一律 65；暂存根前提不满足（非空/权限/非目录/无 `/proc/self/fd`）、IO 错误、暂存被并发改动为 74。

## 3. 恶意语料类别与拒绝点

`tests/fixtures/secure-tar-corpus/gen.mjs`：**独立于 tar.mjs 的原始 ustar/pax 编码器**（生产写入器的 bug 不会掩盖读取器 bug）；每例从一个**必须被接受**的基线包
（`ok-baseline`，含 2 目录、5 文件、1 符号链接、1 硬链接）做一次变异。共 156 例（安全评审后扩到 197 例，见 §8）（`node gen.mjs <outdir>` 产出 `.tar` + `index.json`）。
`tar.test.ts` 对每例：在暂存父目录放哨兵、`etc/passwd` 诱饵与 `outside/canary`，读取前后、`discardStaging` 后三次快照（lstat 全量含内容/ino/mtime）
⇒ **暂存根之外零变更**，且每例 `exitCode === 65`、`reason ∈ 预期集合`。

| 类别（例数）                      | 代表用例                                                                                                                                                                                                                | 拒绝点（reason）                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路径穿越 / 绝对 / `..`（10）      | 成员 `cipher/../../etc/x`、`../x`、`./`、`/etc/passwd`（含经 pax）、前缀外、`pi-secure-vault/mount.lock`、空段、反斜杠、非法字符                                                                                        | `checkPkgPath`：`path-dot-segment` / `path-absolute` / `path-prefix` / `path-empty-segment` / `path-backslash` / `path-bad-char`                                                                   |
| **MANIFEST 链接路径（B6，11）**   | 链接 `path` 为 `cipher/../x`、`../x`、`/tmp/x`、`.`、空段、非法字符、前缀外、MANIFEST 本身；硬链接 `of` 穿越/绝对/指向 MANIFEST                                                                                         | 同一 `checkPkgPath`（`validateEntry` 内）；`manifest-entry-path`、`hardlink-of`                                                                                                                    |
| NUL（5）                          | ustar name `x\0../../evil`、pax path 含 NUL、链接 path/`of` 含 `\u0000`、目标含 NUL                                                                                                                                     | `header-nul-injection`（NUL 后非零）、`path-nul`、`symlink-target`                                                                                                                                 |
| 超长（6）                         | 段 256 B、路径 4097+ B、深度 65、链接 path 过长、链接段过长、目标 4097 B                                                                                                                                                | `segment-too-long` / `path-too-long` / `path-too-deep` / `symlink-target-too-long`                                                                                                                 |
| 重复（7）                         | 同名文件/目录成员、目录与文件同名、MANIFEST 条目重复、链接与成员同名、两条链接同名、硬链接与成员同名                                                                                                                    | 统一冲突表 `duplicate-path`（成员流式时 + MANIFEST 核对时）                                                                                                                                        |
| 大小写 / Unicode（8）             | `Ab` 与 `aB`、链接与成员仅大小写不同、两链接仅大小写不同、NFC `é`、NFD `e\u0301`、全角、非 UTF-8 字节、孤立代理                                                                                                         | `case-conflict`（ASCII casefold 表）、`path-bad-char`、`non-utf8`                                                                                                                                  |
| 链接指向暂存根外 / 链接结构（15） | 目标 `../../outside`、`/etc/passwd`、`a/b`、`..`、空、非字符串；链接祖先是文件/符号链接/硬链接/缺失；链接在 cipher 根；`of` 指向目录/根/符号链接/不存在                                                                 | `symlink-target`、`ancestor-not-dir`、`ancestor-missing`、`manifest-entry-path`、`hardlink-of-not-file`、`hardlink-of-missing`                                                                     |
| 硬链接环（3）                     | `of` 指向自身、A↔B 互指、链（B of A of 文件）                                                                                                                                                                           | `hardlink-of-missing` / `hardlink-of-not-file`（`of` 只许是**成员表中的普通文件**，环不可能成立）                                                                                                  |
| pax 头注入（17）                  | `linkpath`/`uid`/`SCHILY.xattr.*` 键、重复 `path`、值内嵌 `\n30 linkpath=…`、长度说谎/前导 0、全局 `g`、连续两个 `x`、悬空 `x`、`x` 头名不对、size 不一致/负/超安全整数、mtime 超 2^41/负、空 pax                       | `pax-key`、`pax-duplicate-key`、`path-bad-char`、`pax-syntax`、`member-type`、`pax-chain`、`pax-dangling`、`pax-name`、`pax-size-mismatch`、`pax-size`、`mtime-range`、`mtime-syntax`、`pax-empty` |
| 成员类型 / 特殊位（11）           | 类型 1/2/3/4/6/7/`L`、文件带 linkname、setuid 文件、sticky 目录、MANIFEST 中 mode 超 0o777                                                                                                                              | `member-type`（先于一切路径处理）、`header-linkname`、`mode-range`                                                                                                                                 |
| 头字段（12）                      | 校验和错、GNU magic、base-256 数值、非八进制、size 超剩余、目录 size≠0、文件路径带 `/`、填充非零、首成员非根、子先于父、成员在文件下                                                                                    | `header-checksum`、`header-magic`、`header-numeric`、`size-exceeds-package`、`dir-size`、`file-path`、`padding-not-zero`、`first-member`、`ancestor-missing`、`ancestor-not-dir`                   |
| 截断 / 包尾（9）                  | 空文件、头中截断、数据中截断、无包尾、只有一个零块、包尾后垃圾、非 512 对齐、MANIFEST 前出现零块、MANIFEST 后还有成员                                                                                                   | `missing-manifest`、`truncated`、`size-exceeds-package`、`trailer-garbage`、`member-after-manifest`                                                                                                |
| MANIFEST（22）                    | 哈希/size 不符、成员多/少、类型/元数据不符、非规范 JSON、重复 JSON 键、未知键、条目未知键/类型、v≠2、format、origRealWork 相对/`..`/不以 `/work` 结尾、name、totals、非 UTF-8、非 JSON、mtime 非字符串、MANIFEST 是目录 | `manifest-*`、`non-utf8`、`mtime-syntax`、`member-type`                                                                                                                                            |
| conf 严格（14）                   | PlaintextNames、未知 flag、重复 flag、未知键（`LongNameMax`）、Version 3、N 非 2 的幂、KeyLen 16、EncryptedKey 长度、非 JSON、>64 KiB、缺 conf、缺 diriv、diriv 17 B、conf 是目录                                       | `conf-plaintext-names`、`conf-unknown-flag`、`conf-flags`、`conf-unknown-key`、`conf-version`、`conf-scrypt`、`conf-key`、`conf-json`、`conf-too-large`、`missing-conf`、`missing-diriv`           |
| 超预算（5，另有真实上限例见上）   | pax 头 65 KiB（真实上限）、MANIFEST 超（收紧到 1 KiB）、成员数超（收紧到 5）、**链接使合计超预算**（收紧到 8：8 个成员通过，9 个条目被拒）、深度收紧                                                                    | `budget-pax`、`budget-manifest`、`budget-entries`、`path-too-deep`                                                                                                                                 |

另有前提用例：暂存根非空 / 组可访问 / 是符号链接 ⇒ 74 `staging`；包是符号链接 ⇒ 74 `io`（O_NOFOLLOW）；包是 FIFO ⇒ 65 `package-not-file`（`O_NONBLOCK`，不挂起）；
`discardStaging` 遇到指向外部目录的符号链接只删链接（外部快照不变）。

读取流程中拒绝点的顺序（防注入的关键）：头校验和 → magic → 类型白名单（链接/设备/FIFO/全局 pax/GNU 扩展在此被拒，早于路径处理）→ linkname 必须全零 →
pax 解析（键白名单、重复键、长度自洽）→ pax/ustar size、mtime 一致 → 目录/文件路径尾斜杠 → 成员计数预算 → size ≤ 剩余字节 → `checkPkgPath` →
mode ≤0o777 → 统一冲突表（重复、casefold、祖先必须是已建目录）→ 父目录逐段 lstat 身份核对 → `mkdir 0700` / `open(O_EXCL|O_NOFOLLOW, 0600)` → 流式 sha256 →
包尾全零 → conf/diriv 存在 + conf 严格 → MANIFEST 规范 JSON + 结构 → 成员 ↔ 条目逐项核对（集合相等）→ 链接按深度升序进**同一张表**（重复/casefold/祖先类型/
`of` 必须是普通文件）→ 重建（逐段核对父目录身份、`symlink`/`link` 两端都在 `/proc/self/fd/<S>` 之下、`EEXIST` 即拒）→ 全树复走（集合、类型、ino、nlink）→ 恢复目录 mode/mtime。

## 4. 预算表

| 项                           | 上限                                                                                                                           | 位置                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 预算单位（`entryUnits`）合计 | 1 000 000                                                                                                                      | 单位 = 目录/文件成员 + MANIFEST 链接条目 + 1（MANIFEST 成员）；流式、`entries.length+1`、核对后合计、写入端自检共用（§8 #5） |
| 已登记路径累计字节           | 64 MiB（= MANIFEST 上限；合法包每条路径都出现在 MANIFEST 中）                                                                  | 冲突表 `admit()`（成员与链接）+ 写入端自检（§8 #2）                                                                          |
| JSON 结构（解析前预扫描）    | MANIFEST 嵌套深度 ≤3、值节点 ≤7·maxEntries+64、单个字符串 token ≤64 KiB；conf 深度 ≤2、值节点 ≤64                              | `prescanJson`（§8 #2）                                                                                                       |
| MANIFEST 字节                | 64 MiB（整体读入内存解析）                                                                                                     | 成员 size 预检 + 写入端自检                                                                                                  |
| 单个 pax 头                  | 64 KiB                                                                                                                         | `x` 成员 size 预检                                                                                                           |
| gocryptfs.conf               | 64 KiB                                                                                                                         | 成员 size 预检 + `validateGocryptfsConf`                                                                                     |
| 路径 / 段 / 深度             | 4096 B / 255 B / 64（`cipher` 为 1）                                                                                           | `checkPkgPath`                                                                                                               |
| 符号链接目标                 | 1–4096 字节，`[A-Za-z0-9_=-]`                                                                                                  | `checkSymlinkTarget`                                                                                                         |
| 数值字段                     | 安全整数且 ≥0；ustar 八进制严格（拒 base-256）；size ≤ 剩余字节                                                                | `octField` / `parsePax`                                                                                                      |
| mtime                        | `sec[.≤9 位]`，整数部分 ∈ [0, 2^41]                                                                                            | `checkMtime`                                                                                                                 |
| 累计处理字节                 | ≤ 包大小（按 fstat 的文件大小读，越界即 `truncated`）                                                                          | `Reader.read`                                                                                                                |
| 包尾                         | ≥2 个零块、只允许零字节、总长 512 对齐                                                                                         | `checkTrailer`                                                                                                               |
| conf scrypt                  | N=2^10…2^17 且为 2 的幂（128·N·R ≤ 128 MiB，N·R·P ≤ 2^20），R=8，P=1，KeyLen=32，Salt 32 B，EncryptedKey 64 B（GCMIV128）/60 B | `validateGocryptfsConf`（§8 #1）                                                                                             |
| 进度回调                     | 每成员 / 每 64 MiB / 每链接                                                                                                    | 喂 V5 worker 的 60 s 停滞看门狗                                                                                              |

## 5. 偏差（相对 §3.1/§3.3 文字，均为收紧或补全）

- **D1 pax mtime 带小数**：方案写「数值字段为安全整数」；gocryptfs 密文 mtime 是 ns 精度（XC1），为不丢精度，pax `mtime` 允许 `sec.frac`（≤9 位），整数部分仍是安全整数且 ≤2^41；size 仍是纯整数。
- **D2 MANIFEST 条目形状补全**：除链接外，目录与文件也列入（`dir{path,mode,mtime}`、`file{path,mode,mtime,size,sha256}`），以支撑「集合完全相等」与 mode/mtime 核对；`path`/`of` 一律写全包路径 `pi-secure-vault/cipher/…`（与 tar 成员同一验证器）；`totals = {dirs,files,symlinks,hardlinks,bytes}`。
- **D3 硬链接的符号链接**：XC2 发现 gocryptfs 保留符号链接的硬链接；`of` 只许指向普通文件（方案原文），因此编码为独立 symlink 条目（同目标文本）。导入后这类符号链接 nlink=1，`readlink` 结果相同。
- **D4 大小写冲突**：统一冲突表另按 ASCII casefold 拒绝重名（合法 gocryptfs 名字是 ≥22 字符随机 base64，碰撞概率可忽略；防 ext4 casefold 目录上静默合并）。Unicode 冲突由字符集白名单在更早处拒绝。
- **D5 规范 JSON**：MANIFEST 必须逐字节等于 `JSON.stringify(m) + "\n"`（拒绝重复键、替代转义、空白变体）；所有键集合精确匹配，未知键即拒。
- **D6 成员顺序**：首成员必须是 `pi-secure-vault/cipher/` 目录，父目录成员必须先于子成员；MANIFEST 必须是最后一个成员；`x` 头的 ustar 名固定 `pi-secure-vault/PaxHeader`。
- **D7 conf 收紧**：R/P/KeyLen 精确等于 gocryptfs 写死值，EncryptedKey 长度与 GCMIV128 一致，Creator 形如 `gocryptfs <ver>`；gocryptfs ≥2.2 的 `LongNameMax` 等新键会被拒（方案「未知键拒绝」的直接后果，换 gocryptfs 大版本时需重跑 XC2/XC3 并放宽）。
- **D8 暂存根前提**：读取器自己校验暂存根（空、0700、本 uid、`O_DIRECTORY|O_NOFOLLOW` 打开、`/proc/self/fd/<n>` 与 fd 同一 dev/ino），不满足为 74；所有创建都相对该 fd 解析。

## 6. 自验

安全评审修复后（2026-10-24 08:03，本机 Node 22.22.1、gocryptfs 1.8.0）：

```
$ npx vitest run tests/secure/tar.test.ts tests/conformance/secure-convert-xc2.test.ts
 ✓ tests/conformance/secure-convert-xc2.test.ts (10 tests)
 ✓ tests/secure/tar.test.ts (242 tests)
 Test Files  2 passed (2)
      Tests  252 passed (252)
$ npm run typecheck   → exit 0
$ npx prettier --check <本包 5 个文件>   → All matched files use Prettier code style!
```

首轮（评审前）另跑过 `npx vitest run tests/secure --maxWorkers=3` → 21 files / 916 tests 通过；评审修复只动本包文件。XC2 跑完后 tmpdir 中无 `pi-secure-xc2-*` 目录或挂载残留。

## 7. 残留

- **R-V1-0 scrypt 上限**：用 `gocryptfs -init -scryptn 18` 及以上创建的库无法导入（65 `conf-scrypt-cost`），没有覆盖开关（§8 #1）。
- **R-V1-1 MANIFEST 容量**：64 MiB / 每条约 200 B ⇒ 实际约 30 万条目即触顶（低于 1 000 000 的合计预算）；写入端此时 65 `budget-manifest`，V5 文案需说明（「库内文件过多，无法导出」）。
- **R-V1-2 mtime 精度**：包内保留精确 ns，但 Node `utimes/futimes/lutimes` 只接受浮点秒，导入后 mtime 误差 ≤~1.3 µs（双精度约 0.24 µs + libuv 把 utimes 截到微秒；测试容差 2 µs）。影响限于 git index stat 缓存（方案 W9 已接受）。
- **R-V1-3 xattr**：tar 不携带 xattr；密文 xattr（`user.gocryptfs.*`，明文 xattr 的加密形式）的检测依赖 V5 调用 `getfattr`，本模块不检测。
- **R-V1-4 并发篡改**：父目录逐段 lstat 身份核对 + 最终全树复走能发现持久的替换，但同 uid 攻击者在核对与 `mkdir/open/symlink/link` 之间的瞬时竞态无法用 Node（无 openat/mkdirat）完全排除；暂存根 0700 + 同 uid 信任边界之内，与方案一致。
- **R-V1-5 PATH_MAX**：包内路径 ≤4096 B，但 `/proc/self/fd/<n>/` 前缀使极深路径可能触发 `ENAMETOOLONG`（74 `io`）；合法 gocryptfs 库的路径同样受此限制。
- **R-V1-6 测试锁孤儿（测试基础设施，非本包文件域）**：`tests/secure/gocryptfs-test-lock.ts` 的锁持有者是 `detached` 的 `flock … sleep 3600`；vitest 被外层 `timeout` 杀掉时 afterAll 不运行，锁持有者与挂载都成孤儿，最长阻塞其他真挂载套件 1 小时。本次实测发生过一次（他方以 `tests/conformance/secure-convert*.test.ts` glob 运行到本文件后被 `timeout` 杀掉），已手工卸载并清理。XC2 测试已做两项缓解：beforeAll 超时后迟到的锁不再挂载；持锁后先清扫 tmpdir 中死掉的 `pi-secure-xc2-*` 挂载/目录（持锁即证明没有活的 XC2 运行）。建议锁助手的持有者改为监视父 pid（父进程消失即退出），由 V7 或测试基础设施负责。
  另：本文件早期版本用管道接 gocryptfs 的 stdout/stderr，常驻守护进程继承了管道，`spawnSync` 永远等不到 EOF，持锁挂起（他方 07:09 起的一次运行因此卡住，已由我卸载解卡并通知主会话）；现改为把输出接到文件 fd。

## 8. 安全评审处置（gpt-6.1-sol，威胁模型：不可信包完全控制字节；1 Blocker / 2 Major / 3 Minor，全部接受修复）

| #   | 严重度  | 摘要                                                                                          | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 落点（代码 / 测试）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | conf 接受 N=2^28·R=8 ⇒ 后续挂载 / `--verify-password` 的 KDF 约需 256 GiB                     | **资源上限**：`SCRYPT_MAX_MEM_BYTES = 128·2^17·8 = 128 MiB`（128·N·R），`SCRYPT_MAX_WORK = 2^17·8·1`（N·R·P）。理由：gocryptfs 默认 N=2^16、R=8、P=1，即 64 MiB（XC3 实测）；只允许翻倍一次（`-scryptn 17`）——够用户手动调高一档，又把不可信包能强加的 KDF 内存压在普通机器可承受的 128 MiB 以内。超限 ⇒ 65 `conf-scrypt-cost`，在任何口令/KDF 调用之前（导入只解析 conf，从不派生密钥）。不设覆盖开关（残留 R-V1-0）                                                                                                                                               | `validateGocryptfsConfImpl`；语料 `ok-scrypt-n17`（接受）、`conf-scrypt-cost-n18`、`conf-scrypt-cost-n28`；单测 N∈{2^10,2^16,2^17} 接受、{2^18,2^20,2^28} 拒绝（测试从不运行 KDF）                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | Major   | MANIFEST 在结构预算前整体 `JSON.parse`；40 008 B 深嵌套触发未包装的 `RangeError`              | **解析前有界预扫描** `prescanJson`（逐字符、不建对象）：嵌套深度 ≤3（MANIFEST 的真实形状 {manifest}→[entries]→{entry}）、值节点 ≤7·maxEntries+64（每条目至多 7 个值节点，键不计）、单个字符串 token ≤64 KiB；conf 同样预扫描（深度 ≤2、值节点 ≤64）。通过后才 `JSON.parse`；顺序改为**先 schema、后规范化比较**；parse/stringify 的任何异常经 `guard` 变成 PkgError/65。另加**路径累计字节预算** `maxPathBytesTotal`（64 MiB，= MANIFEST 上限，因为合法包的每条路径都在 MANIFEST 中），在 MANIFEST 到达之前就限住成员表与 casefold 表                               | `prescanJsonImpl` / `parseJsonBounded` / `Reader.parseManifest` / `admit`；语料 `manifest-json-deep-40k`（评审反例原样）、`-deep-field`、`-deep-object-in-entry`、`-wide-nodes`、`-long-string`、`-unterminated`、`conf-json-deep`、`conf-json-many-nodes`、`budget-path-bytes`；单测 prescanJson 边界（10 节点通过 / 11 拒绝）与真实写入器输出不误伤                                                                                                                                                                                                    |
| 3   | Major   | XC2 的 `sweepDeadRuns` 仅凭 tmpdir 前缀卸载 / chmod / 递归删除非本轮目录                      | **删除跨轮清扫**（与 N4 harness 同一规则）：每轮在 mkdtemp 后立即写 `<root>/.xc2-owner`（随机 128 位 token，`wx`，0600）；afterAll 只卸载本轮 `mount()` 记录的、位于本轮根之下的挂载，只有在「根是 lstat 目录且属本 uid、标记文件是本 uid 的普通文件且内容等于本轮 token、根下已无挂载」都成立时才删除根，否则保留并 warn。其他 `pi-secure-xc2-*` 挂载只报告（console.warn），从不触碰                                                                                                                                                                              | `tests/conformance/secure-convert-xc2.test.ts`：`RUN_TOKEN` / `ownRoot` / `reportForeignLeftovers`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Minor   | 不可信 `type` 命中 `ENTRY_KEYS` 原型属性；`quote` 的 String 转换可抛；原生 TypeError 逃出协议 | `ENTRY_KEYS` 改为 null 原型冻结表，查表前要求 `typeof type === "string" && Object.hasOwn(...)`；`quote` 只对原始类型调用 String，对象/数组渲染成 `<object>`/`<array>`；诊断里的系统错误统一 `errText`（只读 `code`/`name`）。所有导出入口（`readPackage`、`writePackage`、`scanCipherTree`、`discardStaging`、`checkPkgPath`、`checkMtime`、`validateGocryptfsConf`、`validateManifest`、`parsePax`、`prescanJson`）经 `guard`：PkgError 原样；Node 系统错误 ⇒ 74 `io`；其他任何异常 ⇒ 65 `internal`。`parsePax`/`prescanJson`/conf 对非 Buffer/非字符串输入直接 65 | 语料 `type-proto-{__proto__,constructor,toString,hasOwnProperty,valueOf}`、`type-number`、`name-object-tostring`（即评审的 `{toString:0}`）、`format-object`、`version-object`、`path-null`、`mode-string`、`size-bool`、`totals-null`、`entries-object`、`entry-null`、`entry-own-proto-key`、`manifest-own-proto-key` 等；单测用**抛异常的 getter 与全陷阱 Proxy**（JSON 里不可能出现函数，只能在直接调用 API 时构造）逐字段断言 PkgError/65。注：条目字段值为对象/数组时深度为 4，已被 #2 的预扫描先拒（`budget-json`），字段校验器本身由单测直接覆盖 |
| 5   | Minor   | 导出 / 流式导入 / 链接合计对 MANIFEST 成员计数不一致；紧缩预算下写入器能写出自己读不回的包    | 统一预算单位 `entryUnits({dirs,files,links}) = dirs+files+links+1`（+1 是 MANIFEST 成员，流式读取一开始就预留）。读取器流式、`validateManifest`（`entries.length+1`）、核对后合计、写入器扫描与自检全部走 `checkUnits`。写入器先用占位哈希（定长）构造 MANIFEST，**在写出第一个字节之前**跑与读取器相同的全部检查（单位、路径累计字节、MANIFEST 字节、JSON 预扫描、schema），写完再用真实哈希复检一次                                                                                                                                                               | `entryUnits` / `checkUnits` / `selfCheckManifest`；单测：无链接（4 单位）/有链接（6 单位）各测 exact 往返通过、limit-1 写入端拒绝且输出文件 0 字节、默认写出的包在 limit-1 被读取端拒绝、limit+1 通过；路径累计字节与 MANIFEST 字节各测 exact / exact-1 两侧一致；语料 `ok-budget-exact`（10 单位）与 `budget-links-push-over`（9：成员流式通过、链接使合计超限）                                                                                                                                                                                        |
| 6   | Minor   | 往返测试只比较文件 Base64 前 64/80 字符                                                       | 两处 facts 改为**每个文件全量 sha256 + size**（含 3 MiB / 2 MiB 大文件）；另加等长篡改用例：在包内大文件数据的**中部与末字节**各翻转一个字节，读取器均拒绝 `manifest-hash-mismatch`                                                                                                                                                                                                                                                                                                                                                                                 | `treeFacts`（tar.test）、`plainFacts`（xc2）；单测「an equal-length corruption in the middle or at the tail…」                                                                                                                                                                                                                                                                                                                                                                                                                                           |

评审「应补语料」的其余建议也已加入：ustar prefix 字段 NUL 注入（`hdr-prefix-nul-injection`）与非法 UTF-8（`hdr-prefix-non-utf8`）、GNU `K`/`S` 类型、`GNU.sparse.*` pax 键、以及正例 `ok-pax-overrides-ustar`（ustar 名为 `../../../evil`、pax path 合法：只有校验过的 pax path 落盘，暂存根外快照不变、树内不出现 `evil`）。语料现为 197 例（新增 `json-structure`、`json-types` 两类）。

给 V5 的补充：worker 进程仍应设独立内存兜底（如 `node --max-old-space-size=1024`）。以上预算把解析期内存限在「MANIFEST 64 MiB 文本 + 其对象图 + 两张路径表（路径累计 ≤64 MiB）」的量级，但 Map/对象开销与 V8 实现相关，不在本模块里精确计费。
