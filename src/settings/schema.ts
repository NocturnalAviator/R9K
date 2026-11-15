import { z } from "zod";
export const stickerModes = {
  relaxed: {
    budget: 10,
    windowSeconds: 60,
    maxConsecutive: 5,
    cooldownSeconds: 10,
  },
  normal: {
    budget: 5,
    windowSeconds: 60,
    maxConsecutive: 3,
    cooldownSeconds: 60,
  },
  strict: {
    budget: 3,
    windowSeconds: 120,
    maxConsecutive: 2,
    cooldownSeconds: 300,
  },
};
const stickersSchema = z
  .object({
    mode: z
      .enum(["off", "relaxed", "normal", "strict", "custom"])
      .catch("normal")
      .default("normal"),
    budget: z.number().int().positive().catch(5).default(5),
    windowSeconds: z.number().positive().catch(60).default(60),
    maxConsecutive: z.number().int().positive().catch(3).default(3),
    cooldownSeconds: z.number().nonnegative().catch(60).default(60),
  })
  .transform((s) =>
    s.mode === "off" || s.mode === "custom"
      ? s
      : { ...s, ...stickerModes[s.mode] },
  );
export const settingsSchema = z.object({
  leaderboard: z
    .object({ weekly: z.boolean().catch(false).default(false) })
    .prefault({})
    .catch({ weekly: false }),
  detectForwards: z.boolean().catch(true).default(true),
  detectMedia: z.boolean().catch(true).default(true),
  detectLinks: z.boolean().catch(false).default(false),
  detectNearText: z.boolean().catch(false).default(false),
  nearTextThreshold: z.number().min(0.5).max(0.95).catch(0.8).default(0.8),
  minFuzzyLength: z.number().int().nonnegative().catch(20).default(20),
  stickers: stickersSchema
    .prefault({})
    .catch({ mode: "normal", ...stickerModes.normal }),
  chainMode: z
    .enum(["off", "tolerate", "collapse"])
    .catch("collapse")
    .default("collapse"),
  chainWindowSeconds: z.number().positive().catch(60).default(60),
  chainMaxLength: z.number().int().min(2).catch(5).default(5),
  lowEffort: z
    .object({
      minLength: z.number().int().nonnegative().catch(0).default(0),
      emojiOnly: z.boolean().catch(false).default(false),
      allCaps: z.boolean().catch(false).default(false),
      oneWord: z.boolean().catch(false).default(false),
    })
    .prefault({})
    .catch({ minLength: 0, emojiOnly: false, allCaps: false, oneWord: false }),
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
