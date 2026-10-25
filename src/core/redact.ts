/**
 * Redact obvious secrets (bearer tokens, api-key query params, and any literal
 * secret values passed in) from an error/log message before it can surface anywhere.
 * Zero imports: pi-free, shared by web-search, quota and cache-ttl.
 */
export function redactSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message
    .replace(/([?&](?:api_key|apikey|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
