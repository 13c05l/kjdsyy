function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Clicking the toolbar icon opens the side panel instead of a popup, so the
// panel survives clicks on the page and long-running analysis is not aborted.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

async function fetchAsDataUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(url, { credentials: "omit", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("图片下载超时（10 秒）");
    throw error;
  }
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("图片下载超时（10 秒）");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fetch-image" || !message.url) return undefined;

  // message.fallbackUrl lets the caller ask for a large eBay variant first and
  // silently fall back to the thumbnail the page actually rendered.
  fetchAsDataUrl(message.url)
    .catch((error) => {
      if (!message.fallbackUrl || message.fallbackUrl === message.url) throw error;
      return fetchAsDataUrl(message.fallbackUrl);
    })
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));

  return true;
});
