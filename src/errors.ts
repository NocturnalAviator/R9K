import { GrammyError } from "grammy";
// Safe to log: never includes request payloads (which can carry message text).
export function errorSummary(e: unknown): string {
  if (e instanceof GrammyError)
    return `${e.method} ${e.error_code}: ${e.description}`;
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
