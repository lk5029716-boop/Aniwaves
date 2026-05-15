/**
 * Playwright-based stream extractor.
 *
 * Used for providers (Echovideo/JWPlayer) where the m3u8 URL is decoded
 * client-side by obfuscated JS — simple HTTP requests cannot obtain it.
 * Strategy:
 *   1. Navigate with waitUntil:"load" (skip networkidle — health-check.js polls continuously)
 *   2. waitForFunction until JWPlayer initializes its playlist OR window.currentHlsHost is set
 *   3. Read m3u8 from jwplayer("mg-player").getPlaylist() sources
 *   4. Fallback: read window.currentHlsHost
 *   5. Fallback: simulate a play click and intercept first HLS network request
 *   6. Fallback: scan rendered page content for bare m3u8 URLs
 */
import { chromium } from "playwright-core";
import { logger } from "../../logger.js";
import type { StreamSource } from "../types.js";

const CHROMIUM_PATH =
  process.env["CHROMIUM_PATH"] ??
  "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome";

export async function extractViaPlaywright(
  embedUrl: string,
  provider: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  logger.info(
    { embedUrl: embedUrl.slice(0, 80), provider },
    "[Playwright] launching browser for provider extraction"
  );

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  } catch (err) {
    const e = err as Error;
    logger.error({ error: e.message }, "[Playwright] FAILED — could not launch browser");
    return null;
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      Referer: "https://aniwaves.ru/",
      Origin: "https://aniwaves.ru",
    },
  });

  const page = await context.newPage();

  let m3u8Url: string | null = null;
  const subtitleUrls: Array<{ url: string; label: string }> = [];

  // Capture HLS network requests (fires when playback actually starts)
  page.on("request", (request) => {
    const url = request.url();
    if (!m3u8Url && url.includes(".m3u8")) {
      logger.debug({ url: url.slice(0, 120) }, "[Playwright] intercepted m3u8 network request");
      m3u8Url = url;
    }
    if (!m3u8Url && (url.includes(".vtt") || url.includes(".srt"))) {
      subtitleUrls.push({ url, label: "Unknown" });
    }
  });

  try {
    // Use autoPlay=1 so JWPlayer starts (and we can intercept the m3u8 fetch)
    const autoPlayUrl = embedUrl.replace(/autoPlay=\d/, "autoPlay=1").replace(/ao=\d/, "ao=1");
    logger.info({ url: autoPlayUrl.slice(0, 100) }, "[Playwright] navigating (waitUntil=load)");

    await page.goto(autoPlayUrl, {
      waitUntil: "load",       // Do NOT use networkidle — health-check.js polls forever
      timeout: 20000,
    });

    logger.debug("[Playwright] page loaded — waiting for JWPlayer initialization");

    // ── Stage A: wait for JWPlayer to set up its playlist ──────────────────
    const jwReady = await page
      .waitForFunction(
        () => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const g = globalThis as any;
          // JWPlayer exposes a getPlaylist() method once set up
          if (typeof g.jwplayer === "function") {
            try {
              const player = g.jwplayer("mg-player");
              const playlist = player?.getPlaylist?.();
              if (playlist && playlist.length > 0) return true;
            } catch {
              // not ready yet
            }
            // Also accept a fresh instance without the container ID
            try {
              const player2 = g.jwplayer();
              const playlist2 = player2?.getPlaylist?.();
              if (playlist2 && playlist2.length > 0) return true;
            } catch {
              // ignore
            }
          }
          // Also check the flag health-check.js reads
          if (typeof (globalThis as any).currentHlsHost === "string" &&
            (globalThis as any).currentHlsHost.length > 5) return true;
          return false;
        },
        { timeout: 12000, polling: 300 }
      )
      .catch(() => null);

    if (jwReady) {
      logger.debug("[Playwright] JWPlayer/currentHlsHost ready — extracting sources");
    } else {
      logger.warn("[Playwright] timed out waiting for JWPlayer — will still try extraction");
    }

    // ── Stage B: extract from JWPlayer API ─────────────────────────────────
    if (!m3u8Url) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const extracted = await page.evaluate((): {
        m3u8: string | null;
        hlsHost: string | null;
        subtitles: Array<{ file: string; label: string }>;
      } => {
        const g = globalThis as any;
        let m3u8: string | null = null;
        const subs: Array<{ file: string; label: string }> = [];

        // Try named instance first
        const tryPlayer = (p: any) => {
          const playlist: any[] = p?.getPlaylist?.() ?? [];
          for (const item of playlist) {
            for (const src of item?.sources ?? []) {
              if (String(src?.file ?? src?.url ?? "").includes(".m3u8")) {
                m3u8 = src.file ?? src.url;
              }
            }
            // Collect subtitle tracks
            for (const track of item?.tracks ?? []) {
              if (
                (track?.kind === "captions" || track?.kind === "subtitles") &&
                track?.file
              ) {
                subs.push({ file: track.file, label: track?.label ?? "Unknown" });
              }
            }
          }
        };

        if (typeof g.jwplayer === "function") {
          try { tryPlayer(g.jwplayer("mg-player")); } catch { /* ignore */ }
          if (!m3u8) {
            try { tryPlayer(g.jwplayer()); } catch { /* ignore */ }
          }
        }

        const hlsHost = typeof g.currentHlsHost === "string" ? g.currentHlsHost : null;
        return { m3u8, hlsHost, subtitles: subs };
      });
      /* eslint-enable @typescript-eslint/no-explicit-any */

      logger.debug(
        { m3u8: extracted.m3u8?.slice(0, 80) ?? null, hlsHost: extracted.hlsHost?.slice(0, 60) ?? null },
        "[Playwright] JWPlayer evaluation result"
      );

      if (extracted.m3u8) {
        m3u8Url = extracted.m3u8;
      } else if (extracted.hlsHost) {
        // currentHlsHost is the CDN host; we need to build the full m3u8 path
        // It could be a bare hostname or a full URL prefix
        if (extracted.hlsHost.startsWith("http")) {
          m3u8Url = extracted.hlsHost.includes(".m3u8")
            ? extracted.hlsHost
            : extracted.hlsHost.replace(/\/$/, "") + "/index.m3u8";
        } else {
          m3u8Url = `https://${extracted.hlsHost}/index.m3u8`;
        }
        logger.debug({ m3u8Url }, "[Playwright] built m3u8 from currentHlsHost");
      }

      for (const s of extracted.subtitles) {
        subtitleUrls.push({ url: s.file, label: s.label });
      }
    }

    // ── Stage C: simulate play click to force HLS fetch ────────────────────
    if (!m3u8Url) {
      logger.debug("[Playwright] no m3u8 from JWPlayer API — simulating play click");
      try {
        await page.click("#mg-player, .jw-display-icon-container, .jw-icon-display, video", {
          timeout: 3000,
        });
      } catch {
        // element may not exist or click not needed
      }
      await page.waitForTimeout(4000);
    }

    // ── Stage D: scan page content ──────────────────────────────────────────
    if (!m3u8Url) {
      const content = await page.content();
      const match = content.match(/https?:\/\/[^"'`\s\\<>]+\.m3u8[^"'`\s\\<>]*/);
      if (match) {
        m3u8Url = match[0];
        logger.debug({ url: m3u8Url.slice(0, 100) }, "[Playwright] m3u8 found in rendered page content");
      }
    }

    // ── Stage E: try window vars via evaluate again (after click) ──────────
    if (!m3u8Url) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const fallback = await page.evaluate((): string | null => {
        const g = globalThis as any;
        // Some JWPlayer wrappers store current source directly
        if (g.player?.getPlaylistItem) {
          const item = g.player.getPlaylistItem();
          for (const src of item?.sources ?? []) {
            if (String(src?.file ?? "").includes(".m3u8")) return src.file;
          }
        }
        // Look for any variable containing an m3u8 URL
        for (const key of Object.keys(g)) {
          const val = g[key];
          if (typeof val === "string" && val.includes(".m3u8") && val.startsWith("http")) {
            return val;
          }
        }
        return null;
      });
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (fallback) {
        m3u8Url = fallback;
        logger.debug({ url: m3u8Url.slice(0, 100) }, "[Playwright] m3u8 from fallback window scan");
      }
    }
  } catch (err) {
    const e = err as Error;
    logger.error({ error: e.message }, "[Playwright] navigation/extraction error");
  } finally {
    await browser.close();
    logger.debug("[Playwright] browser closed");
  }

  if (!m3u8Url) {
    logger.error(
      { embedUrl: embedUrl.slice(0, 80) },
      "[Playwright] FAILED — no m3u8 URL found after all extraction stages"
    );
    return null;
  }

  logger.info(
    { m3u8: m3u8Url.slice(0, 100), subtitles: subtitleUrls.length, provider },
    "[Playwright] extraction successful"
  );

  let intro = null;
  let outro = null;
  if (skipData?.intro?.[1] && skipData.intro[1] > 0) {
    intro = { start: skipData.intro[0], end: skipData.intro[1] };
  }
  if (skipData?.outro?.[1] && skipData.outro[1] > 0) {
    outro = { start: skipData.outro[0], end: skipData.outro[1] };
  }

  return {
    type: "direct",
    provider,
    m3u8: m3u8Url,
    subtitles: subtitleUrls.map((s, i) => ({
      lang: `track-${i}`,
      label: s.label,
      url: s.url,
    })),
    thumbnails: null,
    intro,
    outro,
  };
}
