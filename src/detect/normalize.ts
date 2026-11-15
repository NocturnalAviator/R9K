import { createHash } from "node:crypto";
export interface Entity {
  type: string;
  url?: string;
  offset: number;
  length: number;
}
export function normalize(text: string, entities?: readonly Entity[]): string {
  // Telegram offsets refer to UTF-16 in the original string, before NFKC.
  if (entities) {
    for (const e of [...entities]
      .filter((e) => e.type === "mention" || e.type === "text_mention")
      .sort((a, b) => b.offset - a.offset))
      text = text.slice(0, e.offset) + text.slice(e.offset + e.length);
  } else text = text.replace(/@\w+/g, "");
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(
      /[^\p{L}\p{N}\p{M}\s\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/gu,
      "",
    )
    .replace(/(.)\1{2,}/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}
export const fingerprintText = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
