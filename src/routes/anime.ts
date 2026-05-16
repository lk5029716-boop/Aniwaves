import { Router, type IRouter } from "express";
import type { Request } from "express";
import {
  searchAnime,
  getAnimeDetails,
  getEpisodes,
  getServers,
  getEmbedUrl,
} from "../lib/anime/scraper.js";
import { extractStream } from "../lib/anime/providers/index.js";

// ─── M3U8 rewriter ────────────────────────────────────────────────────────────
// Resolves relative URLs against the playlist's own URL, then wraps every
// segment / sub-manifest / key URI so it goes back through /api/proxy.
function resolveUrl(href: string, base: URL): string {
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, base).toString();
}

function rewriteM3u8(text: string, baseUrl: URL, req: Request): string {
  const scheme = req.headers["x-forwarded-proto"] ?? req.protocol;
  const host   = req.headers["x-forwarded-host"]  ?? req.get("host");
  const proxyBase = `${scheme}://${host}/api/proxy?url=`;

  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();

      // Rewrite URI="..." inside EXT-X-KEY and EXT-X-MAP tags
      if (t.startsWith("#EXT-X-KEY") || t.startsWith("#EXT-X-MAP")) {
        return t.replace(/URI="([^"]+)"/g, (_, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
        });
      }

      // Skip blank lines and all other # directives
      if (!t || t.startsWith("#")) return line;

      // This is a bare URL line (variant playlist or media segment)
      const abs = resolveUrl(t, baseUrl);
      return `${proxyBase}${encodeURIComponent(abs)}`;
    })
    .join("\n");
}

const router: IRouter = Router();

/**
 * GET /api/search?q=naruto
 */
router.get("/search", async (req, res): Promise<void> => {
  const q = Array.isArray(req.query["q"]) ? req.query["q"][0] : req.query["q"];
  if (!q || typeof q !== "string") {
    res.status(400).json({ error: "Missing query param: q" });
    return;
  }
  const results = await searchAnime(q);
  res.json({ results });
});

/**
 * GET /api/details?id=naruto-76396
 */
router.get("/details", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  const details = await getAnimeDetails(id);
  res.json(details);
});

/**
 * GET /api/episodes?id=naruto-76396
 */
router.get("/episodes", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  const episodes = await getEpisodes(id);
  res.json({ episodes });
});

/**
 * GET /api/servers?id=naruto-76396&ep=1&type=sub
 */
router.get("/servers", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"])
    ? req.query["ep"][0]
    : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"])
    ? req.query["type"][0]
    : req.query["type"];

  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  if (!epRaw) {
    res.status(400).json({ error: "Missing query param: ep" });
    return;
  }
  const ep = parseInt(String(epRaw), 10);
  if (isNaN(ep)) {
    res.status(400).json({ error: "param ep must be a number" });
    return;
  }
  const type: "sub" | "dub" | "raw" =
    typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const servers = await getServers(id, ep, type);
  res.json({ servers });
});

/**
 * GET /api/stream?id=naruto-76396&ep=1&type=sub&server=vidplay
 */
router.get("/stream", async (req, res): Promise<void> => {
  const id = Array.isArray(req.query["id"])
    ? req.query["id"][0]
    : req.query["id"];
  const epRaw = Array.isArray(req.query["ep"])
    ? req.query["ep"][0]
    : req.query["ep"];
  const typeRaw = Array.isArray(req.query["type"])
    ? req.query["type"][0]
    : req.query["type"];
  const serverParam = Array.isArray(req.query["server"])
    ? req.query["server"][0]
    : (req.query["server"] ?? "vidplay");

  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Missing query param: id" });
    return;
  }
  if (!epRaw) {
    res.status(400).json({ error: "Missing query param: ep" });
    return;
  }
  const ep = parseInt(String(epRaw), 10);
  if (isNaN(ep)) {
    res.status(400).json({ error: "param ep must be a number" });
    return;
  }

  const type: "sub" | "dub" | "raw" =
    typeRaw === "dub" ? "dub" : typeRaw === "raw" ? "raw" : "sub";
  const serverName = typeof serverParam === "string" ? serverParam : "vidplay";

  req.log.info({ id, ep, type, server: serverName }, "stream requested");

  // 1. Get server list
  const servers = await getServers(id, ep, type);
  if (servers.length === 0) {
    res.status(404).json({ error: "No servers found for this episode/type" });
    return;
  }

  req.log.debug({ servers: servers.map((s) => s.name) }, "available servers");

  // 2. Pick the requested server, fall back to first available
  const preferredServer =
    servers.find((s) =>
      s.name.toLowerCase().includes(serverName.toLowerCase())
    ) ?? servers[0]!;

  req.log.info(
    { serverName: preferredServer.name, linkId: preferredServer.id.slice(0, 30) },
    "selected server"
  );

  // 3. Resolve embed URL + skip data from /ajax/sources
  const sourcesResult = await getEmbedUrl(preferredServer.id, id);
  if (!sourcesResult?.url) {
    res.status(502).json({ error: "Could not resolve embed URL for server" });
    return;
  }

  const embedUrl = sourcesResult.url;
  req.log.info({ embedUrl: embedUrl.slice(0, 80) }, "embed URL resolved");

  // 4. Extract direct stream from provider
  const stream = await extractStream(embedUrl, preferredServer.name, {
    intro: sourcesResult.skip_data?.intro,
    outro: sourcesResult.skip_data?.outro,
  });

  if (!stream?.m3u8) {
    res.status(502).json({
      error:
        "Stream extraction failed — check server logs for stage-by-stage detail",
      debug: {
        serverName: preferredServer.name,
        embedUrl,
      },
    });
    return;
  }

  res.json(stream);
});

// ─── Stream proxy ─────────────────────────────────────────────────────────────
// GET /api/proxy?url=<encoded-url>
//
// Fetches the upstream resource with the Referer / Origin headers that the
// echovideo CDN requires.  For m3u8 playlists every internal URI is rewritten
// so subsequent sub-manifest and segment requests also come through this proxy.
router.get("/proxy", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.query["url"])
    ? req.query["url"][0]
    : req.query["url"];

  if (!raw || typeof raw !== "string") {
    res.status(400).json({ error: "Missing query param: url" });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(raw);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "Referer":    "https://play.echovideo.ru/",
        "Origin":     "https://play.echovideo.ru",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream error ${upstream.status}`);
      return;
    }

    const contentType  = upstream.headers.get("content-type") ?? "";
    const isM3u8 =
      contentType.includes("mpegurl") ||
      raw.includes(".m3u8") ||
      raw.includes("m3u8");

    // Pass CORS headers so hls.js (running in the browser) can load the response
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

if (isM3u8) {
  const text      = await upstream.text();
  const finalUrl  = new URL(upstream.url || raw);
  const rewritten = rewriteM3u8(text, finalUrl, req);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
    } else {
      // Binary pass-through — .ts segments, AES-128 key files, etc.
      res.setHeader(
        "Content-Type",
        contentType || "application/octet-stream"
      );
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Proxy fetch failed: ${msg}` });
  }
});

// ... existing proxy route above ...

router.get("/debug-embed", async (req, res): Promise<void> => {
  const url = "https://weneverbeenfree.com/e/gy4is9fovon8?v=1&asi=0&autoPlay=0&ao=0";
  const resp = await fetch(url, {
    headers: {
      "Referer": "https://aniwaves.ru/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });
  const text = await resp.text();
  res.send(text);
});

export default router;
