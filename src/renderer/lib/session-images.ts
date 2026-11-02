import type { PromptImage, SessionImage } from "../../shared/types";
import { imageDataUrl } from "../../shared/images";
import { desktop } from "../api";

const cache = new Map<string, { promise: Promise<string>; bytes: number }>();
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
let cacheBytes = 0;

/** Coalesce visible requests and retain a bounded cache across session/branch switches. */
export function sessionImageUrl(image: SessionImage, thumbnail = false): Promise<string> {
  if (!("reference" in image)) return Promise.resolve(imageDataUrl(image));
  const key = JSON.stringify([image.reference, thumbnail]);
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key); cache.set(key, existing);
    return existing.promise;
  }
  const item = { bytes: 0, promise: Promise.resolve("") };
  item.promise = desktop.invoke<PromptImage>("session.image", { ...image.reference, thumbnail }).then(result => {
    const url = imageDataUrl(result);
    if (cache.get(key) === item) {
      item.bytes = url.length * 2;
      cacheBytes += item.bytes;
      trimCache();
    }
    return url;
  }).catch(error => { if (cache.get(key) === item) cache.delete(key); throw error; });
  cache.set(key, item);
  trimCache();
  return item.promise;
}
function trimCache() {
  while (cache.size > 128 || cacheBytes > MAX_CACHE_BYTES) {
    const key = cache.keys().next().value!;
    cacheBytes -= cache.get(key)!.bytes;
    cache.delete(key);
  }
}

/** A retried prompt must send actual image bytes back to Pi. */
export async function sessionImageData(image: SessionImage): Promise<PromptImage> {
  if (!("reference" in image)) return image;
  const url = await sessionImageUrl(image);
  return { type: "image", mimeType: image.mimeType, data: url.slice(url.indexOf(",") + 1) };
}
