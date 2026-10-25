# 会话数据本地加密 + 工具透明加解密 — 可行性调研

## 结论表（TL;DR）

| #   | 问题                                                                   | 结论                                                                                                                                                                                                                   | 关键证据                                                                                                                        |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 扩展能否同名覆盖内建 read/edit/write，能否复用内建实现只在 IO 层加解密 | **能**。`registerTool({name:"read"})` 覆盖内建（扩展工具在 `_toolRegistry` 里后写覆盖内建）。pi 导出 `ReadOperations`/`WriteOperations`/`EditOperations` 等 IO 抽象，可注入加解密，其余截断/格式化逻辑全部复用 pi 代码 | `dist/core/agent-session.js:2867-2887`；`dist/core/tools/{read,write,edit}.d.ts`；本仓库 `src/tools/bash-tool.ts:20-27,343-475` |
| 2   | 会话记录谁写、能否拦截                                                 | pi 的 `SessionManager` 直写 `fs.appendFileSync/writeFileSync`，**无任何读写钩子**，扩展拿到的只是 `ReadonlySessionManager`，**不能拦截**。只能 SDK 层替换或文件系统层方案                                              | `dist/core/session-manager.js:3,754-813`；`dist/core/extensions/types.d.ts:1187-1227`（事件全集无 session 写钩子）              |
| 3   | 本仓库明文落盘清单                                                     | 见下方清单（约 12 处）                                                                                                                                                                                                 | 见清单逐项                                                                                                                      |
| 4   | bash 里 cat/grep/sed 看到密文                                          | 现有覆盖的拦截点在 `BashOperations.exec` / `spawnHook`（可重写命令），但**无透明解密**；cat/grep/sed/管道读的是磁盘密文                                                                                                | `src/tools/bash-tool.ts:463-475,764-767`；`dist/core/tools/bash.d.ts:39-60`                                                     |
| 5   | Node crypto 是否够                                                     | **够**。`node:crypto` 有 AES-256-GCM、scrypt/pbkdf2、randomBytes；本仓库已在用 scryptSync(N=32768) 做口令散列，无运行时依赖                                                                                            | `package.json`（无 `dependencies`，engines node>=22）；`src/web-hub/hub/db-child.ts:637`                                        |

---

## 1. 扩展覆盖内建 read/edit/write + 复用内建实现

### 1.1 覆盖机制成立（同名注册，扩展胜出）

- 内建工具在会话里先被放进 `_baseToolDefinitions`（`createAllToolDefinitions`，含 read/bash/edit/write/grep/find/ls/powershell），见 `dist/core/agent-session.js:2928-2935`（`_buildRuntime` 里 `createAllToolDefinitions(...)`）。
- 工具注册表合并时，**扩展工具后写、按名字覆盖内建**：
  - `dist/core/agent-session.js:2867-2868`：`definitionRegistry` 先以内建为底，再 `for (const tool of allCustomTools) definitionRegistry.set(tool.definition.name, ...)`。
  - `dist/core/agent-session.js:2883-2887`：`toolRegistry = new Map(wrappedBuiltInTools...)`，随后 `for (const tool of wrappedExtensionTools) toolRegistry.set(tool.name, tool)`。
- `registerTool` 本身用 `Map.set`（同名同扩展内也覆盖）：`dist/core/extensions/loader.js:231-241`（`extension.tools.set(tool.name, {...})`）。
- 跨扩展同名时"先注册者胜"：`dist/core/extensions/runner.js:410-421`（`getAllRegisteredTools()` first-wins）——但这是扩展之间的去重；**相对内建，扩展恒胜**（内建不在 `allCustomTools`/`getAllRegisteredTools` 里）。

> 本仓库的 bash 覆盖就是这一机制的直接先例：`src/index.ts:981-1003` 注册 `createBashTool(...)`，其 `ToolDefinition.name === "bash"`（`src/tools/bash-tool.ts:356`），注释明确 "the same-name `bash` override … off means pi's built-in bash stays in place"。

### 1.2 内建 IO 抽象（可注入、可复用）

pi 从 `@earendil-works/pi-coding-agent` 导出整套工具工厂与 operations 接口（`dist/index.d.ts` 与 `dist/core/tools/index.d.ts`）：

