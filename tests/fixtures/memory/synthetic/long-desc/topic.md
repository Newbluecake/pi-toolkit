---
source: agent
description: This description is deliberately much longer than the 110-byte index-line cap so the tiered renderer must clip it on a codepoint boundary and append an ellipsis rather than splitting a multi-byte character or silently truncating mid-word without any marker at all, and it keeps going well past four hundred bytes just to be safe against any margin of error in a future implementation's exact cap arithmetic, padding padding padding done
read_when: This read_when clause is deliberately much longer than the 70-byte cap so it too must be clipped on a codepoint boundary with an ellipsis appended, not truncated mid-codepoint
updated: 2026-09-01T00:04:00.000Z
---

# topic

Short body — this file exists to exercise long `description`/`read_when`
frontmatter clipping in the index line (see CASE.md), not to be inlined.
