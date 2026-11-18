/** Tool-only evidence pin set and two-phase completion publication. No replay/GC.
 * .complete-prepared is exclusive-written and file-fsynced BEFORE link publication.
 * link() never overwrites an existing final name. Both names remain as evidence;
 * precisely these two regular files must be the same inode with nlink=2.
 * A final name is not proof that parent fsync returned: retries re-sync every
 * pinned evidence/state file and required directory before reporting completion.
 */
import { linkSync } from "node:fs";
import { HeldDirectory, type CapturedFile } from "./files.js";
import { fail } from "./audit.js";
export const PREPARED_COMPLETION = ".complete-prepared";
export class PinnedEvidence {
  private names: string[];
  private files = new Map<string, { file: CapturedFile; links: number }>();
  constructor(readonly dir: HeldDirectory) {
    this.names = dir.names();
  }
  expectNames(names: string[]): void {
    if (this.names.join(",") !== [...names].sort().join(",")) fail("unknown-maintenance-evidence");
  }
  read(name: string, max: number, links = 1): CapturedFile {
    const previous = this.files.get(name);
    if (previous) {
      this.dir.verify(previous.file, previous.links);
      return previous.file;
    }
    const file = this.dir.read(name, max, links);
    this.files.set(name, { file, links });
    return file;
  }
  check(): void {
    if (this.dir.names().join(",") !== this.names.join(",")) fail("evidence-members-changed");
    for (const { file, links } of this.files.values()) this.dir.verify(file, links);
  }
  create(name: string, bytes: Buffer): void {
    this.check();
    const file = this.dir.create(name, bytes);
    this.names.push(name);
    this.names.sort();
    this.files.set(name, { file, links: 1 });
    this.check();
  }
  /** Called only after create(PREPARED_COMPLETION) completed its actual fsync.
   * Any entered link call has unknown publication effect if it throws. */
  publishCompletion(guard: () => void): void {
    guard();
    this.check();
    const before = this.files.get(PREPARED_COMPLETION)?.file;
    if (!before || !this.dir.absent("complete.json")) fail("completion-publication-conflict");
    linkSync(this.dir.at(PREPARED_COMPLETION), this.dir.at("complete.json"));
    const source = this.dir.read(PREPARED_COMPLETION, 2048, 2),
      final = this.dir.read("complete.json", 2048, 2);
    if (
      source.fingerprint.dev !== before.fingerprint.dev ||
      source.fingerprint.ino !== before.fingerprint.ino ||
      final.fingerprint.dev !== source.fingerprint.dev ||
      final.fingerprint.ino !== source.fingerprint.ino ||
      !before.bytes.equals(source.bytes) ||
      !source.bytes.equals(final.bytes)
    )
      fail("file-changed");
    this.files.set(PREPARED_COMPLETION, { file: source, links: 2 });
    this.files.set("complete.json", { file: final, links: 2 });
    this.names.push("complete.json");
    this.names.sort();
    guard();
  }
  readCompletion(): CapturedFile {
    const source = this.read(PREPARED_COMPLETION, 2048, 2),
      final = this.read("complete.json", 2048, 2);
    if (
      source.fingerprint.dev !== final.fingerprint.dev ||
      source.fingerprint.ino !== final.fingerprint.ino ||
      !source.bytes.equals(final.bytes)
    )
      fail("completion-publication-mismatch");
    return final;
  }
  proveDurable(guard: () => void): void {
    guard();
    for (const { file, links } of this.files.values()) {
      guard();
      this.dir.syncFile(file, links);
      guard();
    }
    guard();
    this.dir.sync();
    guard();
  }
}
