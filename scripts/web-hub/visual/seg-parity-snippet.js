/**
 * chunked-plan §6.5 / §10 item 7 — source-view segmented-render parity, DevTools Console edition.
 *
 * Paste this whole file into the Console of a loaded pi web-hub page (Edge/Win10, Firefox,
 * Chromium — any engine; the point is real layout). For every corpus case it renders the text
 * once in a single `<pre class="preview-text-body">` (A) and once as the chunked-preview
 * segments (`<div class="preview-seg">` blocks inside a `<div class="preview-text-body">`, B),
 * at the same width and `height:auto`, then prints one PASS/FAIL row per case: scrollHeight
 * difference <= 1px, equal line counts, equal client-rect row counts. Any FAIL ⇒ the cut rule
 * (§4.3.4) and the browser disagree.
 *
 * Self-contained: the CASES literal holds the corpus texts plus the segments the REAL
 * `createSourceSegmenter` produced for them (fed in `chunk`-sized pieces, then `flush("eof")`);
 * `tests/web-hub/ui/checks-body.test.ts` fails if it drifts from the live segmenter.
 * `scripts/web-hub/visual/checks-body.ts` (`preview-seg-render-parity`) runs the same
 * measurement automatically in headless Chromium — keep the two measurement bodies in sync.
 */
const CASES = [
  {
    name: "blank-line",
    text: "a\n\nb",
    chunk: 2,
    segs: [
      { text: "a", sep: "\n" },
      { text: "\nb", sep: "" },
    ],
  },
  {
    name: "two-blank-lines",
    text: "a\n\n\nb",
    chunk: 3,
    segs: [
      { text: "a", sep: "\n" },
      { text: "\n\nb", sep: "" },
    ],
  },
  {
    name: "leading-blank-lines",
    text: "\n\nb\nc",
    chunk: 2,
    segs: [
      { text: "\n\nb", sep: "\n" },
      { text: "c", sep: "" },
    ],
  },
  {
    name: "crlf-blank-line",
    text: "a\r\n\r\nb",
    chunk: 6,
    segs: [
      { text: "a\r", sep: "\n" },
      { text: "\r\nb", sep: "" },
    ],
  },
  {
    name: "eof-single-newline",
    text: "a\nb\n",
    chunk: 2,
    segs: [
      { text: "a", sep: "\n" },
      { text: "b", sep: "\n" },
    ],
  },
  {
    name: "eof-only-newlines",
    text: "x\n\n\n",
    chunk: 2,
    segs: [
      { text: "x", sep: "\n" },
      { text: "\n\n", sep: "" },
    ],
  },
  {
    name: "many-boundaries",
    text: "l1\n\nl2\n\n\nl3\n\n\n\nl4\nl5\n",
    chunk: 4,
    segs: [
      { text: "l1", sep: "\n" },
      { text: "\nl2", sep: "\n" },
      { text: "\n\nl3", sep: "\n" },
      { text: "\n\n\nl4", sep: "\n" },
      { text: "l5", sep: "\n" },
    ],
  },
  {
    name: "wrapping-lines",
    text: "short\n\nwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww tail\n\n\nend\n\n",
    chunk: 5,
    segs: [
      { text: "short", sep: "\n" },
      {
        text: "\nwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww tail",
        sep: "\n",
      },
      { text: "\n\nend", sep: "\n" },
      { text: "\n", sep: "" },
    ],
  },
  {
    name: "crlf-many-blank-lines",
    text: "a\r\n\r\n\r\nb\r\n\r\nc\r\n",
    chunk: 5,
    segs: [
      { text: "a\r", sep: "\n" },
      { text: "\r\n\r\nb\r", sep: "\n" },
      { text: "\r\nc\r", sep: "\n" },
    ],
  },
  {
    name: "mixed-lf-crlf",
    text: "x\n\r\ny\r\n\nz\r\n\r\n",
    chunk: 4,
    segs: [
      { text: "x", sep: "\n" },
      { text: "\r\ny\r", sep: "\n" },
      { text: "\nz\r", sep: "\n" },
      { text: "\r\n", sep: "" },
    ],
  },
];

(function () {
  const host = document.createElement("div");
  host.style.position = "absolute";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "480px";
  document.body.appendChild(host);
  const mk = (tag) => {
    const el = document.createElement(tag);
    el.className = "preview-text-body";
    el.style.width = "480px";
    el.style.height = "auto";
    el.style.overflow = "visible";
    el.style.flex = "none";
    el.style.minHeight = "0";
    host.appendChild(el);
    return el;
  };
  // text-line rows: the set of distinct line tops (relative to the container) of its TEXT nodes
  const rectRows = (el) => {
    const base = el.getBoundingClientRect().top;
    const tops = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.height > 0) tops.add(Math.round(r.top - base));
    }
    return tops.size;
  };
  const rows = [];
  for (const c of CASES) {
    const a = mk("pre");
    a.textContent = c.text;
    const b = mk("div");
    for (const s of c.segs) {
      const d = document.createElement("div");
      d.className = "preview-seg";
      d.textContent = s.text;
      b.appendChild(d);
    }
    const cs = getComputedStyle(a);
    const lh = parseFloat(cs.lineHeight);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const lines = (el) => Math.round((el.scrollHeight - pad) / lh);
    const row = {
      case: c.name,
      hA: a.scrollHeight,
      hB: b.scrollHeight,
      linesA: lines(a),
      linesB: lines(b),
      rectsA: rectRows(a),
      rectsB: rectRows(b),
    };
    row.result =
      Math.abs(row.hA - row.hB) <= 1 && row.linesA === row.linesB && row.rectsA === row.rectsB ? "PASS" : "FAIL";
    rows.push(row);
  }
  host.remove();
  console.table(rows);
  console.log(rows.every((r) => r.result === "PASS") ? "seg-parity: ALL PASS" : "seg-parity: FAILURES");
  return rows;
})();
