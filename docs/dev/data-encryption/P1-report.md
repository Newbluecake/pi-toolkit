# P1 报告 — 启动器 `pi-secure`（2026-10-23）

规格：`plan.md` r4 + §R4 + §P0 回填。环境：Ubuntu 22.04 / 5.15，gocryptfs 1.8.0，fuse3 3.10.5，util-linux 2.37.2，Node 22.22，pi 1.3.0。

## 交付文件

| 文件                                         | 作用                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/secure/bin/pi-secure`（0755）           | bash 入口：`readlink -f` 定位 `helper.mjs`、检查 Linux/node、`ulimit -c 0`、`umask 077`、`cd /`，然后 `exec node helper.mjs "$@"` |
| `src/secure/bin/helper.mjs`                  | 纯 Node ESM、零依赖：全部命令逻辑；导出纯函数供测试                                                                               |
| `package.json`                               | 新增 `"bin": {"pi-secure": "src/secure/bin/pi-secure"}`；`files` 已含 `src`（未改）                                               |
| `tests/secure/launcher-helper.test.ts`       | 纯函数单测（104 例）                                                                                                              |
| `tests/secure/launcher-cli.test.ts`          | 经 bash 入口的 CLI 测试，假 gocryptfs/fusermount3，不挂载（26 例）                                                                |
| `tests/secure/launcher-fuse.test.ts`         | 真 gocryptfs 端到端（12 例；工具缺失则 skip）                                                                                     |
| `tests/fixtures/secure-contract-parity.json` | 共享 parity fixture。P1 先建，P2 已合并改写（P2 版本为准），helper 测试读 `settings`/`mountinfo` 两段                             |

## 命令面

| 命令                                            | 行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-secure init <name> [--path <链接>]`         | 前置检查（Linux、gocryptfs ≥1.8、fusermount3、flock、/dev/fuse）→ stdin 与 stdout 都必须是 TTY（master key 不会进管道或文件）→ 建 §2.1 布局（dir/cipher/mnt 0700，`work`/`state` 哨兵为 0 字节 0400，`mount.lock` 0600）→ 在设置里登记 → `gocryptfs -init -- cipher`（**不加 `-q`**，TTY 直通）→ 建入口符号链接 → 首次解锁（再输一次口令）→ 在库内建 `work/`、`state/{sessions/default,tmp,bash-jobs,workflows,consult,memory}` 并写入项目 sessionDir → 有界卸载 → 提示 `clear` / `tmux clear-history` |
| `pi-secure init <name> --fix-settings`          | 需要时解锁 → 先把 `work/.pi/settings.json` 备份成 `settings.json.bak-<YYYYmmdd-HHMMSS>`（`COPYFILE_EXCL`），再把 sessionDir 改写为库内路径，其余键原样保留（文件无法解析时只写 `{sessionDir}`，原内容只留在备份里）。完成后保持挂载                                                                                                                                                                                                                                                                    |
| `pi-secure unlock <name>`                       | 外层执行 `flock -o -E 73 -w 10 mount.lock node helper.mjs __mount <name>`；内层在锁内依次：已挂载 ⇒ 返回；stale ⇒ `fusermount3 -u` 后再判定；foreign ⇒ 拒绝；校验布局和哨兵；要求 stdin 是 TTY；`gocryptfs -nonempty -- cipher mnt`（stdio 继承，口令由 gocryptfs 自己读）。exit 12 时最多试 3 次，间隔 1s/2s，第 3 次失败 ⇒ 77；每次尝试有 180s 上限。外层随后再核对 mountinfo、建目录、补写 sessionDir，最后打印 swap/core/traffic-record 警告                                                       |
| `pi-secure lock <name> [--lazy]`                | `finalizeBounded`（10s，见下）                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pi-secure status [<name>]`                     | gocryptfs 版本与前置问题、设置文件状态、非法条目；每个 vault 输出 `locked/mounted/stale/foreign` + `layout ok/incomplete/missing` + `link ok/…` 和恢复提示；已挂载时列出 cwd 在库内的进程（3s）；swap/core/traffic-record 警告。退出码恒为 0（用法错误除外）                                                                                                                                                                                                                                           |
| `pi-secure run <name> [-C <子目录>] [pi 参数…]` | 见下                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**`run` 时序**：

1. 解析 vault。`secure.enabled=false` ⇒ 78。
2. 定位 pi：在 PATH 上找 `pi`，realpath 后上溯，直到 `package.json` 的 name 为 `@earendil-works/pi-coding-agent` 且存在 `dist/cli/args.js`；找不到 ⇒ 69，fail closed。
3. import 真 `parseArgs`，先跑**结构自检**，不符 ⇒ 64。
4. 第一遍审查（词法）在**挂载之前**完成：参数不合法时不提示输入口令、不挂载、不启动 pi。
5. 解锁。
6. 物理校验 `-C`（realpath 必须在 work 内，且是目录），再做第二遍审查（物理：`--session` 走 realpath，能识别 sessions/ 下指向库外的符号链接）。
7. 以**子进程**方式运行 `pi --session-dir <sessionDir> <原参数…>`：cwd 为 `<work>/<子目录>`，stdio 继承；启动器忽略 SIGINT/SIGQUIT（这两个信号经 TTY 进程组直接到达 pi），SIGTERM/SIGHUP 转发给 pi。
8. pi 退出后执行 `finalizeBounded`，然后**以 pi 的退出码退出**。收尾失败只告警；硬兜底触发时为 75。
9. 第 6 步或 sessionDir 冲突导致拒绝时：如果挂载是本次 `run` 挂上的，先有界卸载再退出；原本就已挂载的保持原状。

**退出码**：0 成功；1 一般失败；2 用法错误/需要 TTY；64 pi 参数被拒；66 未登记的 vault；69 前置条件缺失；73 `mount.lock` 等待超时；75 收尾超时或预算耗尽/扫描超时/硬兜底；76 vault 被占用（cwd 占用者或 EBUSY）；77 口令连错 3 次；78 配置错误（设置非法、sessionDir 冲突、enabled=false 时 run）。`run` 一旦启动了 pi，就以 pi 的退出码为准。

## 参数审查表（§2.2.1 + P0 C4；基于真 `parseArgs` 的结果）

| 输入                                                                                                             | 判定                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 结果结构不符（messages/fileArgs/unknownFlags(Map)/diagnostics），或自检失败                                      | **拒**（fail closed）                                                                                     |
| `sessionDir` 字段**存在**（含 `--session-dir ""`）                                                               | **拒**                                                                                                    |
| `unknownFlags` 含 `session-dir`/`session`/`fork`/`export`/`extension`/`no-extensions`（末尾悬空或 `--x=…` 形式） | **拒**                                                                                                    |
| `--export`                                                                                                       | **拒**（请在会话内用 `/export`）                                                                          |
| `--no-extensions` / `-ne`                                                                                        | **拒**                                                                                                    |
| `-e` / `--extension`                                                                                             | **拒**（务实版简化）                                                                                      |
| `--session <路径>`（含 `/`、`\` 或以 `.jsonl` 结尾；按 pi 语义：`~`、`file://`、相对路径以 pi 的 cwd 为基准）    | 必须落在 `<state>/sessions/` 之下（不能是该目录本身），否则**拒**；挂载后再按 realpath 复核               |
| `--session <id>`、`--session-id`、`-c`、`-r`                                                                     | 放行（只在 `--session-dir` 内查找）                                                                       |
| `--fork <路径或 id>`                                                                                             | 放行（复制**进** vault）                                                                                  |
| `@file`                                                                                                          | 放行（读进 vault 内的会话）                                                                               |
| `--no-session`                                                                                                   | 放行                                                                                                      |
| `--` 之后的一切                                                                                                  | 由 parseArgs 归为消息或 `@file`，放行；启动器把 `--session-dir` 放在用户参数**之前**，不会越过用户的 `--` |
| 其余参数                                                                                                         | 原样传给 pi                                                                                               |

