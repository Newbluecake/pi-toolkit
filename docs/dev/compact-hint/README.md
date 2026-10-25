# compact-hint · 开发者要点

> 何时读：改动 `src/compact-hint/**`、`compact.*` 设置键、上下文用量提示与强制压缩逻辑之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`dynamic-threshold-plan.md`、`../context-switch/README.md`

## src/compact-hint/

`src/compact-hint/` — turn_end hook that watches context usage and nudges the model toward a
context handoff (`switch_context`, or `compact_context` when `compact.switchTool` is off) at a
configurable threshold, plus stepped usage-tick reports so the model can perceive context usage at
all. The tick grid is
non-linear (default step 10 far away, densifying to step/2 and step/5 near the force ceiling —
reminders get more frequent as the threshold approaches) and the force line is window-scaled
(`forceScaling`, default on: the configured percent is a 1M-window anchor, rising 5 points per
decade of shrinkage — 1M→88, 200k→91≈pi's own reserve line, 37k→95 — before the reserve cap
clamps it below pi's automatic line). In `switch_context` mode the force layer is 先礼后兵: it first
_demands_ a self-authored handoff (`compact.forceDemandTurns`, default 1) and only falls back to
the generic forced compaction when the model ignores it — the safety net is never removed. On top
of that, a price-aware dynamic hint line (`dynamic/` subdirectory: pure-function layer + telemetry

- the pi-facing wire; plan: `docs/dev/compact-hint/dynamic-threshold-plan.md`) is on by default
  (`compact.dynamicThreshold.mode=on`) and, whenever it is usable, fires INSTEAD OF the static
  line — 2026-09-27 decision: the static line is demoted to a fallback, used only while the
  dynamic line is unavailable (`mode` off/shadow or a `usable:false` degrade), so its own quality
  ceiling `maxQualityPercent` is no longer dead code under a lower static default; an explicitly
  disabled static line (`staticHintActive` false) still suppresses hint entirely — the dynamic
  layer never resurrects a hint the user turned off. `off` restores byte-identical pre-feature
  behavior, pinned by the golden fixture `tests/fixtures/compact-hint-golden.json` (never
  regenerate it). Its switch
  telemetry (`~/.pi/agent/telemetry/compact-switch.jsonl`, 0600, append-only, 2 MiB rotation)
  records aggregate numbers only — never any paths.
