// @vitest-environment node
import { describe, expect, it } from "vitest";
import { routeOf, routeOfDirEntry } from "../../../src/web-hub/ui/src/logic/previewWindowRoute.js";

/** web-hub-preview-windows plan r2 §3.2 (W1): the pure routing truth table. */

describe("logic/previewWindowRoute: routeOf (§3.2 truth table)", () => {
  it("ref.dir === true ⇒ dir — with or without a probe", () => {
    expect(routeOf({ path: "/p/src", dir: true })).toBe("dir");
    expect(routeOf({ path: "/p/src", dir: true }, () => "text")).toBe("dir"); // dir flag outranks kind
  });

  it("kindOf(path) === dir ⇒ dir", () => {
    expect(routeOf({ path: "/p/src" }, (p) => (p === "/p/src" ? "dir" : undefined))).toBe("dir");
  });

  it("kindOf ∈ {text,image,file,missing} ⇒ file (missing opens a window that owns the error)", () => {
    for (const kind of ["text", "image", "file", "missing"] as const) {
      expect(routeOf({ path: "/p/x" }, () => kind)).toBe("file");
    }
  });

  it("no probe fn / unprobed path ⇒ unknown", () => {
    expect(routeOf({ path: "/p/x" })).toBe("unknown");
    expect(routeOf({ path: "/p/x" }, () => undefined)).toBe("unknown");
  });
});

describe("logic/previewWindowRoute: routeOfDirEntry (§3.2)", () => {
  it("dir ⇒ dir; file ⇒ file; symlink|other ⇒ unknown", () => {
    expect(routeOfDirEntry("dir")).toBe("dir");
    expect(routeOfDirEntry("file")).toBe("file");
    expect(routeOfDirEntry("symlink")).toBe("unknown");
    expect(routeOfDirEntry("other")).toBe("unknown");
  });
});
