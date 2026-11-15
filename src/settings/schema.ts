import { z } from "zod";
export const settingsSchema = z.object({
  memorySeconds: z.number().positive().nullable().catch(86400).default(86400),
  warnStrikes: z.number().int().nonnegative().catch(2).default(2),
  deleteOnlyStrikes: z.number().int().nonnegative().catch(1).default(1),
  muteBaseSeconds: z.number().positive().catch(60).default(60),
  muteMultiplier: z.number().min(1).catch(4).default(4),
  muteCapSeconds: z
    .number()
    .positive()
    .max(31536000)
    .catch(86400)
    .default(86400),
  strikeHalfLifeSeconds: z.number().positive().catch(21600).default(21600),
  exemptAdmins: z.boolean().catch(true).default(true),
  allowPhrases: z.array(z.string()).catch([]).default([]),
});
export type Settings = z.infer<typeof settingsSchema>;
export function parseSettings(value: unknown): Settings {
  return settingsSchema.parse(
    value && typeof value === "object" && !Array.isArray(value) ? value : {},
  );
}
