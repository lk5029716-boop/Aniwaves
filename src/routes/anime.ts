import { Router, type IRouter } from "express";
import {
  searchAnime,
  getAnimeDetails,
  getEpisodes,
  getServers,
  getEmbedUrl,
} from "../lib/anime/scraper.js";
import { extractStream } from "../lib/anime/providers/index.js";

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

export default router;