| 工具       | 工厂                                          | operations 接口                                                                                                       | 内容相关点                                        |
| ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| read       | `createReadToolDefinition(cwd, {operations})` | `ReadOperations { readFile(abs)→Buffer; access(abs); detectImageMimeType?(abs) }` (`dist/core/tools/read.d.ts:38-42`) | `readFile` 解密                                   |
| write      | `createWriteToolDefinition`                   | `WriteOperations { writeFile(abs, content:string); mkdir(dir) }` (`dist/core/tools/write.d.ts:24-27`)                 | `writeFile` 加密                                  |
| edit       | `createEditToolDefinition`                    | `EditOperations { readFile(abs)→Buffer; writeFile(abs, content); access(abs) }` (`dist/core/tools/edit.d.ts:31-35`)   | 两端                                              |
| grep       | `createGrepToolDefinition`                    | `GrepOperations { isDirectory; readFile(abs)→string }` (`dist/core/tools/grep.d.ts:20-25`)                            | 仅上下文行；**搜索本体是 ripgrep 子进程直读磁盘** |
| find       | `createFindToolDefinition`                    | `FindOperations { exists; glob }`                                                                                     | 无内容（仅文件名）                                |
| ls         | `createLsToolDefinition`                      | `LsOperations { exists; stat; readdir }`                                                                              | 无内容                                            |
| bash       | `createBashToolDefinition`                    | `BashOperations { exec(command, cwd, {onData,signal,timeout,env}) }` (`dist/core/tools/bash.d.ts:39-46`)              | 任意命令                                          |
| powershell | `createPowerShellToolDefinition`              | `PowerShellOperations { ... }`                                                                                        | 任意命令                                          |

关键事实：这些 factory 的 `execute` 内部已经**只通过 operations 触碰文件内容**，其余（偏移/limit 截断、图片检测与缩放、diff 渲染、`withFileMutationQueue` 串行化）全部是 pi 自己的代码。例如：

- `dist/core/tools/read.js:46-120`：`ops.access(absolutePath)` → `ops.detectImageMimeType` → `ops.readFile(absolutePath)`，之后纯内存处理。
- `dist/core/tools/write.js:37-55`：`ops.mkdir(dir)` → `ops.writeFile(absolutePath, content)`。
- `dist/core/tools/edit.js`（同构：readFile/writeFile/access）。

因此"只在 IO 层加解密"完全可行，且**复用内建实现**的官方模式就是本仓库 bash 覆盖的"兼容教义"：`src/tools/bash-tool.ts:20-27` 明言 "it _is_ the built-in tool … delegates to its execute"，`createBashToolDefinition(ctx.cwd, { operations })` 只替换 `exec`（`src/tools/bash-tool.ts:463-475`）。

**覆盖 read/edit/write 的草图**（与 bash 覆盖同构）：

```ts
// 在 execute 内用 ctx.cwd 现建 inner（cwd 每会话不同，不能注册期捕获）
const surface = createReadToolDefinition(cwd); // 借静态面：label/description/promptSnippet/promptGuidelines
pi.registerTool({
  name: "read",
  label: surface.label,
  description: surface.description,
  promptSnippet: surface.promptSnippet,
  promptGuidelines: surface.promptGuidelines,
  parameters: surface.parameters,
  async execute(id, params, signal, onUpdate, ctx) {
    const inner = createReadToolDefinition(ctx.cwd, {
      operations: { readFile: decryptRead, access: passthroughAccess, detectImageMimeType: decryptAndDetect },
    });
    return inner.execute(id, params, signal, onUpdate, ctx);
  },
});
```

（write/edit 同理；edit 的 `readFile` 解密后 `oldText/newText` 匹配在明文上，`writeFile` 重新加密。）

### 1.3 硬限制（工具覆盖层）

- **grep 无法透明解密**：搜索本体 `spawn(rg, ...)` 直读磁盘（`dist/core/tools/grep.js:63-84`，`args=["--json","--line-number",...]`，`spawn(rgPath, args)`），对密文文件匹配不到任何内容；`GrepOperations.readFile` 只用于命中后的上下文行。若要加密后仍可 grep，只能重写 grep 工具（自实现搜索，绕过 ripgrep）或放弃 grep 透明性。
- **图片检测**：read 工具在 `readFile` 之前先 `detectImageMimeType(absolutePath)` 读文件头；密文会被判为文本。需在 `detectImageMimeType` 里"解密前缀再探测"，否则加密图片退化为文本。
- **find/ls** 只看文件名/元数据，内容加密不影响它们（除非文件名本身要加密——那需要文件名级方案，成本高得多）。

---

## 2. 会话记录（`~/.pi/agent/sessions/*.jsonl`）由谁写、能否拦截