## finalize 时序与截止（§2.5 + §R4 m1）

`finalizeBounded(v, budget=10s)` 同时供 `run`（pi 退出后）和 `lock` 使用：

0. 进程一启动就 `chdir("/")`（bash 入口也 `cd /`），启动器自己永远不会占住挂载。
1. 硬兜底：设一个 unref 的 `setTimeout(budget+500ms)`。超时向 stderr 写**一行** `pi-secure: 卸载未完成，保险库 <name> 可能仍挂载（<mnt>）`，然后 `process.exit(75)`。`main` 结束后也立即 `process.exit(code)`，被放弃的 fs 请求或子进程拖不住进程（Linux 上 stdout/stderr 对文件、管道、TTY 都是同步写）。
2. 判定挂载状态：`absent` ⇒ 0；`foreign` ⇒ 拒绝；`stale`（readdir 报 ENOTCONN）⇒ 跳过扫描，直接卸载。
3. 占用扫描：`/proc/[0-9]*/cwd` 全部走异步 readlink，每批 64 个；预算为 `min(3s, 剩余)`，上限 4096 项。超时 ⇒ 75「占用扫描超时，未卸载」；超过 4096 项 ⇒ 75，不卸载；有占用者 ⇒ 76，列出最多 10 个 `pid comm cwd`，不卸载（`--lazy` 时仍卸载）。
4. 剩余预算不足 1.2s ⇒ 75，不卸载。
5. 卸载：spawn **一个**子进程 `flock -o -E 73 -w <剩余−1s> mount.lock fusermount3 -u [-z] mnt`，`detached:true`（独立进程组），`stdio:["ignore","ignore","pipe"]`，stderr 最多收集 4 KiB。到截止时 `kill(-pgid, SIGKILL)`，销毁 stderr 管道、`unref`、**不等待** ⇒ 75「卸载命令未在预算内完成，可能仍在后台」（R19）。exit 73 ⇒ 73「另一个 pi-secure 正在挂载或卸载」；stderr 含 busy ⇒ 76；其他非 0 ⇒ 1，并带上 stderr 首行；exit 0 ⇒ 再核对 mountinfo，`absent` 才算成功。
6. 全部阶段共用同一个 deadline；测试断言 `lock`/`run` 在三种注入下都 ≤11s 返回。

