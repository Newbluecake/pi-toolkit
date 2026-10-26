/** Main-session tool admission only; never put this gate in shared SpawnService. */
export function reloadPendingResult() {
  const error = {
    kind: "config" as const,
    code: "E_RELOAD_PENDING" as const,
    reason: "reload_pending" as const,
    retryable: true,
    message:
      "E_RELOAD_PENDING: reload 待执行，等 reload 完成并收到继续通知后再派发 Agent / SubagentWorkflow；如需立刻派发，请让用户执行 /agent reload cancel。",
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: error.message }],
    details: { error },
  };
}
