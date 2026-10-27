import { nativeImage } from "electron";
import type { PromptImage } from "../shared/types.js";

/** Twice the chat thumbnail's CSS size, retaining aspect ratio and small originals. */
export function imageThumbnail(image: PromptImage): PromptImage {
  const original = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
  if (original.isEmpty()) return image;
  const { width, height } = original.getSize();
  const scale = Math.min(1, 192 / width, 152 / height);
  const thumbnail = scale < 1 ? original.resize({ width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)), quality: "good" }) : original;
  return { type: "image", mimeType: "image/png", data: thumbnail.toPNG().toString("base64") };
}
