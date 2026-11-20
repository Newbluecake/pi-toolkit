/** Enabled-only first-use construction, NOT migration/repair. Every partial is retained.
 * The caller owns the original hub singleton and a single terminal-only deadline.
 * Logical cancellation cannot cancel an entered syscall; it forbids all subsequent steps. */
import { constants, fstatSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { open, lstat, mkdir, rename, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { terminalV2Files } from "../../../protocol/terminal-v2-paths.js";
import type { LedgerV2, TerminalMarkerV2 } from "../../../protocol/terminal-v2.js";
import type { GuardedTerminalAllocationLedgerV2 } from "./ledger.js";
import { boundedV2 } from "./timing.js";

export const FRESH_STAGE_V2 = ".terminal-initializing-v2";
const LEGACY = [
  "terminal-v1",
  ".terminal-initialized-v1",
  "terminal-resource-fence-v1.json",
  ".terminal-authority-archive-v1",
] as const;
export class TerminalFreshUnsupportedV2 extends Error {}
type Pin = { path: string; stat: Stats; handle?: FileHandle };

/** No empty-ledger validator on the existing path: normal revision/allocations are authoritative.
 * No legacy parsing/import, and not even legacy lstat on a complete existing v2 layout. */
export async function ensureTerminalStoreV2(
  deps: { stateDir: string; ledger: GuardedTerminalAllocationLedgerV2; current(): boolean; at: number },
  signal: AbortSignal,
): Promise<void> {
  const state = resolve(deps.stateDir),
    files = terminalV2Files(state);
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const pins: Pin[] = [],
    handles: FileHandle[] = [];
  const mustStayAbsent = new Set<string>();
  const uid = process.getuid?.();
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const live = () => {
    if (controller.signal.aborted || Date.now() >= deps.at || !deps.current()) throw new Error("E_STOP");
    for (const path of mustStayAbsent) {
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error("E_STORE");
    }
    for (const pin of pins) {
      const s = lstatSync(pin.path);
      if (
        !same(s, pin.stat) ||
        s.isSymbolicLink() ||
        s.uid !== uid ||
        (s.mode & 0o777) !== (pin.stat.mode & 0o777) ||
        (pin.handle && !same(fstatSync(pin.handle.fd), s))
      )
        throw new Error("E_STORE");
      if (s.isDirectory() && realpathSync(pin.path) !== pin.path) throw new Error("E_STORE");
    }
  };
  const step = async <T>(fn: () => Promise<T>): Promise<T> => {
    live();
    try {
      return await fn();
    } finally {
      live();
    }
  };
  const absent = async (path: string) => {
    const stat = await step(async () => {
      try {
        return await lstat(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    });
    return stat === undefined;
  };
  const directory = async (path: string): Promise<Pin> => {
    const h = await step(async () => {
      const opened = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(opened);
      return opened;
    });
    const s = await step(() => h.stat());
    if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o777) !== 0o700) throw new Error("E_STORE");
    const pin = { path, stat: s, handle: h };
    pins.push(pin);
    live();
    return pin;
  };
  const write = async (dir: Pin, name: string, value: unknown) => {
    const path = `${dir.path}/${name}`;
    const h = await step(async () => {
      const opened = await open(
        `/proc/self/fd/${dir.handle!.fd}/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      handles.push(opened);
      return opened;
    });
    const s = await step(() => h.stat());
    if (!s.isFile() || s.uid !== uid || (s.mode & 0o777) !== 0o600 || s.nlink !== 1) throw new Error("E_STORE");
    pins.push({ path, stat: s, handle: h });
    await step(() => h.writeFile(JSON.stringify(value) + "\n"));
    await step(() => h.sync());
  };
  const work = (async () => {
    try {
      live();
      const parent = await directory(state);
      const stagePath = `${state}/${FRESH_STAGE_V2}`;
      const rootMissing = await absent(files.root),
        witnessMissing = await absent(files.witness);
      if (!(await absent(stagePath))) throw new Error("E_PARTIAL");
      if (rootMissing || witnessMissing) {
        if (!rootMissing || !witnessMissing || !(await absent(files.archive))) throw new Error("E_PARTIAL");
        mustStayAbsent.add(files.root);
        mustStayAbsent.add(files.archive);
        for (const name of LEGACY) {
          const path = `${state}/${name}`;
          if (!(await absent(path))) throw new TerminalFreshUnsupportedV2("legacy-unsupported");
          mustStayAbsent.add(path);
        }
        // Fixed exclusive staging is a durable no-retry witness, not a random disposable temp.
        await step(() => mkdir(`/proc/self/fd/${parent.handle!.fd}/${FRESH_STAGE_V2}`, { mode: 0o700 }));
        const stage = await directory(stagePath);
        await step(() => parent.handle!.sync());
        const marker: TerminalMarkerV2 = {
          v: 2,
          storeId: randomBytes(24).toString("base64url"),
          initialization: "fresh",
          checkpointId: randomBytes(24).toString("base64url"),
        };
        const ledger: LedgerV2 = { v: 2, storeId: marker.storeId, revision: 0, allocations: [] };
        await write(stage, "marker.json", marker);
        await write(stage, "ledger.json", ledger);
        await step(() => stage.handle!.sync());
        await write(parent, ".terminal-initialized-v2", marker);
        await step(() => parent.handle!.sync());
        // No await between this final physical/lifecycle guard and entering rename.
        live();
        await rename(
          `/proc/self/fd/${parent.handle!.fd}/${FRESH_STAGE_V2}`,
          `/proc/self/fd/${parent.handle!.fd}/terminal-v2`,
        );
        mustStayAbsent.delete(files.root);
        // Update only our path pins after an entered syscall returns. Cancellation still
        // fails live(), never authorizes parent fsync/load or first-lifecycle success.
        for (const pin of pins)
          if (pin.path === stagePath || pin.path.startsWith(`${stagePath}/`))
            pin.path = files.root + pin.path.slice(stagePath.length);
        live();
        await step(() => parent.handle!.sync());
      }
      const loaded = await step(() => deps.ledger.load(controller.signal));
      if (loaded.kind !== "loaded") throw new Error("E_STORE");
    } finally {
      // Closing owned FDs is the sole post-cancellation work. Never unlink any evidence.
      let closeFailed = false;
      for (const h of handles.reverse()) {
        for (const pin of pins) if (pin.handle === h) delete pin.handle;
        try {
          await h.close();
        } catch {
          closeFailed = true;
        }
      }
      if (closeFailed) throw new Error("E_STORE");
    }
  })();
  try {
    await boundedV2(work, deps.at, controller.signal);
    live();
  } catch (e) {
    controller.abort();
    throw e;
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
