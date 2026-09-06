import type { PromptImage } from "./types.js";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 8;

export function isPromptImage(value: unknown): value is PromptImage {
  const image = value as PromptImage | null;
  return !!image && image.type === "image" && IMAGE_MIME_TYPES.includes(image.mimeType)
    && typeof image.data === "string" && image.data.length > 0;
}

export function validatePromptImages(value: unknown): PromptImage[] {
  if (!Array.isArray(value) || value.length > MAX_PROMPT_IMAGES)
    throw new Error(`Attach up to ${MAX_PROMPT_IMAGES} images.`);
  let total = 0;
  return value.map((image: unknown) => {
    if (!isPromptImage(image)) throw new Error("Images must be PNG, JPEG, WebP or GIF.");
    const data = image.data;
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      throw new Error("Each image must be 5 MB or smaller.");
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw new Error("Invalid base64 image data.");
    const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (size > MAX_IMAGE_BYTES) throw new Error("Each image must be 5 MB or smaller.");
    total += size;
    if (total > MAX_PROMPT_IMAGE_BYTES) throw new Error("Images must total 10 MB or less.");
    return { type: "image", mimeType: image.mimeType, data };
  });
}

export function imageDataUrl(image: PromptImage) {
  return `data:${image.mimeType};base64,${image.data}`;
}
