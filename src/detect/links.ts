import type { Entity } from "./normalize.js";
const tracking =
  /^(utm_.*|fbclid|gclid|igshid|si|ref|ref_src|mc_cid|mc_eid|yclid|msclkid)$/i;
export function canonicalizeUrl(value: string): string | null {
  try {
    const u = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(value)
        ? value
        : `https://${value.replace(/^\/\//, "")}`,
    );
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hostname = u.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "")
      .replace(/^(m|mobile)\./, "");
    if (u.hostname === "old.reddit.com") u.hostname = "reddit.com";
    if (u.hostname === "twitter.com") u.hostname = "x.com";
    u.protocol = "https:";
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (tracking.test(key)) u.searchParams.delete(key);
    let video: string | null = null;
    if (u.hostname === "youtu.be") video = u.pathname.split("/")[1] ?? null;
    if (u.hostname === "youtube.com")
      video = u.pathname.startsWith("/shorts/")
        ? (u.pathname.split("/")[2] ?? null)
        : u.pathname === "/watch"
          ? u.searchParams.get("v")
          : null;
    if (video) {
      u.hostname = "youtube.com";
      u.pathname = "/watch";
      u.search = "";
      u.searchParams.set("v", video);
    }
    const entries = [...u.searchParams.entries()].sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    );
    u.search = "";
    for (const [key, val] of entries) u.searchParams.append(key, val);
    return `${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}
export function extractLinks(
  text: string,
  entities: readonly Entity[] = [],
): { urls: string[]; withoutLinks: string } {
  const urls = new Set<string>();
  // Remove mentions at the same time: offsets still refer to the original UTF-16 text.
  let withoutLinks = text;
  for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
    if (e.type === "url" || e.type === "text_link") {
      const url = canonicalizeUrl(
        e.url ?? text.slice(e.offset, e.offset + e.length),
      );
      if (!url) continue;
      urls.add(url);
    } else if (e.type !== "mention" && e.type !== "text_mention") continue;
    withoutLinks =
      withoutLinks.slice(0, e.offset) +
      " ".repeat(e.length) +
      withoutLinks.slice(e.offset + e.length);
  }
  return { urls: [...urls].sort(), withoutLinks };
}