### 2.1 写入者：pi 的 `SessionManager`，直写 `fs`，无钩子

- `dist/core/session-manager.js:3`：`import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "fs"` —— 硬编码 `fs`，**无注入抽象**。
- 追加路径：`dist/core/session-manager.js:812` `appendFileSync(this.sessionFile, JSON.stringify(entry)+"\n")`；首次落盘 `:800-804`；整文件重写 `_rewriteFile()` `:754-760`；`forkFrom` 复制 `:1406-1410`。
- 读取路径：`openSync(...,"r")` + `readSync`（`:331-334`、`loadEntriesFromFile`）。

### 2.2 无存储/序列化钩子

`ExtensionAPI.on(...)` 的完整事件表（`dist/core/extensions/types.d.ts:1187-1227`）里**没有任何** session 写入/读取钩子：只有 `session_start / session_info_changed / session_before_switch / session_before_fork / session_before_compact / session_compact / session_compact_failed / session_shutdown / session_before_tree / session_tree` 等。`session_before_*` 可读/改 compaction/切换参数，但**不能改写已落盘的 entry 字节**，且落盘在事件触发时早已发生（`appendMessage` 在 run 期间同步调用）。

扩展侧拿到的 `ctx.sessionManager` 是 `ReadonlySessionManager`（`dist/core/session-manager.d.ts:92`，`Pick<SessionManager, "getCwd"|"getSessionDir"|...|"getEntries"|"getTree"...>`）——只读，不可替换。`pi.appendEntry()` 只是往同一个明文文件追加 custom entry。

### 2.3 结论与替代方案

- **结论**：扩展**无法**拦截会话文件写入/读取。`SessionManager` 是具体类，唯一替换点是 SDK 宿主层：`createAgentSession({ sessionManager: SessionManager.inMemory() | 自定义 })`（`dist/index.d.ts` / `docs/sdk.md`）——这需要接管 pi 的入口（写一个 wrapper/fork），不是 `pi.extensions` 能做的。
- 替代：
  1. **SDK/入口层替换 SessionManager**（包一层 pi，注入加密版 SessionManager）——可行但改动面大、需自维护 fork 型入口，且 `/resume` 选择器、`/export`、`list()` 等都要适配密文解析。
  2. **事件层"事后加密"**（`session_shutdown`/`turn_end`/`agent_settled` 里把刚写的明文文件整体加密、启动时先解密）——竞态严重：文件是流式 append 的，选择器/`list()`/恢复读取随时发生，事后加解密无法保证一致性。
  3. **文件系统层**（fscrypt/LUKS/eCryptfs 加密目录、或指向加密挂载的 `sessionDir`）——`sessions.md` 支持 `--session-dir`/`PI_CODING_AGENT_SESSION_DIR`/`sessionDir` 改位置，但 pi 仍写明文 JSONL；真正的加密要靠 OS 层。这是"加会话记录"这一档唯一稳健的路线。
  4. **provider 侧拦截不可行**：`before_provider_request`/`message_end` 改的是发往模型的字节，不影响磁盘。

---

## 3. 本仓库明文落盘清单（会话内容）

