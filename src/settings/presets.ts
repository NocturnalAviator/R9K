import { parseSettings } from "./schema.js";
export const relaxed = parseSettings({});
export const classic = parseSettings({
  warnStrikes: 0,
  deleteOnlyStrikes: 0,
  muteBaseSeconds: 2,
  muteMultiplier: 4,
  muteCapSeconds: 604800,
  memorySeconds: null,
});
export const strict = { ...classic };
export const presets = { relaxed, classic, strict };
