# system prompt 稳定化 — 手工验收步骤（A1 / A2）

> 对应 `docs/dev/sysprompt-stable/plan.md` v3.1 §7.3「手工验收」。T-REAL 已按 D13 移出交付，
> 这两组步骤是唯一的端到端验收方式。取证方法沿用 `docs/dev/cache-ttl-adaptive/` 的取数套路：
> `~/.pi/agent/records/traffic.db`（`pi-traffic-record` 扩展落的每请求原始载荷）+ 会话 jsonl。
>
> 前提：装了 `pi-traffic-record`（或等价的请求录制扩展）；本机验证过 `sqlite3` 自带 `sha3()`
> 函数（`SELECT hex(sha3('x'));` 应输出 `741efa311f97686956946758e0d95f70f11ff2da4f2feb7c54314f44134ac49f`
> 的大写形式），否则改用下面「无 sha3 时的退路」一节的 Python 脚本。

## 0. 一次性准备

1. `/agent settings list` 确认三键都在（默认即可）：`systemPrompt.mode=stable`、
   `systemPrompt.wakeReplay=true`、`systemPrompt.adoptForeignForcedPrompt=false`。
2. 记下当前 provider：A1 要求跑在 `cloudrouter-anthropic`（或任意 Anthropic-shape 的 provider，
   请求载荷里有顶层 `system` 字段）之上；不是 Anthropic-shape 的 provider（比如某些 OpenAI-shape
   路由，system 混进 `messages[0]`）用下面「§3 provider 兼容性」一节的变体查询。
3. 打开录制：`/record on`（或该扩展等效命令）。记下 pi 分配的**当前会话 id**——`/agent status`
   或状态栏通常会显示；也可以稍后从 `sqlite3 ... "select distinct session_id from requests order by
id desc limit 5;"` 里认出最新的一条。下文用 `$SID` 代指它。
4. 找到本会话的 jsonl 路径：`~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<session-id>.jsonl`
   （`<cwd-slug>` 是 cwd 把 `/` 换成 `-` 的样子，比如 `/home/bluecake/ai/pi-toolkit` →
   `--home-bluecake-ai-pi-toolkit--`）。下文用 `$JSONL` 代指它。

### traffic.db 表结构（已用 `sqlite3 -readonly` 核实，只读，未改动任何数据）

```
$ sqlite3 -readonly ~/.pi/agent/records/traffic.db ".schema requests"
CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL DEFAULT 0,
    ts TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    payload TEXT NOT NULL,        -- 完整请求体 JSON（Anthropic-shape 时顶层有 "system" 字段）
    request_headers TEXT,
    status INTEGER,
    response_headers TEXT,
    url TEXT, method TEXT, origin TEXT, replay_of INTEGER,
    orig_payload TEXT, orig_request_headers TEXT,
    rewrite_rule_ids TEXT, rewrite_status TEXT, rewrite_error TEXT,
    payload_encoding TEXT, payload_bytes INTEGER
);
CREATE INDEX idx_requests_session ON requests(session_id, id);
```

（`sessions` / `messages` 表与本次验收无关，从略。）

**关键坑**：Anthropic-shape 请求的 `payload.system` 不是一个字符串，是**内容块数组**
（`[{ "type": "text", "text": "...", "cache_control"?: {...} }, ...]`）——直接
`json_extract(payload,'$.system')` 拿到的是这个数组的 JSON 文本本身（含 `cache_control` 字段，
每次请求这块可能因 breakpoint 位置不同而字面不同，即使正文字节完全没变），**不能**直接拿它去比字
节稳定性，必须先把各块的 `text` 字段拼接起来再比。下面的查询已经处理了这一步。

## 1. A1（S1：唤醒回放）

**场景**：用户轮 → 等一次子 agent 完成通知把主会话唤醒 → 用户轮。三次请求的 system 应逐字节相同。

1. 在主会话里发一条会触发唤醒的消息，例如：
   `Agent({ prompt: "sleep 5s then say done", subagent_type: "general-purpose" })`（前台 spawn 会在
   完成时给父会话发通知唤醒；也可以后台 spawn 后等 `get_subagent_result` 之外的完成通知）。
2. 记录三次请求发生的大致时间窗口：① spawn 前的用户轮请求，② 子 agent 完成通知把主会话唤醒后的
   第一个请求（无用户消息，是 `triggerTurn: true` 的唤醒轮），③ 唤醒轮结束后你再发一条消息触发的
   下一个用户轮请求。
