import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { parseSettings, type Settings } from "./schema.js";
import { presetName } from "./store.js";

export const screens = [
  "main",
  "preset",
  "memory",
  "penalties",
  "detection",
  "low",
  "exempt",
  "reset",
] as const;
export type Screen = (typeof screens)[number];
type Choice = string | number | boolean | null;
interface Control {
  screen: Screen;
  key: string;
  label: string;
  choices: readonly Choice[];
}
const bool = [false, true];
export const controls: readonly Control[] = [
  {
    screen: "memory",
    key: "memorySeconds",
    label: "Memory",
    choices: [3600, 86400, 604800, 2592000, null],
  },
  {
    screen: "penalties",
    key: "warnStrikes",
    label: "Warnings",
    choices: [0, 1, 2, 3, 4, 5],
  },
  {
    screen: "penalties",
    key: "deleteOnlyStrikes",
    label: "Delete-only",
    choices: [0, 1, 2, 3, 4, 5],
  },
  {
    screen: "penalties",
    key: "muteBaseSeconds",
    label: "Mute base",
    choices: [2, 10, 60, 300, 3600],
  },
  {
    screen: "penalties",
    key: "muteMultiplier",
    label: "Multiplier",
    choices: [2, 3, 4, 10],
  },
  {
    screen: "penalties",
    key: "muteCapSeconds",
    label: "Mute cap",
    choices: [3600, 21600, 86400, 604800, 2592000],
  },
  {
    screen: "penalties",
    key: "strikeHalfLifeSeconds",
    label: "Strike half-life",
    choices: [3600, 21600, 86400, 604800],
  },
  {
    screen: "detection",
    key: "detectForwards",
    label: "Forwards",
    choices: bool,
  },
  { screen: "detection", key: "detectMedia", label: "Media", choices: bool },
  { screen: "detection", key: "detectLinks", label: "Links", choices: bool },
  {
    screen: "detection",
    key: "detectNearText",
    label: "Near text",
    choices: bool,
  },
  {
    screen: "detection",
    key: "nearTextThreshold",
    label: "Near-text threshold",
    choices: [0.6, 0.7, 0.8, 0.9],
  },
  {
    screen: "detection",
    key: "minFuzzyLength",
    label: "Minimum fuzzy length",
    choices: [10, 20, 40, 80],
  },
  {
    screen: "detection",
    key: "chainMode",
    label: "Chain mode",
    choices: ["off", "tolerate", "collapse"],
  },
  {
    screen: "detection",
    key: "chainWindowSeconds",
    label: "Chain window",
    choices: [10, 30, 60, 300],
  },
  {
    screen: "detection",
    key: "chainMaxLength",
    label: "Chain max length",
    choices: [2, 3, 5, 10, 20],
  },
  {
    screen: "detection",
    key: "stickers.mode",
    label: "Stickers",
    choices: ["off", "relaxed", "normal", "strict"],
  },
  {
    screen: "low",
    key: "lowEffort.minLength",
    label: "Minimum length",
    choices: [0, 2, 3, 5, 10],
  },
  {
    screen: "low",
    key: "lowEffort.emojiOnly",
    label: "Emoji only",
    choices: bool,
  },
  { screen: "low", key: "lowEffort.allCaps", label: "All caps", choices: bool },
  {
    screen: "low",
    key: "lowEffort.oneWord",
    label: "One-word replies",
    choices: bool,
  },
  {
    screen: "exempt",
    key: "exemptAdmins",
    label: "Exempt admins",
    choices: bool,
  },
];
export const phraseId = (phrase: string): string =>
  createHash("sha256").update(phrase).digest("hex").slice(0, 24);
