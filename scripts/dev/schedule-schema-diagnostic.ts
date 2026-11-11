#!/usr/bin/env -S node --import tsx
/**
 * Purely offline #83 diagnostic. Usage:
 *   node --import tsx scripts/dev/schedule-schema-diagnostic.ts < synthetic.json
 * No path arguments. The only data source is explicit stdin JSON; no automatic file,
 * config, registry, SDK, session, traffic, ledger or network access. See the pure API
 * for the observations/compare envelope and limits. All provenance is self-reported.
 */
import {
  inspectScheduleSchemaShape,
  scheduleDiagnosticFailure,
  SCHEDULE_SCHEMA_LIMITS,
  type DiagnosticResult,
} from "../../src/tools/schedule-schema-shape.js";

function emit(result: DiagnosticResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) {
    process.stderr.write("schedule-schema-diagnostic: failed\n");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    emit(scheduleDiagnosticFailure("E_ARGUMENTS"));
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.byteLength;
      if (bytes > SCHEDULE_SCHEMA_LIMITS.inputBytes) {
        emit(scheduleDiagnosticFailure("E_INPUT_BYTES"));
        return;
      }
      chunks.push(buffer);
    }
  } catch {
    emit(scheduleDiagnosticFailure("E_STDIN"));
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    emit(scheduleDiagnosticFailure("E_JSON"));
    return;
  }
  emit(inspectScheduleSchemaShape(input));
}

void main().catch(() => emit(scheduleDiagnosticFailure("E_INPUT_DATA")));
