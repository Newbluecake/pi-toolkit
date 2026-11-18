/** One-shot v1 reader ONLY in tools/tests. No imports of v1 runtime modules,
 * no initialization, proc guessing, authority retirement, repair or receipt deletion.
 * Matches O=7239dd115ac66039e2c4f80308ea5d08520aa6af clean disk layout.
 */
import { join } from "node:path";
import { HeldDirectory, exactKeys, parse, type CapturedFile } from "./files.js";
import { fail } from "./audit.js";
export const OLD_SOURCE = "7239dd115ac66039e2c4f80308ea5d08520aa6af";
const ROOT = "terminal-v1",
  WITNESS = ".terminal-initialized-v1";
const JOURNAL = "terminal-resource-fence-v1.json",
  ARCHIVE = ".terminal-authority-archive-v1";
export interface SnapshotFile {
  path: string;
  file: CapturedFile;
  directory: HeldDirectory;
}
export interface LegacySnapshot {
  kind: "fresh" | "checkpoint";
  revision?: number;
  files: SnapshotFile[];
  verify(): void;
  close(): void;
}
export function readLegacy(state: HeldDirectory): LegacySnapshot {
  const dirs: HeldDirectory[] = [],
    files: SnapshotFile[] = [];
  const absent: Array<{ dir: HeldDirectory; name: string }> = [];
  const listings: Array<{ dir: HeldDirectory; names: string[] }> = [];
  let bytes = 0;
  const hold = (path: string) => {
    const dir = new HeldDirectory(path);
    dirs.push(dir);
    return dir;
  };
  const capture = (dir: HeldDirectory, name: string, path: string, max = 2097152) => {
    const file = dir.read(name, max);
    bytes += file.bytes.length;
    if (files.length >= 512 || bytes > 16 * 1024 * 1024) fail("legacy-evidence-capacity");
    files.push({ path, file, directory: dir });
    return parse(file.bytes);
  };
  const listing = (dir: HeldDirectory) => {
    const names = dir.names();
    listings.push({ dir, names });
    return names;
  };
  const no = (dir: HeldDirectory, name: string) => {
    if (!dir.absent(name)) fail("legacy-state-not-clean");
    absent.push({ dir, name });
  };
  try {
    // Even an empty flat ledger is prior/unknown state, never fresh or auto-converted.
    no(state, JOURNAL);
    const fresh = state.absent(ROOT);
    let revision: number | undefined;
    if (fresh) {
      no(state, ROOT);
      no(state, WITNESS);
      no(state, ARCHIVE);
    } else {
      const root = hold(join(state.path, ROOT));
      if (listing(root).join(",") !== [JOURNAL, "initialized", "authority", "receipts"].sort().join(","))
        fail("unknown-v1-layout");
      const initialized = capture(root, "initialized", `${ROOT}/initialized`, 1024);
      const witness = capture(state, WITNESS, WITNESS, 1024);
      if (
        !exactKeys(initialized, ["v", "storeId"]) ||
        initialized.v !== 1 ||
        typeof initialized.storeId !== "string" ||
        !/^[A-Za-z0-9_-]{32,64}$/.test(initialized.storeId) ||
        !exactKeys(witness, ["v", "storeId"]) ||
        witness.v !== 1 ||
        witness.storeId !== initialized.storeId
      )
        fail("invalid-v1-witness");
      const journal = capture(root, JOURNAL, `${ROOT}/${JOURNAL}`);
      if (
        !exactKeys(journal, ["v", "revision", "resources"]) ||
        journal.v !== 1 ||
        !Number.isSafeInteger(journal.revision) ||
        (journal.revision as number) < 0 ||
        !Array.isArray(journal.resources)
      )
        fail("invalid-v1-journal");
      if (journal.resources.length) fail("v1-resources-not-empty");
      revision = journal.revision as number;
      for (const name of ["authority", "receipts"]) {
        if (listing(hold(join(root.path, name))).length) fail(`v1-${name}-not-empty`);
      }
      if (state.absent(ARCHIVE)) no(state, ARCHIVE);
      else {
        const archive = hold(join(state.path, ARCHIVE));
        const transactions = listing(archive);
        if (transactions.length > 64) fail("legacy-evidence-capacity");
        for (const tx of transactions) {
          if (!/^[A-Za-z0-9_-]{32,64}$/.test(tx)) fail("unknown-v1-archive");
          const directory = hold(join(archive.path, tx));
          for (const name of listing(directory)) {
            const relative = `${ARCHIVE}/${tx}/${name}`;
            if (name === "snapshots" || name === "retired") {
              const children = hold(join(directory.path, name));
              for (const child of listing(children)) {
                if (!/^[A-Za-z0-9_-]{32,64}\.json$/.test(child)) fail("unknown-v1-archive");
                capture(children, child, `${relative}/${child}`);
              }
            } else if (["manifest.json", ".pending-manifest.json", "complete.json"].includes(name))
              capture(directory, name, relative);
            else fail("unknown-v1-archive");
          }
        }
      }
    }
    return {
      kind: fresh ? "fresh" : "checkpoint",
      ...(revision === undefined ? {} : { revision }),
      files,
      verify() {
        state.check();
        for (const { dir, name } of absent) if (!dir.absent(name)) fail("legacy-state-changed");
        for (const { dir, names } of listings)
          if (dir.names().join(",") !== names.join(",")) fail("legacy-state-changed");
        for (const { directory, file } of files) directory.verify(file);
      },
      close() {
        for (const dir of dirs.reverse()) dir.close();
      },
    };
  } catch (error) {
    for (const dir of dirs.reverse()) dir.close();
    throw error;
  }
}