3. 跑查询（把 `$SID` 换成真实 session id；下面按时间顺序打印每个请求的 system 字节数与 sha3）：

```sh
sqlite3 -readonly ~/.pi/agent/records/traffic.db "
SELECT
  r.id, r.turn, r.ts, r.model,
  length((SELECT group_concat(json_extract(j.value,'\$.text'), '')
          FROM json_each(r.payload, '\$.system') j)) AS system_bytes,
  hex(sha3((SELECT group_concat(json_extract(j.value,'\$.text'), '')
            FROM json_each(r.payload, '\$.system') j))) AS system_sha3
FROM requests r
WHERE r.session_id = '$SID'
ORDER BY r.id;
"
```

4. **判定标准**：跨越①②③的三行 `system_sha3` 完全相等。
5. **cache 命中判定**（用 jsonl 里 assistant 消息的 usage 字段，`$JSONL` 换成真实路径）：

```sh
python3 - "$JSONL" <<'PY'
import sys, json
rows = []
with open(sys.argv[1]) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj.get("type") == "message" and obj.get("message", {}).get("role") == "assistant":
            u = obj["message"].get("usage") or {}
            if u:
                rows.append((obj["timestamp"], u.get("input"), u.get("cacheRead"), u.get("cacheWrite")))
for ts, i, cr, cw in rows[-8:]:
    print(ts, "input=", i, "cacheRead=", cr, "cacheWrite=", cw)
PY
```

取「上一请求前缀」= 上一条 assistant 消息的 `input + cacheRead + cacheWrite`；唤醒请求与其后
用户请求各自的 `cacheRead ≥ 上一请求前缀 × 0.9`（10% 容差给普通对话增量）。6. **可证伪对照**（证明这套判定确实能分辨「未开 wakeReplay」和「开了」）：把 settings 改成
`{ "systemPrompt": { "wakeReplay": false } }`，`/reload`，重复步骤 1–3；此时唤醒请求的
`system_sha3` 应该**不等于**用户轮的（唤醒轮回退到今天的行为：只有 base，没有三段）。跑完后把
`wakeReplay` 改回 `true` 并 `/reload`。7. 可选：重新统计 `docs/dev/cache-ttl-adaptive/field-2026-09-24.md` §1.2 那种「跨类/同类整前缀失效
率」（同一批 ≥15 个跨类样本），跨类失效率应回落到与同类失效率相差 ≤5 个百分点（≤5pp 之内视为
同一水平；今天验收前的现场基线是跨类 44% vs 同类 10%）。

## 2. A2（stable 主方案：快照 + 尾部更新 + `/reload` + `/compact`）

**场景**：连续两个用户轮之间写一条记忆、期间插一次通知唤醒；随后 `/reload`；再空闲触发一次
`/compact`。

1. 用户轮 #1：正常发一条消息（比如 "ls"）。
2. 触发一次通知唤醒（同 A1 步骤 1），不发用户消息，让它自己结束。
3. 写一条记忆（比如让模型调用 `memory` 工具 append 一条，或直接
   `echo "test note" >> ~/.pi/agent/memory/<slug>/notes.md`，`<slug>` 是当前 cwd 的 slug——用
   `/mem path` 能拿到准确目录）。
4. 用户轮 #2：再发一条消息。
5. 跑 §1 步骤 3 的 SQL（同一个 `$SID`），检查：
   - 用户轮 #1、唤醒轮、用户轮 #2 三次请求的 `system_sha3` **相等**（记忆写入还没到下一次刷新点，
     开头字节不变——这正是本方案要验证的核心：真实变化不改开头）。
   - 用户轮 #2 的 `cacheRead ≥ 上一请求前缀 × 0.9`（同 §1 步骤 5）。
6. 检查更新消息确实进了上下文，且排在用户轮 #2 的用户消息之后（`$JSONL` 换成真实路径）：

```sh
python3 - "$JSONL" <<'PY'
import sys, json
with open(sys.argv[1]) as fh:
    lines = [json.loads(l) for l in fh if l.strip()]
last_user_idx = max(
    i for i, o in enumerate(lines)
    if o.get("type") == "message" and o.get("message", {}).get("role") == "user"
)
update_idx = next(
    (i for i, o in enumerate(lines)
     if o.get("type") == "message"
     and o.get("message", {}).get("role") == "custom"
     and o["message"].get("customType") == "subagent:prompt-section-update"),
    None,
)
print("last user message index:", last_user_idx)
print("update message index:", update_idx)
assert update_idx is not None, "no update message found — memory write likely didn't register as a change"
assert update_idx > last_user_idx, "update message is NOT after the last user message"
print("OK: update message follows the last user message")
PY
```

