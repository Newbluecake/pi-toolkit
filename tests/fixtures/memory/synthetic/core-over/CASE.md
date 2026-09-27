Reserved for P1's G2 tiered-render case (`core-over`: primary core is big
enough to force whole-section admission at a "normal" budget (L2), and
big enough that at a smaller test-supplied budget it can't even keep its
preamble + omission line ⇒ it is demoted out of the block entirely and
appears in the index with `⚠ over core budget` (L4), sorted first among
index entries per §2.2's sort rule ("未内联的 primary（带 ⚠）→ …").

- `core.md` — `pin: true`, several `## ` sections each individually large
  (~800B+ of prose), so no single reasonable-sized budget admits the whole
  file, and a small enough budget can't even admit one section plus the
  omission-line overhead.

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory.
