---
source: agent
updated: 2026-09-25T13:33:48.000Z
---

# 真机验收：用 tmux 驱动独立 pi 实例（2026-09-25 跑通）

做法：`tmux new-session -d -s piacc -x 220 -y 55 -c /tmp/<scratch> "pi --model <provider/id> --thinking low --session-id <uuid>"`，
用 send.sh 往里 `send-keys -l` 文本 + Enter，轮询 `capture-pane` 直到连续 3 次（12s）不变。
cwd 放 /tmp 免污染本仓库记忆；测完按确切路径删 scratch 目录和 `~/.pi/agent/memory/-tmp-<name>/`。

坑：
- 斜杠命令第一次 Enter 会被补全菜单吃掉 ⇒ 隔 ~1s 再补一次 Enter（空编辑器 Enter 无副作用）。
- `pi-traffic-record` 录制状态在 `/reload` 后重置为关 ⇒ reload 后重新 `/record on`。
- `/compact` 小会话报 "Nothing to compact" ⇒ 先让模型 read 几个大文件（~40k）再压缩/switch_context。
- traffic.db 的 session_id = pi 的 `--session-id`；子 agent 请求记在别的 session id 下。
- Anthropic-shape 的 system 是内容块数组，比字节要先 `json_each` 拼 `text` 再 `sha3`。
- 整前缀 MISS 可能是 cache-ttl 升 1h 的入场费（payload 含 `"ttl":"1h"`），不一定是 system 变动。

已验收（2026-09-25）：sysprompt 冻结快照 + 唤醒回放、动态阈值、consult 端到端。当时发现的 P2（/agent status 显示动态线）与 P3（新增段写成 REPLACES）均已修（6e96363 / update-message.ts `absentFromHead`）。

- **子会话专属特性（保活/switch_context/bash-job settle-hold）真机验收必须用 `pi install <repo>` 或 settings packages 正规装配，禁止 `pi -e`**：子会话（session-driver.ts toCreateOptions）只按 settings packages 重新发现扩展，看不到 CLI -e ⇒ 本包在子会话里根本不加载（todo #27）。隔离 HOME/XDG 后再 install。
- flake 补充：tests/bash/manager.test.ts T10/T13（killJobTree rejection）全量高负载偶发失败，单跑稳定。
