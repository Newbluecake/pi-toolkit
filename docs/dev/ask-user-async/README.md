# ask_user · 开发者要点

> 何时读：改动 `src/ask-user/**` 或 `askUser.*` 设置键之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`./`（本目录其它文档）、`../ask-user-feishu-merge/`

## src/ask-user/

`src/ask-user/` — merged interactive `ask_user` tool and TUI/RPC question components; emits `ask-user:activity` while an active TUI component receives input. `normalize.ts` repairs presentation-layer input instead of failing the call: explicit headers are always trimmed/width-capped (a blank one is dropped so the RPC answer key falls back to the question text), and missing headers are derived + de-duplicated in multi-question calls **only** (a single question never gets one invented, so its answer key stays the question text). Headers the model duplicated verbatim are still rejected — they collide as RPC answer keys. `remote.ts`'s `AskUserRemotePort` (P2, #32) is a late-bound, optional web-hub port: when `webHub.remoteAskUser` is on and a browser is connected, `wireAskUser` races the TUI component against the remote answer for the same dialog (whichever settles first wins; the loser gets cancelled/closed) — `remote()` returning `undefined` (web-hub off or disconnected) reproduces pre-P2 behavior byte-for-byte.
