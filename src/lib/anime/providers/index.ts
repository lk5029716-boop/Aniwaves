import { logger } from "../../logger.js";
import { extractVidplay, isVidplayHost } from "./vidplay.js";
import { extractMegacloud, isMegacloudHost } from "./megacloud.js";
import { extractEchovideo, isEchovideoHost } from "./echovideo.js";
import type { StreamSource } from "../types.js";

export async function extractStream(
  embedUrl: string,
  serverName: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const lowerName = serverName.toLowerCase();

  logger.info(
    { embedUrl: embedUrl.slice(0, 80), serverName },
    "dispatching to provider extractor"
  );

  // Echovideo (Aniwaves primary provider)
  if (
    isEchovideoHost(embedUrl) ||
    lowerName.includes("echo")
  ) {
    logger.info({ serverName }, "routing to Echovideo extractor");
    return extractEchovideo(embedUrl, skipData);
  }

  // MegaCloud / RapidCloud / RabbitStream
  if (
    isMegacloudHost(embedUrl) ||
    lowerName.includes("megacloud") ||
    lowerName.includes("rapidcloud") ||
    lowerName.includes("rabbitstream") ||
    lowerName.includes("byfms") ||
    lowerName.includes("dghg")
  ) {
    logger.info({ serverName }, "routing to MegaCloud extractor");
    return extractMegacloud(embedUrl);
  }

  // Vidplay and its mirrors
  if (
    isVidplayHost(embedUrl) ||
    lowerName.includes("vidplay") ||
    lowerName.includes("vidcloud") ||
    lowerName.includes("mcloud")
  ) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }

  // Unknown provider — try embed-N pattern (Echovideo-style) first, then vidplay, then megacloud
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 80) },
    "unknown provider, trying all extractors in order"
  );

  const echoResult = await extractEchovideo(embedUrl, skipData);
  if (echoResult?.m3u8) return echoResult;

  const vidplayResult = await extractVidplay(embedUrl);
  if (vidplayResult?.m3u8) return vidplayResult;

  const megacloudResult = await extractMegacloud(embedUrl);
  if (megacloudResult?.m3u8) return megacloudResult;

  logger.error({ serverName, embedUrl: embedUrl.slice(0, 80) }, "all extractors failed");
  return null;
}
