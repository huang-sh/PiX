import type { RawSessionEntry, SessionImage, SessionSnapshot } from "./types.js";
import { isPromptImage } from "./images.js";
import { createHash } from "node:crypto";

/** Keep SDK/persisted data intact; only desktop history crosses the wire as references. */
export function sessionImageEncoder() {
  const sources = new WeakMap<RawSessionEntry[], { session: string; epoch?: string; entries: RawSessionEntry[]; images: Map<string, SessionImage[]> }>();
  const projections = new WeakMap<object, { source: object; projection: SessionSnapshot["projection"] }>();
  function snapshot(value: SessionSnapshot): SessionSnapshot {
    const session = value.session.path;
    if (!session) return value;
    let source = sources.get(value.entries);
    if (!source || source.session !== session || source.epoch !== value.graph?.epoch) {
      const images = new Map<string, SessionImage[]>();
      const entries = value.entries.map(entry => {
        const message = entry.message as { content?: unknown } | undefined;
        if (!Array.isArray(message?.content)) return entry;
        let changed = false;
        const messageImages: SessionImage[] = [];
        const content = message.content.map((image: unknown, index: number) => {
          if (!isPromptImage(image)) return image;
          changed = true;
          // Read-only sessions have no runtime epoch. Content identity prevents
          // a reopen or a different remote host from reusing stale image bytes.
          const digest = value.graph?.epoch ? undefined : createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
          const reference: SessionImage = { type: "image", mimeType: image.mimeType, reference: {
            session, entryId: entry.id, index, epoch: value.graph?.epoch, ...(digest ? { digest } : {}),
          } };
          messageImages.push(reference);
          return reference;
        });
        if (!changed) return entry;
        images.set(entry.id, messageImages);
        return { ...entry, message: { ...message, content } };
      });
      source = { session, epoch: value.graph?.epoch, entries, images };
      sources.set(value.entries, source);
    }
    const cached = projections.get(value.projection);
    let projection = cached?.source === source ? cached.projection : undefined;
    if (!projection) {
      const images = source.images;
      projection = { ...value.projection, messages: value.projection.messages.map(message => !message.images?.length ? message : {
        ...message, images: message.images.map((image, index) => images.get(message.entryId)?.[index] ?? image),
      }) };
      projections.set(value.projection, { source, projection });
    }
    return { ...value, entries: source.entries, projection };
  }
  function encode<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (object.session && Array.isArray(object.entries) && object.projection && object.runtime)
      return snapshot(value as unknown as SessionSnapshot) as T;
    if (object.current) return { ...object, current: encode(object.current) } as T;
    if (object.type === "sessions" && object.payload)
      return { ...object, payload: encode(object.payload) } as T;
    return value;
  }
  return encode;
}
