export interface ControlAudit {
  audit: "control";
  phase: string;
  reqId?: string;
  id?: string;
  op?: string;
  ok: boolean;
  code?: string | null;
}
export function auditControl(log: { info(msg: string, data?: object): void }, record: ControlAudit): void {
  log.info("control", record);
}
export function auditAdmin(log: { info(msg: string, data?: object): void }, record: Record<string, unknown>): void {
  log.info("admin", record);
}
