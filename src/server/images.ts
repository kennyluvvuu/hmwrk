/**
 * Photos attached to an OpenWebUI message (SPEC §5.4, M2 step 3 of the I2 brief).
 *
 * OpenWebUI sends uploads as `image_url` parts with a `data:<mime>;base64,…` URL (K10). The model
 * never has to *see* them: the agent runs on a text model, so the bytes go to the photo store and
 * the agent receives their **ids**, which it passes to `submit_check_in` (`photo_ids`). That is why
 * this module decodes, validates and saves, but never builds pi-durable image blocks.
 *
 * Validation, in the order that fails cheapest:
 * 1. the URL must be a `data:` URL with `;base64` (remote URLs are refused — the core must not
 *    become an SSRF proxy, K10);
 * 2. decoded size ≤ {@link PHOTO_MAX_BYTES} (8 MiB);
 * 3. the **magic bytes** must be jpeg/png/webp (`detectPhotoFormat`, the store's own check), and the
 *    MIME we store is the detected one, never the caller's claim.
 *
 * Anything that fails is a `problem` string for a `warn` line, not a failed request: a broken image
 * in a chat message is not a reason to lose the message.
 */

import type { ChatContent, ChatMessage } from "../contracts/openai.js";
import { PHOTO_FORMATS, PHOTO_MAX_BYTES, detectPhotoFormat } from "../store/photo-files.js";
import type { PhotoKind } from "../domain/index.js";

/** One decoded, validated image, ready for the photo store. */
export interface DecodedPhoto {
  readonly bytes: Uint8Array;
  /** Detected MIME (`image/jpeg` / `image/png` / `image/webp`). */
  readonly mime: string;
}

export interface DecodePhotosResult {
  readonly photos: readonly DecodedPhoto[];
  /** Human-readable reasons for the parts that were dropped (logged, never returned to the client). */
  readonly problems: readonly string[];
}

export interface DecodePhotosOptions {
  /** Size limit of one decoded image; default {@link PHOTO_MAX_BYTES}. */
  readonly maxBytes?: number;
}

/** `data:<mime>[;param];base64,<payload>` — the only URL shape we accept. */
const DATA_URL = /^data:([^;,]+)?(?:;[^;,]+)*;base64,(.*)$/s;

/** Decode one `data:` URL; returns a problem string instead of throwing. */
export function decodeDataUrlImage(url: string, options: DecodePhotosOptions = {}): DecodedPhoto | string {
  const match = DATA_URL.exec(url);
  if (match === null) {
    return url.startsWith("http://") || url.startsWith("https://")
      ? "remote image URLs are not fetched; attach the file instead"
      : "unsupported image URL (expected a data: URL with base64 payload)";
  }

  const payload = match[2] ?? "";
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(payload, "base64"));
  } catch (error) {
    return `image payload is not valid base64: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (bytes.byteLength === 0) return "image payload is empty";

  const maxBytes = options.maxBytes ?? PHOTO_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    return `image is ${bytes.byteLength} bytes, the limit is ${maxBytes}`;
  }

  const format = detectPhotoFormat(bytes);
  if (format === null) return "image content is not JPEG, PNG or WebP (checked by magic bytes)";

  return { bytes, mime: PHOTO_FORMATS[format].mime };
}

/**
 * All image parts of one message content, decoded. Text-only content yields an empty batch.
 *
 * Only the last user message is scanned: that is what `mapMessagesToInput` submits, and an image
 * from three turns ago is not an attachment of the current request.
 */
export function decodeMessagePhotos(content: ChatContent, options: DecodePhotosOptions = {}): DecodePhotosResult {
  if (typeof content === "string") return { photos: [], problems: [] };

  const photos: DecodedPhoto[] = [];
  const problems: string[] = [];
  content.forEach((part, index) => {
    if (part.type !== "image_url") return;
    const decoded = decodeDataUrlImage(part.image_url.url, options);
    if (typeof decoded === "string") problems.push(`part ${index}: ${decoded}`);
    else photos.push(decoded);
  });
  return { photos, problems };
}

/** The last user message of a request (the one that is submitted as durable input). */
export function lastUserContent(messages: readonly ChatMessage[]): ChatContent | undefined {
  return [...messages].reverse().find((message) => message.role === "user")?.content;
}

/** Narrow port of `PhotoFiles.save` (D2) that the HTTP layer needs. */
export interface PhotoSink {
  save(input: { kind: PhotoKind; bytes: Uint8Array; mime?: string }): Promise<{ id: string }>;
}

export interface AttachPhotosOptions {
  readonly sink: PhotoSink;
  readonly kind?: PhotoKind;
  readonly maxBytes?: number;
}

export interface AttachedPhotos {
  /** Ids of the stored photos, in message order. */
  readonly ids: readonly string[];
  /** Why some parts were dropped (already logged by the caller). */
  readonly problems: readonly string[];
}

/**
 * Decode + store the photos of one message.
 *
 * A store failure (disk, a corrupt row) is caught per photo: the message still reaches the agent,
 * the agent simply has one id fewer to pass to `submit_check_in`.
 */
export async function attachMessagePhotos(
  content: ChatContent,
  options: AttachPhotosOptions,
): Promise<AttachedPhotos> {
  const decoded = decodeMessagePhotos(content, {
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const problems: string[] = [...decoded.problems];
  const ids: string[] = [];

  for (const [index, photo] of decoded.photos.entries()) {
    try {
      const saved = await options.sink.save({
        kind: options.kind ?? "checkin",
        bytes: photo.bytes,
        mime: photo.mime,
      });
      ids.push(saved.id);
    } catch (error) {
      problems.push(`photo ${index}: could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ids, problems };
}

/**
 * The line appended to the user text so the agent knows the photo ids, e.g.
 *
 * ```
 * [к сообщению прикреплены фото: 9f1c…, 4b2e… — передай их в submit_check_in как photo_ids]
 * ```
 *
 * Empty string when no photo was stored (the message is submitted unchanged).
 */
export function photoAttachmentBlock(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  return `[к сообщению прикреплены фото: ${ids.join(", ")} — передай их в submit_check_in как photo_ids]`;
}
