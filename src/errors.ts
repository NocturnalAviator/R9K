import { GrammyError } from "grammy";
// Safe to log: never includes request payloads (which can carry message text).
export function errorSummary(e: unknown): string {
  if (e instanceof GrammyError)
    return `${e.method} ${e.error_code}: ${e.description}`;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
// For alerts sent to a Telegram chat: no free-form error text at all.
export function alertSummary(e: unknown): string {
  if (e instanceof GrammyError)
    return `Telegram API error ${e.error_code} (${e.method})`;
  return e instanceof Error ? `${e.name} (see logs)` : "Operation failed";
}
