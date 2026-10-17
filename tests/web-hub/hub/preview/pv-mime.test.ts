/** web-hub-html-preview plan v2 §3.1 — `hub/preview/pv-mime.ts`. */
import { describe, expect, it } from "vitest";
import { PV_DEFAULT_MIME, pvContentType, pvExtOf } from "../../../../src/web-hub/hub/preview/pv-mime.js";

describe("pvContentType", () => {
  const table: [string, string][] = [
    ["index.html", "text/html; charset=utf-8"],
    ["A.HTM", "text/html; charset=utf-8"],
    ["s/app.css", "text/css; charset=utf-8"],
    ["a.js", "text/javascript; charset=utf-8"],
    ["a.mjs", "text/javascript; charset=utf-8"],
    ["a.cjs", "text/javascript; charset=utf-8"],
    ["d.json", "application/json"],
    ["a.js.map", "application/json"],
    ["m.wasm", "application/wasm"],
    ["i.svg", "image/svg+xml"],
    ["i.PNG", "image/png"],
    ["i.jpg", "image/jpeg"],
    ["i.jpeg", "image/jpeg"],
    ["i.gif", "image/gif"],
    ["i.webp", "image/webp"],
    ["i.avif", "image/avif"],
    ["i.bmp", "image/bmp"],
    ["f.ico", "image/x-icon"],
    ["f.woff", "font/woff"],
    ["f.woff2", "font/woff2"],
    ["f.ttf", "font/ttf"],
    ["f.otf", "font/otf"],
    ["t.txt", "text/plain; charset=utf-8"],
    ["t.csv", "text/plain; charset=utf-8"],
    ["t.tsv", "text/plain; charset=utf-8"],
    ["t.md", "text/plain; charset=utf-8"],
    ["t.log", "text/plain; charset=utf-8"],
    ["x.xml", "application/xml"],
    ["v.mp4", "video/mp4"],
    ["v.webm", "video/webm"],
    ["a.mp3", "audio/mpeg"],
    ["a.ogg", "audio/ogg"],
    ["a.wav", "audio/wav"],
  ];
  for (const [name, mime] of table) it(`${name} ⇒ ${mime}`, () => expect(pvContentType(name)).toBe(mime));

  it("unknown / no extension / dotfile / prototype names ⇒ octet-stream", () => {
    for (const n of ["a.exe", "Makefile", ".css", "dir.d/noext", "x.constructor", "x.__proto__", "x.toString", ""]) {
      expect(pvContentType(n), n).toBe(PV_DEFAULT_MIME);
    }
    expect(pvContentType(undefined as unknown as string)).toBe(PV_DEFAULT_MIME);
  });
  it("extension is taken from the final segment only", () => {
    expect(pvContentType("a.html/readme")).toBe(PV_DEFAULT_MIME);
    expect(pvExtOf("a.b/c.TXT")).toBe("txt");
  });
});
