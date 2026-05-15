/**
 * Vidplay / VidCloud / Megacloud provider extractor.
 *
 * Reverse-engineered pipeline:
 * 1. Fetch embed page → extract encrypted sources path + server ID
 * 2. Fetch /futoken → get k[] key pairs
 * 3. Build token string using keys + server ID
 * 4. GET /mediainfo/{encodedId}?{token} → AES-encrypted JSON
 * 5. Decrypt with VRF key → parse sources array
 * 6. Return first m3u8
 */
import axios from "axios";
import * as cheerio from "cheerio";
import CryptoJS from "crypto-js";
import { logger } from "../../logger.js";
import type { StreamSource, Subtitle, SkipTime } from "../types.js";

const VIDPLAY_HOSTS = [
  "vidplay.online",
  "vidplay.lol",
  "vidcloud.lol",
  "mcloud.bz",
];

const MEGACLOUD_HOSTS = ["megacloud.tv", "rapid-cloud.co", "rabbitstream.net"];

/**
 * Keys used to RC4-decode the mediainfo ID.
 * These rotate periodically. We attempt to fetch the latest from
 * consumet's public key repo first, then fall back to hardcoded.
 */
const FALLBACK_KEYS = [
  [8, 0],
  [6, 2],
  [1, 5],
];

async function fetchVidplayKeys(): Promise<number[][]> {
  try {
    const resp = await axios.get(
      "https://raw.githubusercontent.com/consumet/consumet.ts/master/src/extractors/vidplay.ts",
      { timeout: 5000 }
    );
    const text = resp.data as string;
    const match = text.match(/const\s+keys\s*=\s*(\[\[.*?\]\])/s);
    if (match) {
      const parsed = JSON.parse(match[1]) as number[][];
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.debug({ count: parsed.length }, "vidplay keys fetched from repo");
        return parsed;
      }
    }
  } catch {
    logger.warn("could not fetch live vidplay keys, using fallback");
  }
  return FALLBACK_KEYS;
}

