// Image loading, scaling and eBay URL handling.
// Pure of DOM state so it can be exercised from test.html.

export function imageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = dataUrl;
  });
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * eBay serves every listing image from a path ending in a size token such as
 * `s-l225.jpg`. Rewriting that token yields a higher resolution variant of the
 * same image, which materially improves what the vision model can judge.
 */
export function ebayImageUrlAtSize(url, size = 500) {
  if (!url) return "";
  if (!/ebayimg\.com/i.test(url)) return url;
  return url.replace(/\/s-l\d+(\.[a-z]+)(?:\?.*)?$/i, `/s-l${size}$1`);
}

/**
 * Decode straight to an ImageBitmap.
 *
 * Much faster than the Image + data-URL round trip: no base64 encode, no
 * message hop through the service worker, and decoding happens off the main
 * thread. Used for the local pre-filter, which runs over every listing.
 */
export async function bitmapFromBlob(blob) {
  return createImageBitmap(blob);
}

/**
 * Fetch an image as a Blob directly from the panel.
 *
 * The panel holds host permissions for ebayimg.com, so routing through the
 * background worker only added a base64 encode and a message hop. Falls back to
 * the caller-supplied URL when a rewritten variant does not exist.
 */
export async function fetchImageBlob(url, fallbackUrl, signal) {
  const attempt = async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const abortExternal = () => controller.abort();
    signal?.addEventListener("abort", abortExternal, { once: true });
    try {
      const response = await fetch(target, { credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new Error("图片下载超时（6 秒）");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortExternal);
    }
  };
  try {
    return await attempt(url);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!fallbackUrl || fallbackUrl === url) throw error;
    return attempt(fallbackUrl);
  }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片编码失败"));
    reader.readAsDataURL(blob);
  });
}

/** Draw into a canvas of the given box, preserving aspect ratio. */
export async function resizeDataUrl(dataUrl, maxSize = 512, quality = 0.82) {
  const image = await imageElement(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Decode to a fixed square of raw pixels. Aspect ratio is preserved by letter-
 * boxing onto white, which matches how marketplace product shots are framed and
 * keeps the object's proportions intact for shape comparison.
 *
 * Accepts an ImageBitmap, an HTMLImageElement, or a data URL.
 */
export async function toPixelGrid(source, size) {
  const image = typeof source === "string" ? await imageElement(source) : source;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);

  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  const scale = Math.min(size / width, size / height);
  const drawWidth = Math.max(1, Math.round(width * scale));
  const drawHeight = Math.max(1, Math.round(height * scale));
  context.drawImage(
    image,
    Math.round((size - drawWidth) / 2),
    Math.round((size - drawHeight) / 2),
    drawWidth,
    drawHeight
  );

  return context.getImageData(0, 0, size, size).data;
}

/** Scale a bitmap down and JPEG-encode it for the vision model. */
export async function bitmapToDataUrl(bitmap, maxSize = 512, quality = 0.82) {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return blobToDataUrl(blob);
}
