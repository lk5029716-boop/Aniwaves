/**
 * Echovideo provider extractor.
 *
 * Correct API (discovered via VM execution of the obfuscated inline JS):
 *   GET /{embedPrefix}/getSources?id={sourceId}
 *   Referer: {embedUrl}
 *   Origin: https://play.echovideo.ru
 *   Sec-Fetch-*: same-origin
 *
 * Response format:
 *   {
 *     sources: "https://cdn.example.com/path/master.m3u8",   // plain string m3u8
 *     intro:   { start: number, end: number },
 *     outro:   { start: number, end: number },
 *     tracks:  [{ file: string, kind: "thumbnails" | "captions" | ... }]
 *   }
 *
 * The sources field is a plain string URL — NOT an encrypted blob, NOT an array.
 */
import axios from "axios";
import { logger } from "../../logger.js";
import { extractViaPlaywright } from "./playwright-extractor.js";
import type { StreamSource, Subtitle, SkipTime } from "../types.js";

interface EchovideoSourcesResponse {
  sources?: string | Array<{ file?: string; url?: string }>;
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
  tracks?: Array<{ file?: string; src?: string; label?: string; kind?: string }>;
}

export async function extractEchovideo(
  embedUrl: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const urlObj = new URL(embedUrl);
  const host = urlObj.hostname;

  // Determine the embed prefix (e.g. embed-1, embed-2, embed-6)
  const pathMatch = urlObj.pathname.match(/^\/(embed-\d+)\//);
  const embedPrefix = pathMatch?.[1] ?? "embed-1";

  // sourceId = last path segment of the embed URL
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  const sourceId = pathParts[pathParts.length - 1];

  if (!sourceId) {
    logger.error({ embedUrl }, "[Echovideo S1] FAILED — no sourceId in URL path");
    return extractViaPlaywright(embedUrl, "echovideo", skipData);
  }

  // ── S1: fetch embed page (for cookies / session validation, if any) ─────────
  logger.info(
    { embedUrl: embedUrl.slice(0, 80), host, embedPrefix, sourceId: sourceId.slice(0, 30) },
    "[Echovideo S1] fetching embed page"
  );

  const commonHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: "https://aniwaves.ru/",
    Accept: "text/html,application/xhtml+xml,*/*",
  };

  try {
    const pageResp = await axios.get(embedUrl, { timeout: 10000, headers: commonHeaders });
    logger.debug(
      { status: pageResp.status, snippet: String(pageResp.data).slice(0, 120) },
      "[Echovideo S1] embed page fetched"
    );
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "[Echovideo S1] embed page fetch failed, continuing");
  }

  // ── S2: call getSources ─────────────────────────────────────────────────────
  //
  // The correct path is /{embedPrefix}/getSources?id={sourceId}
  // (discovered by running the obfuscated JS in a Node.js VM — the script calls
  //  fetch("getSources?id=...") which resolves relative to /embed-1/{id})
  //
  const sourcesUrl = `https://${host}/${embedPrefix}/getSources`;
  logger.info(
    { sourcesUrl, sourceId: sourceId.slice(0, 30) },
    "[Echovideo S2] requesting getSources"
  );

  let data: EchovideoSourcesResponse;
  try {
    const resp = await axios.get<EchovideoSourcesResponse>(sourcesUrl, {
      params: { id: sourceId },
      headers: {
        "User-Agent": commonHeaders["User-Agent"],
        Accept: "application/json, */*",
        Referer: embedUrl,
        Origin: `https://${host}`,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Site": "same-origin",
      },
      timeout: 12000,
    });
    data = resp.data;
    logger.debug(
      {
        status: resp.status,
        sourcesType: typeof data.sources,
        hasIntro: data.intro != null,
        hasOutro: data.outro != null,
        trackCount: data.tracks?.length ?? 0,
        snippet: JSON.stringify(data).slice(0, 300),
      },
      "[Echovideo S2] getSources response"
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
      "[Echovideo S2] FAILED — getSources request failed, falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "echovideo", skipData);
  }

  // ── S3: extract m3u8 URL ────────────────────────────────────────────────────
  logger.info("[Echovideo S3] extracting m3u8 URL from response");

  let m3u8: string | null = null;

  if (typeof data.sources === "string" && data.sources.length > 0) {
    // Most common: sources is a plain m3u8 URL string
    m3u8 = data.sources;
    logger.debug({ m3u8: m3u8.slice(0, 80) }, "[Echovideo S3] sources is a plain string URL");
  } else if (Array.isArray(data.sources)) {
    // Fallback: sources is an array of {file, type} objects
    const m3u8Entry = data.sources.find((s) =>
      (s.file ?? s.url ?? "").toLowerCase().includes(".m3u8")
    ) ?? data.sources[0];
    m3u8 = m3u8Entry?.file ?? m3u8Entry?.url ?? null;
    logger.debug({ m3u8: m3u8?.slice(0, 80) ?? null }, "[Echovideo S3] sources is an array");
  }

  if (!m3u8) {
    logger.warn(
      { sourcesRaw: JSON.stringify(data.sources).slice(0, 200) },
      "[Echovideo S3] no m3u8 in sources — falling back to Playwright"
    );
    return extractViaPlaywright(embedUrl, "echovideo", skipData);
  }

  // ── S4: parse tracks for subtitles / thumbnails ──────────────────────────────
  logger.info("[Echovideo S4] parsing tracks");

  const tracksRaw = data.tracks ?? [];
  const subtitles: Subtitle[] = tracksRaw
    .filter(
      (t) =>
        t.kind !== "thumbnails" &&
        t.kind !== "preview" &&
        (t.file ?? t.src ?? "").length > 0
    )
    .map((t) => ({
      lang: (t.label ?? "unknown").toLowerCase().replace(/\s+/g, "-"),
      label: t.label ?? "Unknown",
      url: t.file ?? t.src ?? "",
    }));

  const thumbnailTrack = tracksRaw.find(
    (t) => t.kind === "thumbnails" || t.kind === "preview"
  );
  const thumbnails = thumbnailTrack?.file ?? thumbnailTrack?.src ?? null;

  // ── S5: build skip times ─────────────────────────────────────────────────────
  logger.info("[Echovideo S5] building skip times");

  let intro: SkipTime | null = null;
  let outro: SkipTime | null = null;

  // Prefer getSources response (authoritative for this episode)
  if (data.intro && (data.intro.start !== 0 || data.intro.end !== 0)) {
    intro = { start: data.intro.start, end: data.intro.end };
  } else if (skipData?.intro && (skipData.intro[0] !== 0 || skipData.intro[1] !== 0)) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }

  if (data.outro && (data.outro.start !== 0 || data.outro.end !== 0)) {
    outro = { start: data.outro.start, end: data.outro.end };
  } else if (skipData?.outro && (skipData.outro[0] !== 0 || skipData.outro[1] !== 0)) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  logger.info(
    {
      m3u8: m3u8.slice(0, 100),
      subtitles: subtitles.length,
      thumbnails: thumbnails?.slice(0, 60) ?? null,
      intro,
      outro,
    },
    "[Echovideo S5] extraction complete — SUCCESS"
  );

  return {
    type: "direct",
    provider: "echovideo",
    m3u8,
    subtitles,
    thumbnails,
    intro,
    outro,
  };
}

export function isEchovideoHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes("echovideo") || host.includes("echo");
  } catch {
    return false;
  }
}
