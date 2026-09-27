Reserved for P1's G2 tiered-render case (`long-desc`: codepoint-safe index
truncation — §2.2's per-index-line 200B cap, and description ≤110B / read_when
≤70B caps, must clip on a UTF-8 codepoint boundary and append `…`, never split
a multi-byte codepoint).

- `topic.md` — `description` and `read_when` frontmatter values are each
  deliberately longer (400B / 200B, ASCII) than their respective caps, per
  §2.3's property-test range (`description 0–400B`). Body is short (never
  inlined, since this file isn't pinned).

Not consumed by any P0-a test (renderTiered doesn't exist yet; frontmatter
`description`/`read_when` aren't read by the legacy renderer at all — legacy
only reads `pin`/`source`, §2.1 vs §3.1). Reserved per §14.2 ownership
(whole `synthetic/` tree is P0-a-owned, single writer) so P1 only ever needs
to READ this directory.
