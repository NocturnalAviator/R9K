import { describe, expect, it } from "vitest";
import { normalize, fingerprintText } from "../src/detect/normalize.js";
import { nextStrike } from "../src/enforce/strikes.js";
import { relaxed, classic, strict, presets } from "../src/settings/presets.js";
import { parseSettings, stickerModes } from "../src/settings/schema.js";
describe("normalization", () => {
  it.each([
    ["HeLLo WORLD", "hello world"],
    ["Ｈｅｌｌｏ１２３", "hello123"],
    ["he\u200dll\u200bo", "hello"],
    ["Hi, world!!!", "hi world"],
    ["👀🔥", "👀🔥"],
    ["ПРИВЕТ Мир", "привет мир"],
    ["你好，世界", "你好世界"],
    ["cafe\u0301", "café"],
    ["looooool good", "lol good"],
    ["a\n\t b", "a b"],
    ["@alice Hi", "hi"],
    ["!!! $ +", ""],
    ["👍🏽 🇬🇧", "👍🏽 🇬🇧"],
    ["a\u2060b\ufe0fc", "abc"],
  ])("%s -> %s", (a, b) => expect(normalize(a)).toBe(b));
  it("removes mentions using original UTF-16 offsets", () =>
    expect(
      normalize("😀 @foo HI", [{ type: "mention", offset: 3, length: 4 }]),
    ).toBe("😀 hi"));
  it("does not strip a non-mention when entities were provided", () =>
    expect(normalize("a@foo", [])).toBe("afoo"));
  it("hashes normalized variants equally", () =>
    expect(fingerprintText(normalize("HEY!"))).toBe(
      fingerprintText(normalize("hey")),
    ));
});
const now = new Date("2026-01-01T00:00:00Z");
describe("strike maths", () => {
  it("relaxed ladder and growing mutes", () =>
    expect(
      [0, 1, 2, 3, 4].map((l) => nextStrike(l, now, now, relaxed, true)),
    ).toEqual([
      { action: "warn", strike: 1 },
      { action: "warn", strike: 2 },
      { action: "delete", strike: 3 },
      { action: "mute", strike: 4, muteSeconds: 60 },
      { action: "mute", strike: 5, muteSeconds: 240 },
    ]));
  it.each([classic, strict])(
    "classic/strict start at two seconds and cap",
    (s) => {
      expect(nextStrike(0, now, now, s, true).muteSeconds).toBe(2);
      expect(nextStrike(1, now, now, s, true).muteSeconds).toBe(8);
      expect(nextStrike(50, now, now, s, true).muteSeconds).toBe(604800);
    },
  );
  it("decays continuously", () => {
    expect(
      nextStrike(8, now, new Date(+now + 21600000), relaxed, true).strike,
    ).toBe(5);
    expect(
      nextStrike(8, now, new Date(+now + 10800000), relaxed, true).strike,
    ).toBe(7);
    // One second after a first strike the next offence is strike 2.
    expect(
      nextStrike(1, now, new Date(+now + 1000), relaxed, true).strike,
    ).toBe(2);
    // A single strike stops counting once it has decayed below half.
    expect(
      nextStrike(1, now, new Date(+now + 21700000), relaxed, true).strike,
    ).toBe(1);
  });
  it("degrades mute and clamps backwards time", () => {
    expect(nextStrike(4, now, now, relaxed, false)).toEqual({
      action: "delete",
      strike: 5,
    });
    expect(
      nextStrike(4, now, new Date(+now - 1000), relaxed, true).strike,
    ).toBe(5);
  });
  it("lenient settings retain valid fields and reject invalid fields", () => {
    // Schema defaults now use normal stickers, independently of the relaxed preset.
    const relaxed = {
      ...presets.relaxed,
      stickers: { mode: "normal", ...stickerModes.normal },
    };
    expect(
      parseSettings({
        warnStrikes: -1,
        memorySeconds: null,
        allowPhrases: 42,
        exemptAdmins: false,
        unknown: 3,
      }),
    ).toEqual({ ...relaxed, memorySeconds: null, exemptAdmins: false });
    expect(parseSettings(null)).toEqual(relaxed);
  });
});

it("normalization removes supplementary invisible variation selectors", () => {
  expect(normalize("h\u{e0100}i")).toBe("hi");
});