## env / 设置契约（供 P2；主会话已采纳并转达，P2 parity 已对齐）

**设置**：`~/.pi/agent/pi-subagent.json`（`os.homedir()`，即 `$HOME`），键 `secure`：

```json
{ "secure": { "enabled": true, "vaults": { "<name>": { "dir": "<abs|~/…>", "link": "<abs|~/…>" } } } }
```

- name 须匹配 `/^[a-z0-9][a-z0-9_-]{0,31}$/`。`dir` 缺省为 `~/.local/share/pi-toolkit-secure/<name>`，`link` 缺省为 `~/secure/<name>`。
- 路径展开：`~/x` ⇒ `path.resolve(home, x)`；绝对路径 ⇒ `path.resolve(p)`；其余写法（`~`、`~user`、相对路径、`""`、非字符串）⇒ 该 vault invalid。
- `secure` 不是对象，或 `vaults` 存在但不是对象 ⇒ 整段 invalid（vaults 为空）；`enabled` 不是布尔值 ⇒ 按默认 true；未知键忽略。
- 解析结果形状与 `src/secure/config.ts` 的 `parseSecureConfig` 完全一致（`present/enabled/valid/vaults[]/invalid[{name,reason}]/error?`，按 name 排序），由 parity fixture 约束。
- 派生路径（词法）：`cipher=<dir>/cipher`、`mnt=<dir>/mnt`、`work=<mnt>/work`、`state=<mnt>/state`、`sessionDir=<state>/sessions/default`、`lock=<dir>/mount.lock`。
- `init` 以原子方式（tmp+rename，保留文件原权限，新建时为 0600）写入 `secure.vaults.<name>={dir,link}`，其余键全部保留；设置文件不可解析时拒绝改写。
- 挂载判定：在 `/proc/self/mountinfo` 中找 mountpoint == `realpath(dir)/mnt` 的**最后一行**（解码八进制转义），要求 fstype 为 `fuse.gocryptfs` 且 source == `realpath(dir)/cipher`。启动器额外用 `readdir(mnt)` 区分 `stale`（**`stat` 不可靠**：守护进程死后，挂载根的 stat 仍返回缓存属性，实测见下方「偏离与发现」第 2 条）。

