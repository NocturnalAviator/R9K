import { z } from "zod";
export const configSchema = z.object({
  PRIVACY_URL: z
    .string()
    .url()
    .default(
      "https://github.com/NocturnalAviator/R9K/blob/main/docs/PRIVACY.md",
    ),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  ALERT_CHAT_ID: z.coerce.number().int().optional(),
  BOT_TOKEN: z.string().min(1),
  // Bot API server to talk to; set only for a self-hosted server or tests.
  TELEGRAM_API_ROOT: z.string().url().optional(),
  DATABASE_URL: z.string().url().optional(),
  PGLITE_DIR: z.string().min(1).default(".data/pglite"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});
export type Config = z.infer<typeof configSchema>;
export const readConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  configSchema.parse(env);