function vrfEncrypt(id: string, keys: number[][]): string {
  let result = id;
  for (const [key] of keys) {
    const wordArray = CryptoJS.enc.Utf8.parse(result);
    const encrypted = CryptoJS.RC4.encrypt(wordArray, CryptoJS.enc.Utf8.parse(String(key)));
    result = encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  }
  return encodeURIComponent(result.replace(/\//g, "_").replace(/\+/g, "-"));
}

function buildFutoken(keys: number[][], id: string): string {
  const parts: string[] = [`k=${keys.map((k) => k[0]).join(",")}`];
  for (let i = 0; i < keys.length; i++) {
    const [start, offset] = keys[i]!;
    const slice = id.slice(start, start + offset) || String(start);
    parts.push(slice);
  }
  return parts.join(",");
}

function aesDecrypt(ciphertext: string, key: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export async function extractVidplay(
  embedUrl: string
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;

  logger.info({ embedUrl, host }, "[Stage 1] fetching embed page");

  let embedHtml: string;
  try {
    const resp = await axios.get(embedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,*/*;q=0.8",
        Referer: "https://aniwaves.ru/",
      },
    });
    embedHtml = resp.data as string;
    logger.debug(
      { status: resp.status, snippet: embedHtml.slice(0, 300) },
      "[Stage 1] embed page fetched"
    );
  } catch (err) {
    const e = err as Error;
    logger.error({ embedUrl, error: e.message }, "[Stage 1] embed page fetch failed");
    return null;
  }

  const $ = cheerio.load(embedHtml);

  // Extract the encrypted source path and ID from the page
  // Pattern: getSources({id: "...", type: "..."}), or window.sources = ...
  let rawId: string | null = null;
  let sourcesPath: string | null = null;

  const scriptContent = $("script:not([src])")
    .map((_, el) => $(el).html() ?? "")
    .get()
    .join("\n");

  // Try multiple patterns
  const idPatterns = [
    /getSources\s*\(\s*\{[^}]*id\s*:\s*['"]([^'"]+)['"]/,
    /var\s+id\s*=\s*['"]([^'"]+)['"]/,
    /["']id["']\s*:\s*["']([^'"]+)["']/,
    /\.getSources\s*\(\s*['"]([^'"]+)['"]/,
  ];

  for (const pat of idPatterns) {
    const m = scriptContent.match(pat);
    if (m) {
      rawId = m[1] ?? null;
      break;
    }
  }

  // Try getting sources URL
  const pathPatterns = [
    /getSources\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)['"]/,
    /sourcesUrl\s*=\s*['"]([^'"]+)['"]/,
    /["']sources["']\s*:\s*["']([^'"]+)["']/,
  ];
  for (const pat of pathPatterns) {
    const m = scriptContent.match(pat);
    if (m) {
      sourcesPath = m[1] ?? null;
      break;
    }
  }

  // Fallback: extract ID from URL path
  if (!rawId) {
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    rawId = pathParts[pathParts.length - 1] ?? null;
  }

  logger.debug({ rawId, sourcesPath }, "[Stage 1] extracted embed metadata");

  if (!rawId) {
    logger.error({ embedUrl }, "[Stage 1] FAILED — could not extract source ID from embed page");
    return null;
  }

  // ── Stage 2: fetch futoken / keys ────────────────────────────────────────
  logger.info({ host }, "[Stage 2] fetching futoken keys");

  const keys = await fetchVidplayKeys();

  const token = buildFutoken(keys, rawId);
  const encodedId = vrfEncrypt(rawId, keys);

  logger.debug(
    { token: token.slice(0, 60), encodedId: encodedId.slice(0, 40) },
    "[Stage 2] token generated"
  );

  // ── Stage 3: call sources / mediainfo endpoint ────────────────────────────
  const mediaInfoUrl = sourcesPath
    ? `https://${host}${sourcesPath}`
    : `https://${host}/mediainfo/${encodedId}`;

  const mediaInfoParams: Record<string, string> = { t: token };

  // Some vidplay variants use ?v= timestamp
  if (urlObj.searchParams.get("t")) {
    mediaInfoParams["autoplay"] = "1";
  }

  logger.info(
    { mediaInfoUrl, params: mediaInfoParams },
    "[Stage 3] requesting source API"
  );

  let rawBody: string;
  try {
    const resp = await axios.get(mediaInfoUrl, {
      params: mediaInfoParams,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15000,
    });
    rawBody = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    logger.debug(
      { status: resp.status, snippet: rawBody.slice(0, 300) },
      "[Stage 3] source API response"
    );
  } catch (err) {
    const e = err as Error & { response?: { status: number; data: unknown } };
    logger.error(
      {
        mediaInfoUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200),
      },
      "[Stage 3] FAILED — source API request failed"
    );
    return null;
  }

  // ── Stage 4: parse response ────────────────────────────────────────────────
  logger.info("[Stage 4] parsing source API response");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    logger.warn({ snippet: rawBody.slice(0, 100) }, "[Stage 4] response is not JSON, may be encrypted");
    // treat as encrypted string
    parsed = { encrypted: true, sources: rawBody };
  }

  logger.debug(
    { keys: Object.keys(parsed), encrypted: parsed["encrypted"] },
    "[Stage 4] raw response structure"
  );

  // ── Stage 5: decrypt if needed ────────────────────────────────────────────
  logger.info("[Stage 5] decryption stage");

  let sourcesData: unknown = parsed["sources"];
  const isEncrypted =
    parsed["encrypted"] === true || typeof parsed["sources"] === "string";

  if (isEncrypted && typeof sourcesData === "string") {
    logger.debug({ encrypted: true }, "[Stage 5] sources appear AES-encrypted");

    // Try known decryption keys (sourced from active extractors)
    const decryptionKeys = [
      "9Y6I6HiQOqjDUlbAEWtFhg==",
      "WXrUARXb1aDLaZjI",
      "4wZuP5YkT1a4wZuP",
      "LXgbdW5rQ3VzdG9t",
    ];

    let decrypted: string | null = null;
    for (const dkey of decryptionKeys) {
      try {
        const result = aesDecrypt(sourcesData, dkey);
        if (result && result.startsWith("[")) {
          decrypted = result;
          logger.debug({ key: dkey }, "[Stage 5] AES decryption succeeded");
          break;
        }
      } catch {
        // try next key
      }
    }

    if (!decrypted) {
      // Attempt without padding / base64 variations
      try {
        const keyBytes = CryptoJS.MD5(rawId).toString();
        const result = aesDecrypt(sourcesData, keyBytes);
        if (result && result.length > 5) {
          decrypted = result;
          logger.debug({ key: "MD5(rawId)" }, "[Stage 5] AES decryption succeeded with MD5 key");
        }
      } catch {
        // ignore
      }
    }

    if (!decrypted) {
      logger.error("[Stage 5] FAILED — all decryption attempts failed for encrypted sources");
      return null;
    }

    try {
      sourcesData = JSON.parse(decrypted);
    } catch {
      logger.error({ snippet: decrypted.slice(0, 100) }, "[Stage 5] FAILED — decrypted payload is not valid JSON");
      return null;
    }
  } else {
    logger.debug("[Stage 5] sources not encrypted, skipping decryption");
  }

  // ── Stage 6: parse source list ────────────────────────────────────────────
  logger.info("[Stage 6] parsing source list");

  const sourcesArr = Array.isArray(sourcesData)
    ? sourcesData
    : Array.isArray(parsed["sources"])
      ? (parsed["sources"] as unknown[])
      : [];

  logger.debug(
    { count: sourcesArr.length, first: JSON.stringify(sourcesArr[0] ?? {}).slice(0, 150) },
    "[Stage 6] source array"
  );

  if (sourcesArr.length === 0) {
    logger.error("[Stage 6] FAILED — source array is empty after parsing");
    return null;
  }

  const subtitlesRaw = (parsed["tracks"] ?? parsed["subtitles"] ?? []) as Array<{
    file?: string;
    src?: string;
    label?: string;
    kind?: string;
  }>;

  const subtitles: Subtitle[] = subtitlesRaw
    .filter((t) => t.kind !== "thumbnails")
    .map((t) => ({
      lang: (t.label ?? "").toLowerCase().split(" ").join("-"),
      label: t.label ?? "Unknown",
      url: t.file ?? t.src ?? "",
    }))
    .filter((s) => s.url);

  const thumbnailTrack = subtitlesRaw.find((t) => t.kind === "thumbnails");
  const thumbnails = thumbnailTrack
    ? (thumbnailTrack.file ?? thumbnailTrack.src ?? null)
    : null;

  const intro = (parsed["intro"] as SkipTime) ?? null;
  const outro = (parsed["outro"] as SkipTime) ?? null;

  // ── Stage 7: pick best m3u8 ────────────────────────────────────────────────
  logger.info("[Stage 7] selecting final m3u8");

  interface SourceEntry {
    file?: string;
    url?: string;
    src?: string;
    type?: string;
    quality?: string;
  }

  const m3u8Source = (sourcesArr as SourceEntry[]).find(
    (s) =>
      (s.file ?? s.url ?? s.src ?? "")
        .toLowerCase()
        .includes(".m3u8")
  );
  const anySource = (sourcesArr as SourceEntry[])[0];

  const m3u8 =
    m3u8Source?.file ?? m3u8Source?.url ?? m3u8Source?.src ??
    anySource?.file ?? anySource?.url ?? anySource?.src ??
    null;

  logger.info(
    { m3u8: m3u8?.slice(0, 80) ?? null, provider: "vidplay", subtitleCount: subtitles.length },
    "[Stage 7] extraction complete"
  );

  if (!m3u8) {
    logger.error("[Stage 7] FAILED — no m3u8 URL found in source array");
    return null;
  }

  return {
    type: "direct",
    provider: "vidplay",
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro,
  };
}

export function isVidplayHost(embedUrl: string): boolean {
  try {
    const host = new URL(embedUrl).hostname;
    return (
      VIDPLAY_HOSTS.some((h) => host.includes(h)) ||
      MEGACLOUD_HOSTS.some((h) => host.includes(h))
    );
  } catch {
    return false;
  }
}
