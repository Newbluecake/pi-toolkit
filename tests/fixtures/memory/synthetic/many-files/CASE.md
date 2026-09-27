Reserved for P1's G2 tiered-render case (`many-files`: L1 — the index
cannot list every file as a full line within budget `B`, so the tail
degrades to a compact name list (`- also: a.md, b.md (+N more)`); under a
smaller test-supplied `B` it degrades further to a bare overflow line
(`- … +N more`), per §2.3 step 5.

12 tiny, non-pinned topic files (`topic-01.md` … `topic-12.md`), each with
a short but non-trivial `description` line in its body so a _full_ index
line for each is nontrivially wide — enough files that at the plan's
default budgets (`blockBytes` ~2.4KB, `indexMax`) not all of them fit as
full lines, forcing the compact-list / overflow-line degradation this case
is meant to exercise. Content is otherwise irrelevant (topic bodies are
never inlined, §2.1).

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory.