7. `/reload`。
8. 用户轮 #3：发一条消息。跑 §1 步骤 3 的 SQL：用户轮 #3 的 `system_sha3` 应与 `/reload` 之前的
   完全一致（快照跨 `/reload` 存活，U6），且 `cacheRead ≥ 上一请求前缀 × 0.9`（`/reload` 不再触发
   整前缀重写）。
9. 确认 `/reload` 没有产生新的快照会话条目（会话条目不在 jsonl 的 `message` 里，是顶层
   `type:"custom"` 记录；下面统计 `/reload` **之后**新增的条目数，期望是 0——`/reload` 只是重新读
   已有条目，不重新持久化）：

```sh
python3 - "$JSONL" <<'PY'
import sys, json
with open(sys.argv[1]) as fh:
    entries = [json.loads(l) for l in fh if l.strip()]
snapshots = [
    e for e in entries
    if e.get("type") == "custom" and e.get("customType") == "subagent:prompt-sections"
]
print("total subagent:prompt-sections entries in this jsonl:", len(snapshots))
for e in snapshots:
    print(" -", e.get("timestamp"))
PY
```

（这条 jsonl 是 `/reload` 前后同一个会话文件，因为 `/reload` 不会新开会话文件；比较该命令在
`/reload` 前后跑两次的计数差，期望差值为 0。）10. 空闲后触发一次压缩（`/compact` 或等它自动触发），随后发一条新用户消息。再跑 §1 步骤 3 的 SQL：
这一轮的 `system` 里应该**含有新写入的记忆**（说明压缩后的免费刷新点生效了），且**不再跟着一条
`subagent:prompt-section-update` 消息**（因为内容已经直接进了开头，没有「差异」要通知）——用
步骤 6 的脚本但把 `assert update_idx is not None` 去掉，改成断言这一次没有新的 update 消息。

## 3. provider 兼容性（system 不是 Anthropic-shape 时）

某些 provider（典型是 OpenAI-shape 路由）没有顶层 `system` 字段，system 文本混进
`messages[0]`（`role` 是 `"system"` 或 `"developer"`）。这种 payload 下 §1/§2 的 SQL 里
`json_each(r.payload,'$.system')` 会返回空、`system_sha3` 全是 NULL——不是跑挂了，是选错字段。
换成：

```sh
sqlite3 -readonly ~/.pi/agent/records/traffic.db "
SELECT r.id, r.turn, r.ts,
  hex(sha3(json_extract(r.payload, '\$.messages[0].content')))
FROM requests r
WHERE r.session_id = '$SID' AND json_extract(r.payload,'\$.messages[0].role') IN ('system','developer')
ORDER BY r.id;
"
```

（`content` 在这类 payload 里通常已经是纯字符串；如果某个 provider 把它也拆成块数组，套用 §1 步骤
3 的 `json_each` 拼接写法。）A1/A2 的判定标准（哈希相等、`cacheRead` 比例）不变。

## 4. 无 `sha3()` 时的退路

如果 `SELECT hex(sha3('x'));` 报错（老版本 sqlite3 没编译 `sha3` 扩展函数），改用 Python 全量导出
再哈希，不依赖 sqlite3 内建函数：

```sh
python3 - <<'PY'
import sqlite3, json, hashlib

SID = "把这里换成真实 session id"
conn = sqlite3.connect("/home/bluecake/.pi/agent/records/traffic.db")  # 只读打开：文件本身不会被写
cur = conn.cursor()
cur.execute("SELECT id, turn, ts, payload FROM requests WHERE session_id=? ORDER BY id", (SID,))
for rid, turn, ts, payload in cur.fetchall():
    data = json.loads(payload)
    sys_field = data.get("system")
    if isinstance(sys_field, str):
        text = sys_field
    elif isinstance(sys_field, list):
        text = "".join(b.get("text", "") for b in sys_field if isinstance(b, dict))
    else:
        # OpenAI-shape fallback: first system/developer message
        msgs = data.get("messages") or []
        text = ""
        if msgs and msgs[0].get("role") in ("system", "developer"):
            c = msgs[0].get("content")
            text = c if isinstance(c, str) else "".join(
                b.get("text", "") for b in (c or []) if isinstance(b, dict)
            )
    print(rid, turn, ts, len(text), hashlib.sha256(text.encode()).hexdigest()[:16])
PY
```