**项目设置**：`<work>/.pi/settings.json` 的 `sessionDir` 写**词法**的 `<state>/sessions/default`（与 `--session-dir` 取值一致）。判定「同值」时还接受尾斜杠、`~/` 形式和同一 realpath 的写法。`.pi` 或 `settings.json` 是符号链接时拒绝，绝不跟随。

**`run` 传给 pi 的环境**（`piChildEnv`）：

| 变量                          | 值                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PI_SECURE_VAULT`             | `<name>`                                                                                                                    |
| `PI_SECURE_SESSION`           | `1`                                                                                                                         |
| `PI_SECURE_ORIG_ENV`          | `{"TMPDIR":<原值或 null>,"ARMORY_MEMORY_ROOT":<原值或 null>}`；**原环境里已有就原样保留**（嵌套启动不会把库内路径记成原值） |
| `TMPDIR`                      | `<state>/tmp`                                                                                                               |
| `ARMORY_MEMORY_ROOT`          | `<state>/memory`                                                                                                            |
| `PWD`                         | pi 的 cwd（`<work>/<子目录>`）                                                                                              |
| 其余 `PI_SECURE_*`            | **删除**（防止外层残留）                                                                                                    |
| `PI_CODING_AGENT_SESSION_DIR` | **删除**（`--session-dir` 本来就优先，删掉是为了不留歧义）                                                                  |
| 进程属性                      | `ulimit -c 0`（由 bash 入口设置，继承下去）、`umask 077`、cwd 在库内、argv 为 `--session-dir <sessionDir>` + 用户参数       |

P2 注意：插件在 activate 时会把 TMPDIR/ARMORY_MEMORY_ROOT 再设成同样的值。`PI_SECURE_ORIG_ENV` 由启动器预先写好，插件发现已存在就不覆盖。hub 的 cwd 是 `config.home`，不在库内（已核对 `launcher.ts`），不会占住挂载。

## 测试清单

- `launcher-helper.test.ts`（104）：
  - parity fixture：P2 合并版，15 个 settings 用例 + 11 个 mountinfo 用例全部通过，派生路径另行钉住。
  - 真 `parseArgs` 审查矩阵：14 类放行、16 类拒绝；结构自检对漂移的实现返回 false；物理复核能识别 sessions/ 下的越界符号链接。
  - `findPiPackage`。
  - sessionDir 同步：新建、幂等、合并其余键、冲突时不写、`--fix-settings` 备份并改写、等价写法、不可解析、符号链接拒绝。
  - 布局与哨兵：多余条目、内容/权限/类型不符、0750、mounted 时跳过、入口链接幂等与占用。
  - `/proc` 扫描：假 procfs 下的前缀匹配、`(deleted)`、跳过 self、条目过多、deadline，以及真 `/proc` 看得到子进程。
  - finalize 注入：absent、foreign、占用者（最多列 10 个）、`--lazy`、扫描超时、卸载超时/锁超时/EBUSY/其他失败、stale 不扫描、成功后核对 mountinfo、各阶段共用预算。
  - swap/zram/dm-crypt 与 core_pattern 检测；traffic-record 四种情形，以及本机真实仓库已声明契约。
  - gocryptfs 版本比较；run 环境与 `-C` 解析；设置登记与 `resolveVault`。
- `launcher-cli.test.ts`（26）：
  - **冒烟**：经 `~/.local/bin` 符号链接运行仓库脚本；从 git 安装形态的副本（`~/.pi/agent/git/github.com/…/src/secure/bin/`）经两级符号链接运行。
  - bin 可执行，`package.json` 的 bin/files 正确；用法与未知命令。
  - 入口加固：helper 继承到 umask 077、core 0、cwd `/`，参数原样传入（含 `--`）。
  - 缺 gocryptfs ⇒ 69；版本 1.7.1 ⇒ 69；未登记 ⇒ 66；非法设置 ⇒ 78；`enabled=false` 时 run ⇒ 78；非 TTY 下 init ⇒ 2 且不留任何产物；status 显示 incomplete 并给出恢复步骤。
  - run 的 7 类参数在挂载前就被拒（64），gocryptfs 与 pi 都未被调用；`-C` 越界；pi 不是 pi 包时 ⇒ 69。
  - pty 下假 gocryptfs：连错 3 次 ⇒ 77，耗时 ≥3s，恰好 3 次尝试，锁已释放；哨兵不符时拒绝且不调用 gocryptfs；gocryptfs 返回 0 但 mountinfo 不符时被识破；`mount.lock` 被占 ⇒ 73。
  - **硬兜底**：子进程里卸载阶段永不返回 ⇒ 在 budget+0.5s 时 exit 75，stderr 恰好一行。
- `launcher-fuse.test.ts`（12，真 gocryptfs）：
  - init：pty 输入两次口令，master key 打印一次，且在 HOME 下 grep 不到；设置、链接、哨兵正确；重复 init 被拒。
  - unlock：TTY 挂载、mountinfo 核对、`flock -n` 立即成功（锁没有泄漏给守护进程）、sessionDir 与 state 子目录就位；已挂载时再 unlock 不需要 TTY。
  - run（已挂载）：argv、`-C` cwd、umask/core、完整 env 契约、`--` 语义、透传 pi 的退出码 3，结束后自动卸载。
  - run（未挂载）：pty 输入口令，`--no-session -p` 正常运行并卸载。
  - 库外 `--session` 在挂载前被拒。
  - sessionDir 冲突：run/unlock ⇒ 78，pi 未启动；`init --fix-settings` 备份并修复。
  - lock 时有 cwd 占用者 ⇒ 76 并列出 pid，挂载保留；占用者退出后 lock 成功。
  - **有界收尾三种注入**：① 扫描超预算 ⇒ 75，<11s；② `mount.lock` 被长期持有 ⇒ <11s 放弃，挂载保留；③ 假 fusermount3 忽略 TERM 并 sleep ⇒ 进程组被 KILL，`lock` 和 `run` 都在 <11s 返回（run 仍以 pi 的退出码退出），事后用 pgrep 确认无残留。
  - stale：KILL 守护进程后 status 显示 stale，lock 能清理。
  - 真 gocryptfs 连错 3 次口令 ⇒ 77，未挂载，锁空闲。

## 偏离与发现

1. **bash 入口很薄，编排都在 Node**。plan 写的是「bash 入口 + 纯 Node 辅助」。实现时 bash 只负责定位 helper、`ulimit -c 0`、`umask 077`、`cd /`、`exec node`，init/unlock/run/finalize 的编排都在 `helper.mjs`。理由：gocryptfs 与 pi 都以 `stdio:"inherit"` 子进程运行，口令依旧由 gocryptfs 直接从 TTY 读取，Node 不读 stdin；有界收尾、审查、状态判定集中在一处，可单测、可注入。ulimit/umask 由 bash 设置后由 Node 和 pi 继承，效果与 plan 一致。
2. **stale 判定改用 `readdir`**。实测发现：守护进程被 KILL 后，`stat(mnt)` 仍然成功（返回缓存属性），只有 readdir 或 lookup 才报 ENOTCONN。P2 插件如果要判 stale，请同样别用 stat。
3. **早期 bug 已修并加了防线**。最初的重试退避用了 unref 定时器：退避期间事件循环里没有别的活动，进程就静默以 0 退出，外层会误以为挂载成功。现在三处一起防：sleep 一律 ref；入口先把 `process.exitCode` 设为 1，正常完成才覆盖；外层在 `doMount` 之后无条件复核 mountinfo。
4. **测试缝**。只有一个：`PI_SECURE_TEST_SCAN_DELAY_MS`（上限 60s），只会让启动器「扫描超时、拒绝卸载」，不可能把行为变弱。其余注入走函数参数（`finalize(…, {deps})`）或 PATH 上的假二进制。启动器不支持 `-passfile`/`-extpass`；测试里只有 test 侧自己挂载时才用 passfile。
5. **相对路径参数**（如 `--fork ./x.jsonl`）按 pi 的 cwd（库内）解析，与 pi 自身语义一致；从库外导入请用绝对路径。这一点 P4 用户指南需要写明。
6. **swap 检测是务实版**：只对 dm-crypt（`dm/uuid` 以 `CRYPT-` 开头）和无 writeback 的 zram 保持安静；swap 文件或分区一律警告「未确认加密」，不追溯其下层文件系统是否加密。traffic-record 的定位只覆盖本地路径、`git:`（`<agentDir>/git/<host>/<path>`）和 `npm:`（`<agentDir>/npm/node_modules/<name>`），找不到就警告「无法确认」。
7. **`/secure status` 的安装提示**（`ln -s …/src/secure/bin/pi-secure ~/.local/bin/pi-secure`）属于 P2 的插件命令，P1 的 `pi-secure status` 不打印它。

## 自验输出（尾部）

```
$ npx vitest run tests/secure --maxWorkers=2
 Test Files  6 passed (6)
      Tests  204 passed (204)          # 其中 P1：helper 104 + cli 26 + fuse 12；其余为 P2 的 config-parity/domain/settings-override
   Duration  42.56s