export function callback(
  chatId: number,
  screen: Screen,
  op = "show",
  arg = "",
): string {
  const data = `s:${chatId}:${screen}:${op}:${arg}`;
  if (Buffer.byteLength(data) > 64)
    throw new Error("Settings callback too long");
  return data;
}
export function parseCallback(
  data: string,
): { chatId: number; screen: Screen; op: string; arg: string } | undefined {
  const m = /^s:(-\d{1,14}):([a-z]+):([a-z]+):([\w-]*)$/.exec(data);
  if (!m || Buffer.byteLength(data) > 64 || !screens.includes(m[2] as Screen))
    return;
  return {
    chatId: Number(m[1]),
    screen: m[2] as Screen,
    op: m[3]!,
    arg: m[4]!,
  };
}
function get(s: Settings, key: string): Choice {
  return key
    .split(".")
    .reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], s) as Choice;
}
export function cycle(s: Settings, index: number): Settings {
  const c = controls[index];
  if (!c) return s;
  const next =
    c.choices[(c.choices.indexOf(get(s, c.key)) + 1) % c.choices.length];
  const [root, child] = c.key.split(".");
  const updated = child
    ? {
        ...s,
        [root!]: { ...(s[root as keyof Settings] as object), [child]: next },
      }
    : { ...s, [root!]: next };
  // Sticker presets expand their numbers via the schema transform.
  return parseSettings(updated);
}
export function duration(seconds: number | null): string {
  if (seconds === null) return "forever";
  for (const [size, unit] of [
    [86400, "d"],
    [3600, "h"],
    [60, "min"],
  ] as const)
    if (seconds >= size && seconds % size === 0)
      return `${seconds / size} ${unit}`;
  return `${seconds} s`;
}
function display(c: Control, s: Settings): string {
  const v = get(s, c.key);
  return typeof v === "boolean"
    ? v
      ? "On"
      : "Off"
    : c.key.endsWith("Seconds")
      ? duration(v as number | null)
      : String(v);
}
export function ladder(s: Settings): string {
  const steps = [
    ...Array.from({ length: Math.min(s.warnStrikes, 5) }, () => "warn"),
    ...Array.from({ length: Math.min(s.deleteOnlyStrikes, 5) }, () => "delete"),
    ...[0, 1, 2].map(
      (n) =>
        `mute ${duration(Math.min(s.muteCapSeconds, s.muteBaseSeconds * s.muteMultiplier ** n))}`,
    ),
  ];
  return steps.join(", ") + ` … up to ${duration(s.muteCapSeconds)}`;
}
const labels: Record<Screen, string> = {
  main: "Settings",
  preset: "Preset",
  memory: "Memory",
  penalties: "Penalties",
  detection: "Detection",
  low: "Low-effort filters",
  exempt: "Exemptions",
  reset: "Reset strikes",
};
export function renderMenu(
  chatId: number,
  title: string,
  s: Settings,
  screen: Screen,
  arg = "",
  confirm = false,
): { text: string; reply_markup: InlineKeyboard } {
  const kb = new InlineKeyboard();
  const add = (label: string, target: Screen, op = "show", value = "") => {
    kb.text(label, callback(chatId, target, op, value)).row();
  };
  let text = `${title}\n${labels[screen]}\n`;
  if (screen === "main") {
    text += `Preset: ${presetName(s)}\nMemory ${duration(s.memorySeconds)}; ${s.warnStrikes} warnings, ${s.deleteOnlyStrikes} delete-only; mute ${duration(s.muteBaseSeconds)} × ${s.muteMultiplier}.`;
    for (const name of screens.filter((v) => v !== "main"))
      add(labels[name], name);
  } else if (screen === "preset") {
    text +=
      "Relaxed — warnings first, 24 h memory.\nClassic — immediate mutes, forever memory.\nStrict — Classic with low-effort filters and stricter stickers.";
    if (confirm) {
      text += `\nApply ${arg}? All settings except allow-phrases will be replaced.`;
      add("Confirm preset", "preset", "apply", arg);
    } else
      for (const name of ["relaxed", "classic", "strict"])
        add(name[0]!.toUpperCase() + name.slice(1), "preset", "confirm", name);
  } else if (screen === "reset") {
    text += confirm
      ? "Clear all strikes in this chat?"
      : "Clear strike levels for every user in this chat.";
    add(
      confirm ? "Confirm reset" : "Reset strikes",
      "reset",
      confirm ? "clear" : "confirm",
    );
  } else {
    if (screen === "memory")
      text += "Text is kept at most 90 days regardless. Tap to cycle.";
    if (screen === "penalties") text += ladder(s) + "\nTap to cycle values.";
    controls.forEach((c, i) => {
      if (c.screen === screen)
        add(`${c.label}: ${display(c, s)} ↻`, screen, "cycle", String(i));
    });
    if (screen === "exempt") {
      const page = Math.max(
        0,
        Math.min(
          Math.floor(Number(arg) || 0),
          Math.max(0, Math.ceil(s.allowPhrases.length / 5) - 1),
        ),
      );
      text += `Allow-phrases (${s.allowPhrases.length}/50), page ${page + 1}:\n`;
      s.allowPhrases.slice(page * 5, page * 5 + 5).forEach((p, i) => {
        text += `${page * 5 + i + 1}. ${p}\n`;
        add(`Remove ${page * 5 + i + 1}`, "exempt", "remove", phraseId(p));
      });
      if (page > 0) add("Previous phrases", "exempt", "show", String(page - 1));
      if ((page + 1) * 5 < s.allowPhrases.length)
        add("Next phrases", "exempt", "show", String(page + 1));
      add("Add phrase", "exempt", "add");
    }
  }
  add("Back", "main");
  return { text, reply_markup: kb };
}