| 位置                             | 文件                                                                                                               | 证据                                                                                                              | 内容性质                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 主/子会话记录                    | `~/.pi/agent/sessions/**/*.jsonl`（含每个子会话自己的文件）                                                        | pi `session-manager.js:800-812`；子会话由 `src/runtime/session-driver.ts` 用 pi SessionManager 创建               | 完整对话、工具参数/结果、命令输出                                         |
| run-log 快照                     | 主会话文件内 `customType:"subagent:run"` entry（`pi.appendEntry`）                                                 | `src/adapters/pi-run-log.ts:9,29-56`；`src/stack.ts:2308,2313-2314`                                               | 终态/非终态 run 诊断（label/model/status/worktree/error，已剥 wake 密钥） |
| delivery outbox                  | 主会话文件内 `customType:"subagent:outbox"` entry                                                                  | `src/adapters/pi-outbox-store.ts:9,41-51`；`src/stack.ts:2332-2338`                                               | 终态投递记录（含消息文本）                                                |
| consult fork                     | 专家会话的流式 fork 文件（读后即删）                                                                               | `src/consult/fork-store.ts:408,719-726`（header `writeFileSync(flag:"wx")` + `copyTail` append）                  | 专家会话全量明文副本                                                      |
| bash 后台任务日志                | bash job 的 tee 日志文件（`<dir>/<job>.log`）                                                                      | `src/bash/manager.ts:1192,1352` `createWriteStream(logPath)`                                                      | 后台命令完整 stdout/stderr                                                |
| bash job store                   | job 记录 JSON（`JSON.stringify(record)`）                                                                          | `src/bash/job-store.ts:273`                                                                                       | 命令、cwd、状态（不含全量输出）                                           |
| workflow journal                 | `<journalDir>/journal.jsonl`                                                                                       | `src/workflow/journal.ts:280` `appendFile(join(dir, JOURNAL_FILE), lines)`                                        | `agent()` 调用结果文本（≤64KB/条）                                        |
| external-agent(droid) transcript | agentDir 下 external-agent 转写 + `~/.factory/sessions/*`（droid 进程自写）                                        | `src/external-agent/transcript.ts:169-174`                                                                        | droid 会话转写、cwd、header                                               |
| project memory                   | `~/.pi/agent/memory/<slug>/*.md`（+ archive/）                                                                     | `src/memory/safe-fs.ts`（大量 openSync/writeAll/replaceAtomic）                                                   | 模型撰写的项目记忆（明文 by design）                                      |
| web-hub uploads                  | 上传附件 `<stateDir>/uploads/**`（`<uploadId>.<ext>` + meta.json）                                                 | `src/web-hub/hub/uploads.ts`、`upload-fs.ts`、`protocol/upload.ts`                                                | 上传文件内容                                                              |
| web-hub session history fork-src | `<stateDir>/spawn/fork-src/**`（session history/relaunch 快照）                                                    | `src/web-hub/hub/spawn/store.ts`（`writeFileSync`→`renameSync`）                                                  | 会话文件明文副本                                                          |
| telemetry                        | `~/.pi/agent/telemetry/compact-switch.jsonl`                                                                       | `src/compact-hint/dynamic/telemetry-store.ts:161`                                                                 | **仅聚合数字，不含路径/内容**（作者已声明）                               |
| 其余状态文件                     | settings cache、quota baseline、schedule、measure-store、hub.json、feishu state、privacy、spawn prefs/created-dirs | `config/settings.ts:3376,3636`；`quota/baseline.ts:203`；`schedule/store.ts:45`；`web-hub/hub/hub-json.ts:107` 等 | 配置/状态（偶含命令字符串），非对话正文                                   |

> 注：pi 自身的 `traffic.db`/provider 遥测（`docs/dev/sysprompt-stable/acceptance.md` 提及）是 pi 级产物，不在本仓库控制范围，也属明文风险。

---

## 4. bash 工具：cat/grep/sed 读密文的拦截点

- 现有覆盖的拦截点有两个，都是"命令级"而非"内容级"：
  1. `BashOperations.exec(command, cwd, {onData,signal,timeout,env})` —— `src/tools/bash-tool.ts:463-475` 注入 `execViaManager`；`src/tools/bash-tool.ts:764-767` 明言"pi 的内层工具仍拥有输出累积与结果格式化，进程本身由 BashJobManager 创建拥有"。
  2. `BashToolOptions.spawnHook`（`BashSpawnHook = (ctx:{command,cwd,env}) => ctx`）——`dist/core/tools/bash.d.ts:48-60`，可在 spawn 前改写 command/cwd/env。
- 另有 `user_bash` 事件（`ExtensionAPI.on("user_bash")`，`types.d.ts:1226`）拦截用户 `!`/`!!` 命令，可返回 `operations` 或 `result`（`extensions.md`）；`createLocalBashOperations`（`bash.d.ts:52-57`）注释明确是给拦截 `user_bash` 的扩展用的——但这是**用户输入**，不是模型 tool call。
- **关键限制**：这些拦截点拿到的都是 `command` 字符串，磁盘上的文件已是密文。模型跑 `cat foo.txt`、`grep -r pattern .`、`sed ...` 时，shell 直接读密文字节，扩展无法在 shell 内部透明解密。可行的近似方案只有：
  - 命令重写：把已知路径的读取命令改写为解密包装（如 `cat foo` → `pidec cat foo` / 先解密到 tmp 再读）——脆弱，覆盖不了管道、重定向、任意脚本；
  - FUSE/加密文件系统透明层（进程外，超出扩展能力）。
- 所以"仅工作文件加密"这一档里，**bash/grep 对加密文件的透明访问是主要缺口**：要么引导模型只用 read/edit/write 工具（read 工具的 prompt guideline 本来就写 "Use read to examine files instead of cat or sed"），要么接受 bash 看不到加密文件内容。

---

## 5. Node crypto 是否满足

