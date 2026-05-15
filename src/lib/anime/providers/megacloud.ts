/**
 * MegaCloud / RapidCloud / RabbitStream extractor.
 *
 * Different pipeline from Vidplay:
 * 1. Fetch embed page → extract sourceId from URL
 * 2. GET /embed-2/ajax/e-1/getSources?id={sourceId} with custom headers
 * 3. If sources.encrypted === true → decrypt with AES key from script
 * 4. Parse sources array → pick m3u8
 */
import axios from "axios";
import * as cheerio from "cheerio";
import CryptoJS from "crypto-js";
import { logger } from "../../logger.js";
import type { StreamSource, Subtitle, SkipTime } from "../types.js";

const MEGACLOUD_KEYS_URL =
  "https://raw.githubusercontent.com/theonlymo/keys/main/key";

async function fetchMegacloudKey(): Promise<string | null> {
  try {
    const resp = await axios.get(MEGACLOUD_KEYS_URL, { timeout: 5000 });
    const key =
      typeof resp.data === "string"
        ? resp.data.trim()
        : JSON.stringify(resp.data);
    logger.debug({ key: key.slice(0, 20) }, "megacloud key fetched");
    return key;
  } catch {
    logger.warn("could not fetch megacloud key");
    return null;
  }
}

function extractKeyAndDecrypt(
  ciphertext: string,
  keyFromScript: string
): string | null {
  try {
    const decrypted = CryptoJS.AES.decrypt(ciphertext, keyFromScript).toString(
      CryptoJS.enc.Utf8
    );
    if (decrypted && (decrypted.startsWith("[") || decrypted.startsWith("{"))) {
      return decrypted;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractKeyFromScript(scriptContent: string): string | null {
  // Pattern: var key = "..." or const key = "..."
  const patterns = [
    /(?:var|let|const)\s+key\s*=\s*['"]([^'"]{8,})['"]/,
    /key\s*:\s*['"]([^'"]{8,})['"]/,
    /decryptionKey\s*[:=]\s*['"]([^'"]{8,})['"]/,
    /k\s*=\s*['"]([^'"]{8,})['"]/,
  ];
  for (const p of patterns) {
    const m = scriptContent.match(p);
    if (m) return m[1] ?? null;
  }
  return null;
}

export async function extractMegacloud(
  embedUrl: string
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;

  // Extract sourceId from URL
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  const sourceId = pathParts[pathParts.length - 1];

  if (!sourceId) {
    logger.error({ embedUrl }, "[MegaCloud Stage 1] FAILED — no sourceId in URL");
    return null;
  }

  logger.info({ embedUrl, host, sourceId }, "[MegaCloud Stage 1] fetching embed page");

  let embedHtml = "";
  let scriptKey: string | null = null;

  try {
    const resp = await axios.get(embedUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://aniwaves.ru/",
      },
    });
    embedHtml = resp.data as string;
    logger.debug(
      { status: resp.status, snippet: embedHtml.slice(0, 200) },
      "[MegaCloud Stage 1] embed page fetched"
    );

    const $ = cheerio.load(embedHtml);
    const scripts = $("script:not([src])")
      .map((_, el) => $(el).html() ?? "")
      .get()
      .join("\n");
    scriptKey = extractKeyFromScript(scripts);
    if (scriptKey) {
      logger.debug({ scriptKey: scriptKey.slice(0, 20) }, "[MegaCloud Stage 1] key found in page scripts");
    }
  } catch (err) {
    const e = err as Error;
    logger.warn({ error: e.message }, "[MegaCloud Stage 1] embed page fetch failed, continuing");
  }

  // Determine the correct getSources endpoint
  // MegaCloud / RapidCloud use different path prefixes
  const endpointMap: Record<string, string> = {
    "megacloud.tv": "/embed-2/ajax/e-1/getSources",
    "rapid-cloud.co": "/embed-6/ajax/e-1/getSources",
    "rabbitstream.net": "/embed-4/ajax/e-1/getSources",
  };

  let sourcesPath = "/embed-2/ajax/e-1/getSources";
  for (const [h, p] of Object.entries(endpointMap)) {
    if (host.includes(h)) {
      sourcesPath = p;
      break;
    }
  }

  const sourcesUrl = `https://${host}${sourcesPath}`;

  logger.info(
    { sourcesUrl, sourceId },
    "[MegaCloud Stage 2] requesting sources"
  );

  let data: Record<string, unknown>;
  try {
    const resp = await axios.get(sourcesUrl, {
      params: { id: sourceId },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15000,
    });
    data = resp.data as Record<string, unknown>;
    logger.debug(
      { status: resp.status, snippet: JSON.stringify(data).slice(0, 300) },
      "[MegaCloud Stage 2] sources response"
    );
  } catch (err) {
    const e = err as Error & { response?: { status: number; data: unknown } };
    logger.error(
      {
        sourcesUrl,
        error: e.message,
        status: e.response?.status,
        body: JSON.stringify(e.response?.data ?? "").slice(0, 200),
      },
      "[MegaCloud Stage 2] FAILED — sources request failed"
    );
    return null;
  }

  // ── Stage 3: decrypt if needed ────────────────────────────────────────────
  logger.info("[MegaCloud Stage 3] decryption check");

  let sourcesArr: unknown[] = [];
  const isEncrypted =
    data["encrypted"] === true || typeof data["sources"] === "string";

  if (isEncrypted && typeof data["sources"] === "string") {
    logger.debug("[MegaCloud Stage 3] sources encrypted, attempting decryption");

    const remoteKey = await fetchMegacloudKey();
    const keysToTry = [
      scriptKey,
      remoteKey,
      "c1d17096f2ca11b7",
      "9Y6I6HiQOqjDUlbA",
      "koko",
    ].filter(Boolean) as string[];

    let decrypted: string | null = null;
    for (const k of keysToTry) {
      decrypted = extractKeyAndDecrypt(data["sources"] as string, k);
      if (decrypted) {
        logger.debug({ key: k.slice(0, 15) }, "[MegaCloud Stage 3] decryption succeeded");
        break;
      }
    }

    if (!decrypted) {
      logger.error("[MegaCloud Stage 3] FAILED — all decryption attempts failed");
      return null;
    }

    try {
      sourcesArr = JSON.parse(decrypted) as unknown[];
    } catch {
      logger.error("[MegaCloud Stage 3] FAILED — decrypted payload is not valid JSON");
      return null;
    }
  } else {
    sourcesArr = Array.isArray(data["sources"]) ? (data["sources"] as unknown[]) : [];
    logger.debug("[MegaCloud Stage 3] sources not encrypted");
  }

  logger.info(
    { count: sourcesArr.length },
    "[MegaCloud Stage 4] source list parsed"
  );

  if (sourcesArr.length === 0) {
    logger.error("[MegaCloud Stage 4] FAILED — empty source array");
    return null;
  }

  const tracksRaw = (data["tracks"] ?? []) as Array<{
    file?: string;
    src?: string;
    label?: string;
    kind?: string;
  }>;

  const subtitles: Subtitle[] = tracksRaw
    .filter((t) => t.kind !== "thumbnails")
    .map((t) => ({
      lang: (t.label ?? "").toLowerCase().split(" ").join("-"),
      label: t.label ?? "Unknown",
      url: t.file ?? t.src ?? "",
    }))
    .filter((s) => s.url);

  const thumbnailTrack = tracksRaw.find((t) => t.kind === "thumbnails");
  const thumbnails = thumbnailTrack?.file ?? thumbnailTrack?.src ?? null;

  const intro = (data["intro"] as SkipTime) ?? null;
  const outro = (data["outro"] as SkipTime) ?? null;

  interface SourceEntry {
    file?: string;
    url?: string;
    src?: string;
  }

  const best = (sourcesArr as SourceEntry[]).find((s) =>
    (s.file ?? s.url ?? s.src ?? "").includes(".m3u8")
  ) ?? (sourcesArr as SourceEntry[])[0];

  const m3u8 = best?.file ?? best?.url ?? best?.src ?? null;

  logger.info(
    { m3u8: m3u8?.slice(0, 80) ?? null, provider: "megacloud" },
    "[MegaCloud Stage 5] extraction complete"
  );

  if (!m3u8) {
    logger.error("[MegaCloud Stage 5] FAILED — no m3u8 URL in source array");
    return null;
  }

  return {
    type: "direct",
    provider: "megacloud",
    m3u8,
    subtitles,
    thumbnails: thumbnails ?? null,
    intro,
    outro,
  };
}

export function isMegacloudHost(embedUrl: string): boolean {
  try {
    const host = new URL(embedUrl).hostname;
    return (
      host.includes("megacloud") ||
      host.includes("rapid-cloud") ||
      host.includes("rabbitstream")
    );
  } catch {
    return false;
  }
}
