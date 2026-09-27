Reserved for P1's G2 tiered-render case (`code-fence-heading`: a `## `
line INSIDE a fenced code block (` ``` … ``` `) must NOT be treated as a
section boundary by the whole-section-admission algorithm (§2.1 point 1:
"代码围栏（```）内的 `## ` 不算标题") — the fence's contents must stay
attached to whichever real `##` section precedes it, and if that section
is admitted whole, the fenced block (including its fake heading-looking
line) must appear byte-for-byte unmodified.

- `core.md` — `pin: true` primary; body has a real `## Real Section`
  heading followed by a fenced code block containing a line that itself
  starts with `## ` (looks like a heading but is inside the fence), then a
  second real `## Another Section`.

Not consumed by any P0-a test (renderTiered doesn't exist yet). Reserved
per §14.2 ownership (whole `synthetic/` tree is P0-a-owned, single writer)
so P1 only ever needs to READ this directory.
