import { parseSettings } from "./schema.js";
export const relaxed = parseSettings({ stickers: { mode: "relaxed" } });
export const classic = parseSettings({
  detectLinks: true,
  detectNearText: true,
  chainMode: "off",
  warnStrikes: 0,
  deleteOnlyStrikes: 0,
  muteBaseSeconds: 2,
  muteMultiplier: 4,
  muteCapSeconds: 604800,
  memorySeconds: null,
});
export const strict = parseSettings({
  ...classic,
  stickers: { mode: "strict" },
  lowEffort: { minLength: 3, emojiOnly: true, allCaps: true, oneWord: false },
});
export const presets = { relaxed, classic, strict };