（用 sha256 而不是 sqlite3 的 sha3，只是为了不依赖那个扩展函数；两者都只是「同不同」的判据，判定
标准不变：同一批请求的哈希应该相等。）

## 5. 回滚

验收过程中或验收后如果需要退回今天的逐字节行为（U6/D7 定义的回滚等价）：

```json
{ "systemPrompt": { "mode": "legacy", "wakeReplay": false } }
```

写入 `~/.pi/agent/pi-subagent.json` 后 `/reload`。此时用户轮与唤醒轮的行为与本方案上线前完全一致
（三段每轮实时拼接、唤醒轮不含三段、不写会话条目）。只关 `wakeReplay`（保留 `mode: "stable"`）会
保留快照 + 尾部更新，但唤醒轮退回只有 base（放弃 G1，保留 G2/G3，见 plan.md §3.2 回滚矩阵）。

## 6. §7.5（peer 升级检查清单）核对结果

以下是本次收尾时对 plan.md §7.5「peer 升级影响面清单」逐项复核的结果（基于当前代码，非本次新增
改动；`sysprompt-stable` M4 的范围不包含升级本身，这里只是确认之前几包留下的状态与清单一致）：

| #   | 项                                                                                                  | 状态                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | peer/devDeps/lockfile 升到 `>=0.87.0 <0.88.0` / `0.87.1`                                            | ✅ `package.json` 已是该范围                                                                                                                          |
| C2  | `pi-compat.ts` 的 `TESTED_PI_RANGE` / `isWithinTestedRange`                                         | ✅ `TESTED_PI_RANGE = "0.87.0 - 0.87.1"`，`isWithinTestedRange` 判 `minor === 87`                                                                     |
| C10 | AGENTS.md peer 依赖版本文案                                                                         | ✅ 已是 `>=0.87.0 <0.88.0`（本次 M4 未改动这句，之前的包已同步）                                                                                      |
| C5  | `ToolCall.arguments`/`ToolResultMessage.details` JSON 兼容值收紧                                    | ✅ `npx tsc --noEmit` 全绿（见下方验证命令），说明相关改动已在之前的包里完成                                                                          |
| C9  | `pi.on()` 返回 unsubscribe                                                                          | ✅（v3.1 复核结论）0.87 确实返回退订闭包；typecheck 全绿                                                                                              |
| C3  | `agent_settled` 处理器里请求的 run 被推迟                                                           | ✅ 已登记在 `pi-compat.ts` 的 `/goal` 假设注释第 4 条（"0.87 起 agent_settled 内请求的 run 被推迟到所有 settled 处理器跑完"）                         |
| C4  | `TurnEndEvent` 新增必填字段 / `SessionEntry` 并入 `context_edit`                                    | ✅ `grep` 全仓 `pi.on("turn_end"...)` 只用 `_event`，未手工构造该类型；typecheck 兜底通过                                                             |
| C6  | transcript 出现 `role:"system"` 消息                                                                | ✅ 仅 `src/sysprompt/wake-replay.ts` 主动构造这类消息（回放形态本身），其余按 role 遍历的代码未受影响（typecheck 全绿）                               |
| C7  | `SessionManager` 成为 provider 上下文唯一来源                                                       | ✅ 全仓 `agent.state.messages =` 赋值 0 处，`pi.on("context"` 0 处                                                                                    |
| C12 | provider 输入 `Context → TranscriptContext`                                                         | N/A（本仓库不注册自定义 provider，`registerProvider`/`streamSimple` 0 处）                                                                            |
| C8  | pi 自带成本感知的 prompt-cache warming                                                              | 记录留档（与 cache-ttl keepalive 的关系已知，未在本次改动范围内）                                                                                     |
| C11 | 四门禁 + 0.87.1 冒烟（spawn 前台/后台 subagent、通知唤醒、`/goal`、`/agent reload`、bash 自动后台） | ⏳ 运行期人工冒烟项，无法在静态代码审查中核验；请在合并前手动跑一遍，或确认 S1/M1/M2/M3 落地时已经跑过（这五个动作本身也是 A1/A2 验收步骤会触发到的） |
