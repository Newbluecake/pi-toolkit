# session-nav · 开发者要点

> 何时读：改动 `src/session-nav/**`、`sessionNav.*` 设置键、`/resume-recent`、web resume 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`

## src/session-nav/

`src/session-nav/` — merged session-nav: `/resume-recent` (48h window, `--all` for full history),
`/clear`, bare `exit` interception, a pre-submit rewriting editor, and resume-list title
cleaning (skill envelopes). **web-resume plan §2.1/§2.3 (D1 彻底隐藏)**: subagent sessions are
dropped entirely from every resume list — partial progress included — no flag, no toggle, no
hidden-count line; the `[sub:type]` retitle path is deleted. A session is sub ⇔ its head carries
the line-2 `subagent:child` self-marker (v0.4.0+, checked per displayed row) **or** its path is in
the provenance index — the union of every `subagent:run.diag.sessionFile` mark ever scanned in
the whole session dir (not just the 48 h window), advanced by a budgeted incremental backfill
(≤2 s/≤64 MiB per call, round-robin 8 MiB chunks, append-only ⇒ stale cache is a valid lower
bound) under cache v2 `<agent>/cache/session-nav/provenance-v2/<sha256(dir)>.json` (one file per
session dir, 0600 atomic, 16 MiB cap; the v1 `subagent-marks.json` is simply ignored). Capacity:
20 000 tracked files / 2 048 marks per entry / 512 KiB per entry over ⇒ `capacity`, self-marked
children still hidden. Disclosed residuals: a pre-v0.4.0 child whose parent file was deleted is
undetectable; on a huge dir the first few opens may still show a pre-v0.4.0 child until the
backfill completes once. List pipeline: temp-dir symlink + real pi `SessionManager.list` with a
wrapped progress that maps temp→real paths before dropping sub rows (pi 1.2 partials carry
temp-dir paths). Post-guard, TUI-only. Design: `docs/dev/web-resume/plan.md`.
