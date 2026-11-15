import type { Settings } from "../settings/schema.js";
export function lowEffortRule(
  text: string,
  normalized: string,
  reply: boolean,
  s: Settings["lowEffort"],
): string | undefined {
  if (s.minLength > 0 && [...normalized].length < s.minLength)
    return "min_length";
  if (
    s.emojiOnly &&
    !/[\p{L}\p{N}]/u.test(normalized) &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u.test(
      normalized,
    )
  )
    return "emoji_only";
  const letters = text.match(/\p{L}/gu) ?? [];
  const cased = letters.filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (
    s.allCaps &&
    letters.length >= 8 &&
    cased.length > 0 &&
    cased.every((c) => c === c.toUpperCase())
  )
    return "all_caps";
  if (s.oneWord && reply && /^[\p{L}\p{N}\p{M}]+$/u.test(normalized))
    return "one_word";
  return undefined;
}
