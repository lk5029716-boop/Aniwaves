/**
 * Aniwaves.ru scraper — real API discovered via site inspection.
 *
 * Endpoints (all require X-Requested-With: XMLHttpRequest):
 *   Search:    GET /ajax/anime/search?keyword={q}
 *              → {status:200, result:{html:"..."}}
 *   Page:      GET /watch/{id}
 *              → HTML; [data-id] holds numeric ID
 *   Episodes:  GET /ajax/episode/list/{numericId}
 *              → {status:200, result:"<html>"}
 *              episodes: a[data-ids][data-num], data-ids="76396&eps=1"
 *   Servers:   GET /ajax/server/list?servers={dataIds}
 *              → {status:200, result:"<html>"}
 *              servers: .type[data-type] li[data-link-id]
 *   Sources:   GET /ajax/sources?id={linkId}
 *              → {status:200, result:{url:"https://...", skip_data, sources, tracks}}
 */
import axios from "axios";
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import { cacheGet, cacheSet } from "./cache.js";
import type {
  AnimeSearchResult,
  AnimeDetails,
  Episode,
  Server,
} from "./types.js";

const BASE_URL = "https://aniwaves.ru";

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

const ajaxClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer: BASE_URL,
  },
});

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchAnime(q: string): Promise<AnimeSearchResult[]> {
  const cacheKey = `search:${q}`;
  const cached = cacheGet<AnimeSearchResult[]>(cacheKey);
  if (cached) {
    logger.debug({ q }, "search cache hit");
    return cached;
  }

  logger.info({ q }, "searching anime via /ajax/anime/search");

  const resp = await ajaxClient.get("/ajax/anime/search", {
    params: { keyword: q },
  });

  const data = resp.data as {
    status: number;
    result?: { html?: string } | string;
  };

  // result can be {html: "..."} or a plain string
  const html =
    typeof data.result === "string"
      ? data.result
      : (data.result?.html ?? "");

  if (!html) {
    logger.warn({ q, status: data.status }, "search returned no HTML");
    return [];
  }

  const $ = cheerio.load(html);
  const results: AnimeSearchResult[] = [];

  $("a.item").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") ?? "";
    // href is /watch/naruto-76396
    const id = href.replace(/^\/watch\//, "").replace(/\/$/, "");
    const title =
      $el.find(".name.d-title").text().trim() ||
      $el.find(".name").text().trim();
    const poster =
      $el.find(".poster img").attr("src") ||
      $el.find(".poster img").attr("data-src") ||
      "";
    const metaDots = $el.find(".meta .dot");
    const type = metaDots.eq(0).text().trim();

    if (id && title) {
      results.push({ id, title, poster, type, episodes: { sub: 0, dub: 0 } });
    }
  });

  cacheSet(cacheKey, results, 1800);
  logger.info({ q, count: results.length }, "search complete");
  return results;
}

// ── Numeric ID lookup ─────────────────────────────────────────────────────────

