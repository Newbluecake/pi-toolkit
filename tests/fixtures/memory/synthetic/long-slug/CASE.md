Reserved for P1's G2 tiered-render case (`long-slug`: L5 via
`bytes(minimalFrame(input)) > B` — the _soft_ L5 trigger, as opposed to
`huge-slug`'s hard trigger `bytes(I) > B`). Distinguishing property: the
TEST-SUPPLIED cwd string must be long enough that the minimal-frame text
(header + guide line + worst-case tail `Tmax` + sentinel, §2.3) blows the
byte budget `B`, while the unreducible frame `I` (header + sentinel only,
no guide/tail) still fits — so the renderer falls back to `line5`
(access-aware one-liner, §2.3 point 8) instead of `I` itself.

Files here are real inputs (unlike huge-slug, this case needs at least one
addressable file so the guide line and `Tmax` are non-empty and contribute
to `bytes(minimalFrame)`):

- `topic.md` — a single small, non-pinned topic file.

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory. P1 usage note: same ext4
255-byte path-component caveat as `huge-slug/CASE.md` — decouple the
"display" cwd/slug fed to `renderTiered` from the actual on-disk directory
name rather than trying to `mkdir` a slug that long.
