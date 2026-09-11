function handleTrpcMediaUrls(trpcUrl, bodyText, sendEntries) {
  try {
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;
    const urlMap = {};
    for (const rawUrl of matches) {
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }
    const entries = Object.values(urlMap);
    if (!entries.length) return;
    console.log(`[FlowAgent] Captured ${entries.length} fresh media URLs from TRPC`);
    sendEntries(entries);
  } catch (e) {
    console.error('[FlowAgent] Failed to extract TRPC media URLs:', e);
  }
}