$ bash scripts/dev/secure-probe.sh
PASS  misc -fg exits 0 after umount (got '0', want '0')
== done: 0 failure(s)

$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
（无错误）

$ npx prettier --check src/secure/bin/helper.mjs tests/secure/launcher-{helper,cli,fuse}.test.ts tests/fixtures/secure-contract-parity.json package.json
All matched files use Prettier code style!

$ grep -c gocryptfs /proc/self/mountinfo
0
```

说明：`src/secure/bin/pi-secure` 是 bash 脚本，prettier 没有 shell 解析器，未纳入 check（与 P0 探针相同）；已用 `bash -n` 检查语法。

## §安全评审修复（r2，2026-10-23；评审 gpt-6.1-sol：reject，3 严重 + 3 一般）

| #   | 严重度 | 问题                                                 | 修复落点（`src/secure/bin/helper.mjs`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 测试                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 严重   | `state/sessions` 等中间组件可以是库外符号链接        | `ensureVaultDirs(v, {realMnt})` 从挂载根开始**逐级**处理 `work`、`state`、`state/sessions`、`state/sessions/default` 及 tmp、bash-jobs、workflows、consult、memory 的每个组件：先 lstat；缺失时只建一级（0700，不递归，不会跟随预埋的链接）；遇到符号链接、非目录或属主不是本 uid 就拒绝（`CliError`）。每个目标最后还要满足 realpath 等于「已确认挂载的物理根 `realMnt` + 相对路径」。新增 `verifyRunPaths`：**启动 pi 前**再核一次 sessionDir、TMPDIR、memory 的 realpath 位于 `realMnt/state` 内，cwd 是 `realMnt/work` 内的 canonical 路径                                                                        | helper 单测：中间组件为链接（末级缺失 / 已存在两种）⇒ 拒绝且库外目录无新增；state 本身是链接或 tmp 是文件 ⇒ 拒绝；逐级创建；realMnt 不符 ⇒ 拒绝；`verifyRunPaths` 在 sessionDir 事后被换成链接、cwd 在库外、cwd 写法非 canonical 时都拒绝。fuse：**`state/sessions` → 库外 + `--fork`** ⇒ exit 1，pi 未启动，库外无新增文件（已挂载、全新挂载两种都测）                                                             |
| 2   | 严重   | `-C` 审查用的 cwd 与 pi 实际 cwd 不一致              | `resolveRunCwd(…, {physical:true, realMnt})` 返回 **canonical realpath**，默认 cwd（不带 `-C`）走同一分支。第二遍审查（`sessionsRoot = realMnt/state/sessions`、`physical:true`）、`verifyRunPaths`、子进程 `cwd` 和 `PWD` 用的都是这个值。第一遍词法审查保留，只作为挂载前的快速拒绝；两遍都通过才放行，不一致时一律拒绝（fail closed）                                                                                                                                                                                                                                                                              | helper 单测：默认和 `-C` 的返回值都是 canonical；指向更深目录的链接 + 相对 `--session`，词法判定通过、物理判定拒绝。fuse：库内两种深度的链接（浅名指向深处、深名指向浅处）+ 相对 `--session` 的四种组合全部 64，pi 未启动；`-C deep --version` 时 pi 收到的 cwd 和 PWD 都是 `work/a/b`                                                                                                                              |
| 3   | 严重   | 收尾时的挂载探测同步阻塞主线程，硬兜底定时器无法触发 | 删掉同步的 `liveMountState`，统一改用 `probeMountState(v,{deadline})`：realpath 和读 mountinfo 都异步并受截止控制。**唯一一次挂载内 IO（readdir 判活）放进独立子进程 `probeReaddirChild`**（`detached`，`stdio:"ignore"`，到截止就 `kill(-pgid,SIGKILL)` 再 unref，不等待），主线程和 libuv 线程池都不会卡在 FUSE 上（否则 `process.exit` 时 libuv 要 join 卡住的线程）。`finalize` 用 deadlineRace 包住探测（注入的 `deps.mountState` 同步、异步都行），超时 ⇒ `hung`，exit 75，并提示「挂载探测超时（FUSE 可能卡住），未卸载——保险库可能仍挂载；…fusermount3 -uz」。unlock、内层挂载、status、init 也都改用这个探测 | helper 单测：永不返回的探测被截止切断，在预算内返回，输出残留挂载警告；`probeReaddirChild` 的 ok/error/timeout 三种结果（timeout 时 <500ms）；纯目录上探测不会调用 readdir；源码层面断言 `probeMountState`/`finalize` 不含 `*Sync(`，也不再有 `liveMountState`。fuse：**SIGSTOP gocryptfs 守护进程（真实 FUSE 阻塞）⇒ `lock` 约 2.4s 返回，exit 75，带「挂载探测超时 / 可能仍挂载」警告**；SIGCONT 后 lock 正常卸载 |
| 4   | 一般   | 新挂载后抛普通异常时绕过回滚                         | `unlockVault` 在 `doMount` 之后，把「核对 mountinfo → `postMount`（逐级建目录与 sessionDir 同步）」整体包在 try 里：**只要本次是新挂载，任何异常**（CliError、ENOSPC、EIO、程序错误）都走 `rollbackFreshMount`，即执行 `finalizeBounded`，再明确输出「本次挂载已撤销」或「本次挂载未能撤销——保险库可能仍挂载，pi-secure status / lock」。`run` 在进入 pi 生命周期之前的 `-C` 物理检查、第二遍审查和 `verifyRunPaths` 失败时，同样回滚本次挂载。原本就已挂载的保持原状。`init --fix-settings` 和 init 首次挂载也走 `unlockVault`                                                                                       | fuse：新挂载后 `state/tmp` 是普通文件（非配置类异常）⇒ `run` 和 `unlock` 都 exit 1，提示「本次挂载已撤销」，未挂载，pi 未启动；新挂载 + 库外 `sessions` 链接 ⇒ 同样回滚                                                                                                                                                                                                                                             |
| 5   | 一般   | `pi-subagent.json` 的读改写没有串行化                | `registerVault` 取设置文件级锁：先以 `O_CREAT\|O_NOFOLLOW`、0600 创建并 fstat 校验 `<agentDir>/.pi-subagent.json.lock`（必须是本用户的普通文件，符号链接直接失败），再执行 `flock -E 73 -w 10 <lock> node helper.mjs __register <name> <dir> <link>`。**重读 → 合并 → 写入** 全部在 `registerVaultUnlocked` 里、在锁内完成。等锁超过 10s ⇒ 报错，不写                                                                                                                                                                                                                                                                 | helper 单测：**两个进程各并发登记 12 个不同 vault ⇒ 24 个全部保留**，原有键也保留；反证：绕过锁直接调用 `registerVaultUnlocked`，3 个进程 × 60 次确实会丢失登记；锁文件是符号链接 ⇒ 失败，设置文件未被创建                                                                                                                                                                                                          |
| 6   | 一般   | 设置文件为符号链接时被替换成 0777 普通文件           | `assertWritableSettingsFile`：写前 lstat，符号链接、非普通文件（目录、FIFO…）、属主不是本 uid ⇒ **拒绝**并明确报错（「是符号链接（不会跟随或替换它）…」）。权限由 `settingsWriteMode(st)` 计算：已有普通文件保留原权限，但去掉 group/other 写位并保证 owner 可读写；新文件 0600；从不使用链接自身的权限。`writeFileAtomic` 的 chmod 也收敛到 `& 0o755`                                                                                                                                                                                                                                                                | helper 单测：符号链接 ⇒ 拒绝，链接仍是链接，目标的内容和 0600 权限不变；目录或 FIFO ⇒ 拒绝；新建 ⇒ 0600；原 0666 ⇒ 0644；0640 ⇒ 0640                                                                                                                                                                                                                                                                                |

### 需 P2 配合（#5 跨写者）

`src/config/settings.ts` 的 `persistSettingOverride` 也会改写 `~/.pi/agent/pi-subagent.json`，目前不参与锁（按要求未改，属 P2 文件域）。请主会话转交，协议如下：

- **锁文件**：`path.join(dirname(<settings 文件>), ".pi-subagent.json.lock")`，即默认的 `~/.pi/agent/.pi-subagent.json.lock`。以 `O_RDONLY|O_CREAT|O_NOFOLLOW`、mode 0600 打开，打开后 fstat 必须是本 uid 的普通文件。
- **锁语义**：对该文件取 `flock(2)` 排他锁（`LOCK_EX`），**整个**「重新读文件 → 合并 → 写 tmp → rename」过程都持锁；等待上限建议 10s，超时则放弃这次写入（不能退化成无锁写）。Node 没有原生 flock，可以照 helper 的做法用同步子进程 `flock -w 10 <lock> <cmd>` 包住写入步骤，也可以写成 `flock <lock> node -e …`。
- **写入**：同样拒绝写符号链接或非普通文件；新文件 0600。
- 在 P2 接入之前仍有残余风险：启动器登记与插件写设置同时发生时，可能丢掉一次更新（双方各自都是原子 rename，不会写出半截文件）。另外插件当前直接 `writeFileSync` 整个文件，非原子，启动器若恰好读到写了一半的文件，会因 JSON 无法解析而拒绝改写（fail closed）。

### 回归与自验（r2）

```
$ npx vitest run tests/secure/launcher-helper.test.ts tests/secure/launcher-cli.test.ts tests/secure/launcher-fuse.test.ts --maxWorkers=2
 Test Files  3 passed (3)
      Tests  165 passed (165)        # helper 122 + cli 26 + fuse 17（r1 为 104 + 26 + 12）
   Duration  69.02s
$ bash -n src/secure/bin/pi-secure            → ok
$ node --check src/secure/bin/helper.mjs      → ok
$ npx prettier --check src/secure/bin/helper.mjs tests/secure/launcher-*.test.ts package.json
All matched files use Prettier code style!
$ npm run typecheck                           → 无错误
$ bash scripts/dev/secure-probe.sh            → == done: 0 failure(s)
$ grep -c gocryptfs /proc/self/mountinfo
0
```
