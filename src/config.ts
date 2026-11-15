import { z } from "zod";
export const configSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().url().optional(),
  PGLITE_DIR: z.string().min(1).default(".data/pglite"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});
export type Config = z.infer<typeof configSchema>;
export const readConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  configSchema.parse(env);