export async function getNumericId(animeId: string): Promise<string | null> {
  const cacheKey = `numericId:${animeId}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached) return cached;

  const resp = await client.get(`/watch/${animeId}`);
  const $ = cheerio.load(resp.data as string);

  // The page has data-id="76396" on multiple elements
  const numericId = $("[data-id]").first().attr("data-id") ?? null;

  if (numericId) {
    cacheSet(cacheKey, numericId, 86400); // stable, cache for 24h
  }

  return numericId;
}

// ── Details ────────────────────────────────────────────────────────────────────

export async function getAnimeDetails(id: string): Promise<AnimeDetails> {
  const cacheKey = `details:${id}`;
  const cached = cacheGet<AnimeDetails>(cacheKey);
  if (cached) {
    logger.debug({ id }, "details cache hit");
    return cached;
  }

  logger.info({ id }, "fetching anime details from /watch/:id");

  const resp = await client.get(`/watch/${id}`);
  const $ = cheerio.load(resp.data as string);

  const title =
    $("h1.title.d-title").text().trim() ||
    $("h1.film-name").text().trim() ||
    $("h1").first().text().trim() ||
    id;

  const poster =
    $(".poster img").first().attr("src") ||
    $(".film-poster img").attr("src") ||
    "";

  const description =
    $(".description").text().trim() ||
    $("[itemprop='description']").text().trim();

  const genres: string[] = [];
  $("a[href*='/genre/'], a[href*='/genres/']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) genres.push(t);
  });

  // Episode counts from sidebar/stats area
  let subCount = 0;
  let dubCount = 0;
  let totalCount = 0;

  // Look for episode count in various possible selectors
  $(".tick-sub, .sub-count").each((_, el) => {
    subCount = parseInt($(el).text().trim(), 10) || subCount;
  });
  $(".tick-dub, .dub-count").each((_, el) => {
    dubCount = parseInt($(el).text().trim(), 10) || dubCount;
  });
  $(".tick-eps, .ep-count").each((_, el) => {
    totalCount = parseInt($(el).text().trim(), 10) || totalCount;
  });

  // Extract from JSON-LD if available
  const jsonLdText = $('script[type="application/ld+json"]').text();
  if (jsonLdText) {
    try {
      const jsonLd = JSON.parse(jsonLdText) as {
        "@graph"?: Array<{ numberOfEpisodes?: number }>;
      };
      const graph = jsonLd["@graph"] ?? [];
      for (const node of graph) {
        if (node.numberOfEpisodes) {
          totalCount = totalCount || node.numberOfEpisodes;
        }
      }
    } catch {
      // ignore
    }
  }

  // Real page structure: <div>Label: <span>value</span></div>
  // e.g. "Premiered: <span>Fall 2002</span>"
  //      "Status: <span><a href="/completed">Finished</a></span>"
  //      "Genres: <span><a href="/genre/action">Action</a>, ...</span>"
  //      "Episodes: <span>220 / 220</span>"
  const filmInfoMap: Record<string, string> = {};

  $("div").each((_, el) => {
    const text = $(el).clone().children("span").remove().end().text().trim();
    const cleanLabel = text.replace(/:\s*$/, "").trim().toLowerCase();
    if (!cleanLabel || cleanLabel.length > 30) return;
    const val = $(el).find("span").first().text().trim();
    if (val) filmInfoMap[cleanLabel] = val;
  });

  // Genres: only from the specific "Genres:" div, not the filter dropdown
  const genreDiv = $("div").filter((_, el) => {
    return $(el).clone().children().remove().end().text().trim().startsWith("Genres:");
  }).first();
  if (genreDiv.length) {
    genres.length = 0; // clear any previously collected genres
    genreDiv.find("a").each((_, el) => {
      const t = $(el).text().trim();
      if (t) genres.push(t);
    });
  }

  // Episode counts from "Episodes: 220 / 220" pattern
  const episodeText = filmInfoMap["episodes"] ?? "";
  const epMatch = episodeText.match(/(\d+)/g);
  if (epMatch) {
    totalCount = parseInt(epMatch[0] ?? "0", 10) || totalCount;
  }

  // From JSON-LD
  if (!totalCount) {
    const jsonLdText = $('script[type="application/ld+json"]').text();
    if (jsonLdText) {
      try {
        const jsonLd = JSON.parse(jsonLdText) as {
          "@graph"?: Array<{ numberOfEpisodes?: number }>;
          numberOfEpisodes?: number;
        };
        const graph = jsonLd["@graph"] ?? [];
        for (const node of graph) {
          if (node.numberOfEpisodes) totalCount = node.numberOfEpisodes;
        }
        if (!totalCount && jsonLd.numberOfEpisodes) totalCount = jsonLd.numberOfEpisodes;
      } catch {
        // ignore
      }
    }
  }

  // Type from first <span class="wa_type"> inside the main info area
  // (before the related/sequel section)
  const mainType = $("span.wa_type").first().text().trim();

  const details: AnimeDetails = {
    id,
    title,
    poster,
    description,
    type: (mainType || filmInfoMap["type"] || filmInfoMap["format"] || "Unknown"),
    status: (filmInfoMap["status"] ?? "Unknown"),
    aired: (
      $("[itemprop='dateCreated']").text().trim() ||
      filmInfoMap["date aired"] ||
      filmInfoMap["aired"] ||
      filmInfoMap["premiered"] ||
      "Unknown"
    ),
    genres,
    episodes: {
      sub: subCount || totalCount,
      dub: dubCount,
      total: totalCount || subCount,
    },
  };

  cacheSet(cacheKey, details, 3600);
  logger.info({ id, title }, "details fetched");
  return details;
}

// ── Episodes ──────────────────────────────────────────────────────────────────

export async function getEpisodes(animeId: string): Promise<Episode[]> {
  const cacheKey = `episodes:${animeId}`;
  const cached = cacheGet<Episode[]>(cacheKey);
  if (cached) {
    logger.debug({ animeId }, "episodes cache hit");
    return cached;
  }

  logger.info({ animeId }, "fetching episode list");

  const numericId = await getNumericId(animeId);
  if (!numericId) {
    logger.warn({ animeId }, "could not resolve numeric ID");
    return [];
  }

  const resp = await ajaxClient.get(`/ajax/episode/list/${numericId}`, {
    headers: { Referer: `${BASE_URL}/watch/${animeId}` },
  });

  const data = resp.data as { status: number; result?: string };

  const html = data.result ?? "";
  if (!html) {
    logger.warn({ animeId, numericId, status: data.status }, "episode list returned no html");
    return [];
  }

  const $ = cheerio.load(html);
  const episodes: Episode[] = [];

  // Episodes are: <a href="#" data-ids="76396&eps=1" data-num="1" data-sub="1" data-dub="1">1</a>
  $("a[data-ids][data-num]").each((_, el) => {
    const $el = $(el);
    const dataIds = $el.attr("data-ids") ?? "";
    const num = parseInt($el.attr("data-num") ?? "0", 10);
    const title = $el.attr("title") || null;
    const isFiller = $el.hasClass("filler");

    if (dataIds && num > 0) {
      episodes.push({ number: num, id: dataIds, title, isFiller });
    }
  });

  episodes.sort((a, b) => a.number - b.number);
  cacheSet(cacheKey, episodes, 1800);
  logger.info({ animeId, count: episodes.length }, "episodes fetched");
  return episodes;
}

// ── Servers ───────────────────────────────────────────────────────────────────

export async function getServers(
  animeId: string,
  ep: number,
  type: "sub" | "dub" | "raw"
): Promise<Server[]> {
  const cacheKey = `servers:${animeId}:${ep}:${type}`;
  const cached = cacheGet<Server[]>(cacheKey);
  if (cached) {
    logger.debug({ animeId, ep, type }, "servers cache hit");
    return cached;
  }

  logger.info({ animeId, ep, type }, "fetching server list");

  const episodes = await getEpisodes(animeId);
  const episode = episodes.find((e) => e.number === ep);

  if (!episode) {
    logger.warn({ animeId, ep }, "episode not found");
    return [];
  }

  // episode.id = "76396&eps=1" — must be split into two separate URL params,
  // NOT passed as a single encoded value (axios would encode the & to %26)
  const [animeNumId, epsNum] = episode.id.split("&eps=");
  const resp = await ajaxClient.get("/ajax/server/list", {
    params: { servers: animeNumId, eps: epsNum },
    headers: { Referer: `${BASE_URL}/watch/${animeId}` },
  });

  const data = resp.data as { status: number; result?: string };
  const html = data.result ?? "";
  if (!html) {
    logger.warn({ episodeId: episode.id, type }, "server list returned no html");
    return [];
  }

  const $ = cheerio.load(html);
  const servers: Server[] = [];

  // Each type block: .type[data-type="sub"] / .type[data-type="dub"]
  $(".type").each((_, typeEl) => {
    const $type = $(typeEl);
    const serverType = ($type.attr("data-type") ?? type) as "sub" | "dub" | "raw";

    // Only fetch requested type (or all if raw)
    if (type !== "raw" && serverType !== type) return;

    $type.find("li[data-link-id]").each((_, li) => {
      const $li = $(li);
      const linkId = $li.attr("data-link-id") ?? "";
      const svId = $li.attr("data-sv-id") ?? "";
      const name = $li.text().trim() || svId;

      if (linkId) {
        servers.push({ id: linkId, name, type: serverType });
      }
    });
  });

  cacheSet(cacheKey, servers, 1800);
  logger.info({ animeId, ep, type, count: servers.length }, "servers fetched");
  return servers;
}

// ── Embed URL (Sources) ───────────────────────────────────────────────────────

export interface SourcesResult {
  url: string;
  skip_data?: {
    intro?: [number, number];
    outro?: [number, number];
  };
  sources?: unknown[];
  tracks?: unknown[];
}

export async function getEmbedUrl(
  linkId: string,
  refererAnimeId?: string
): Promise<SourcesResult | null> {
  logger.info({ linkId: linkId.slice(0, 40) }, "resolving embed URL from /ajax/sources");

  const resp = await ajaxClient.get("/ajax/sources", {
    params: { id: linkId },
    headers: {
      Referer: refererAnimeId
        ? `${BASE_URL}/watch/${refererAnimeId}`
        : BASE_URL,
    },
  });

  const data = resp.data as {
    status: number;
    result?: SourcesResult;
  };

  logger.debug(
    {
      status: data.status,
      url: data.result?.url?.slice(0, 80),
      sourcesCount: data.result?.sources?.length ?? 0,
    },
    "sources endpoint response"
  );

  if (!data.result?.url) {
    logger.warn({ linkId: linkId.slice(0, 40) }, "no URL in sources result");
    return null;
  }

  return data.result;
}
