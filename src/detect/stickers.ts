import { stickerModes, type Settings } from "../settings/schema.js";
export interface StickerState {
  tokens: number;
  updated: number;
  run: number;
  recent: Record<string, number>;
}
export function stepSticker(
  previous: StickerState | undefined,
  id: string,
  now: Date,
  settings: Settings["stickers"],
): { state: StickerState; rule?: string } {
  const s =
    settings.mode === "custom" || settings.mode === "off"
      ? settings
      : { ...settings, ...stickerModes[settings.mode] };
  const time = now.getTime();
  const tokens = Math.min(
    s.budget,
    (previous?.tokens ?? s.budget) +
      ((Math.max(0, time - (previous?.updated ?? time)) / 1000) * s.budget) /
        s.windowSeconds,
  );
  const recent = Object.fromEntries(
    Object.entries(previous?.recent ?? {}).filter(
      ([, at]) => time - at < s.cooldownSeconds * 1000,
    ),
  );
  const run = (previous?.run ?? 0) + 1;
  const rule =
    s.mode === "off"
      ? undefined
      : tokens < 1
        ? "sticker_budget"
        : run > s.maxConsecutive
          ? "sticker_run"
          : Object.hasOwn(recent, id)
            ? "sticker_cooldown"
            : undefined;
  Object.defineProperty(recent, id, {
    value: time,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return {
    state: {
      tokens: tokens >= 1 ? tokens - 1 : tokens,
      updated: time,
      run,
      recent,
    },
    rule,
  };
}
