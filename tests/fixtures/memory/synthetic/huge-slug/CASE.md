Reserved for P1's G2 tiered-render case (`huge-slug`: `bytes(I) > B`, where
`I` is the minimal-frame header + sentinel and `B` is the block byte budget).
The "huge" part comes from the TEST-SUPPLIED cwd (a very long path string
whose `toSlug()` blows the header past the budget), not from these files'
content — so the fixture files themselves can be tiny.

Not consumed by any P0-a test (renderTiered doesn't exist yet); reserved here
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer) so
P1 only ever needs to READ this directory.

P1 usage note: on ext4 a single path component is capped at 255 bytes, so a
cwd string long enough to blow a 2,400B budget can't be used as a literal
directory name — P1's test should decouple the "display" cwd/slug used to
compute `bytes(I)` from the ACTUAL on-disk directory (inject a `MemoryPaths`
whose `memoryRoot` still resolves to this fixture's materialized copy, or
render with a synthetic long `cwd` string while pointing `paths` at this
directory directly) rather than trying to `mkdir` a slug that long.
