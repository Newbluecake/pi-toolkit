Reserved for P1's G2 tiered-render case (`cjk-emoji`: codepoint-safe index
clipping and byte-accounting must hold when the description/body mix CJK
(3-byte UTF-8 codepoints) and emoji (4-byte, some via surrogate pairs / ZWJ
sequences) — the property tests in §2.3 explicitly range over "CJK/emoji"
inputs, and clipping must never split a codepoint or a combined emoji
sequence mid-way.

- `topic.md` — `description` mixes 中文 and emoji (📌🚀✅) and is long enough
  (well past 110B in UTF-8, but comparatively few codepoints) to force
  clipping; body is short CJK + emoji prose.

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory.