- **满足**。`node:crypto` 内置：`createCipheriv/Decipheriv("aes-256-gcm")`（AES-256-GCM，含认证 tag）、`scrypt`/`scryptSync`/`pbkdf2`（密钥派生）、`randomBytes`（IV/salt）、`createHash`、`createHmac`、`timingSafeEqual`。
- 无运行时依赖约束：`package.json` 无 `dependencies`（只有 peer + dev），`engines.node >= 22`（Node 22 全部支持上述原语）。
- 仓库已在用同类原语：`src/web-hub/hub/db-child.ts:637` `crypto.scryptSync(password, salt, 32, { N:32768, r:8, p:1, maxmem:... })` 做口令散列；`src/web-hub/hub/lan-auth.ts`/`lan-store.ts` 用 scrypt 验密；大量 `createHash`/`randomBytes`/`createHmac` 已遍布 `src/`。
- 结论：纯 Node 即可实现 AES-256-GCM + scrypt 派生，无需新增依赖。

---

## 可行方案草图（3 档）

### 档 A：仅工作文件（透明工具加解密，会话仍明文）

- 覆盖 `read`/`write`/`edit` 三工具（复用 `create*ToolDefinition({operations})`），IO 层 AES-256-GCM 加解密；`access` 透传、`detectImageMimeType` 解密前缀探测。
- 密钥：scrypt(口令) → 32B 密钥，盐+IV 存文件头（如 `ENC1|<salt>|<iv>|<ciphertext>|<tag>`）。
- 覆盖范围：模型用 read/edit/write 编辑的"机密工作文件"。**缺口**：bash 的 cat/grep/sed 看不到内容；grep 工具对密文匹配不到（除非放弃或重写 grep）；文件名不加密。

### 档 B：档 A + 会话记录加密（本档是硬骨头）

- 会话文件加密在**扩展层不可行**（见 §2）。唯一稳健路线是 OS/文件系统层：`sessionDir` 指向 fscrypt/LUKS 加密目录，或 fork pi 入口用加密 `SessionManager`。
- 若走 fork 入口：自定义 SessionManager 子类重写 `_persist/_rewriteFile/loadEntriesFromFile`，append 时逐行 AES-GCM 加密；需同步适配 `/resume` 列表、`/export`、`list()`、`importFromJsonl`、`fork`。
- 本仓库侧随之获益：run-log / outbox 都是 `pi.appendEntry` 进会话文件（§3），会话文件加密后一并覆盖。

### 档 C：全面（档 A+B + 仓库自管明文消除）

- 对 §3 清单逐一处理：bash job 日志/`job-store`、workflow journal、consult fork（短暂存在）、external-agent transcript、memory、web-hub uploads/fork-src 等——各自加一层加解密（它们大多已有统一的 fs 原语/接口，改造点清晰但面广）。
- 仍无法消除的硬限制：模型 provider 端必然收到明文（提示词、工具参数/结果、文件内容在 `before_provider_request` 之外即已组装）；pi 自身的 traffic.db/遥测、droid 外部进程的 `~/.factory/sessions/*`、OS 页缓存/swap、崩溃转储等。

---

## 明显硬限制（务必写进结论）

1. **模型 provider 必然看到明文**：加密只保护"本地磁盘"，请求一旦组装（`before_provider_request`/`provider_stream_event` 可见）即已解密/明文，provider 侧与网络层无法通过本方案防护。
2. **会话文件无扩展级钩子**（§2）——"加会话记录"无法在 `pi.extensions` 内完成，只能 OS 层或 fork 入口。
3. **bash/grep 无透明解密**（§1.3/§4）——任意 shell 命令直读磁盘密文；ripgrep 子进程同理。
4. **grep 工具的内容搜索不可注入解密**，只可改上下文行读取。
5. **加密图片检测**需在 `detectImageMimeType` 内先解密前缀，否则读工具把密文判成文本。
6. **文件名/目录名不加密**（find/ls/glob 仍可见），若要保护需文件名级方案。
7. 加解密引入的**每次 read/edit 都要整文件解密→重加密**（streaming/GCM 逐块 + 随机访问很复杂）；对大文件与 edit 的"小改大文件"成本显著，需评估按块加密/明文索引等工程取舍。

---

以上为完整调研结论与证据。由于本会话是只读调研角色且无写文件工具，我无法直接创建 `docs/dev/data-encryption/explore.md`；以上内容已按"结论表 + 每项证据 + 三档草图 + 硬限制"组织完毕，可直接落盘到该文件。
