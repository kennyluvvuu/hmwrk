/**
 * Photo intake from chat messages (I2): `image_url` data URLs → validated bytes → photo store.
 *
 * The module is pure except for the injected `PhotoSink`, so the store is a stub here; the real
 * `PhotoFiles` path is exercised end-to-end in `src/cycle.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { JPEG_BYTES, NOT_AN_IMAGE, PNG_BYTES } from "../store/testkit.js";
import {
  attachMessagePhotos,
  decodeDataUrlImage,
  decodeMessagePhotos,
  lastUserContent,
  photoAttachmentBlock,
  type PhotoSink,
} from "./images.js";

const PNG_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
const JPEG_URL = `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`;

describe("decodeDataUrlImage", () => {
  it("decodes a PNG and reports the detected mime", () => {
    const decoded = decodeDataUrlImage(PNG_URL);
    expect(typeof decoded).not.toBe("string");
    if (typeof decoded === "string") throw new Error(decoded);
    expect(decoded.mime).toBe("image/png");
    expect(decoded.bytes).toEqual(PNG_BYTES);
  });

  it("trusts the magic bytes, not the declared mime", () => {
    // A JPEG payload announced as «image/png» is stored as what it is.
    const lying = `data:image/png;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`;
    const decoded = decodeDataUrlImage(lying);
    if (typeof decoded === "string") throw new Error(decoded);
    expect(decoded.mime).toBe("image/jpeg");
  });

  it("refuses content that is not an image", () => {
    const notAnImage = `data:image/png;base64,${Buffer.from(NOT_AN_IMAGE).toString("base64")}`;
    expect(decodeDataUrlImage(notAnImage)).toMatch(/not JPEG, PNG or WebP/);
  });

  it("refuses remote URLs instead of fetching them (SSRF)", () => {
    expect(decodeDataUrlImage("https://example.test/photo.jpg")).toMatch(/remote image URLs are not fetched/);
  });

  it("enforces the size limit", () => {
    expect(decodeDataUrlImage(PNG_URL, { maxBytes: 10 })).toMatch(/the limit is 10/);
  });

  it("refuses an empty payload", () => {
    expect(decodeDataUrlImage("data:image/png;base64,")).toMatch(/empty/);
  });
});

describe("decodeMessagePhotos", () => {
  it("ignores text-only content", () => {
    expect(decodeMessagePhotos("просто текст")).toEqual({ photos: [], problems: [] });
  });

  it("collects images and reports the broken ones", () => {
    const batch = decodeMessagePhotos([
      { type: "text", text: "фото тетради" },
      { type: "image_url", image_url: { url: PNG_URL } },
      { type: "image_url", image_url: { url: "https://example.test/x.png" } },
    ]);
    expect(batch.photos).toHaveLength(1);
    expect(batch.problems).toHaveLength(1);
    expect(batch.problems[0]).toContain("part 2");
  });
});

describe("attachMessagePhotos", () => {
  function fakeSink(): PhotoSink & { readonly saved: { kind: string; mime?: string; size: number }[] } {
    const saved: { kind: string; mime?: string; size: number }[] = [];
    let next = 0;
    return {
      saved,
      async save(input) {
        saved.push({ kind: input.kind, ...(input.mime === undefined ? {} : { mime: input.mime }), size: input.bytes.byteLength });
        next += 1;
        return { id: `photo-${next}` };
      },
    };
  }

  it("stores every decoded photo as a check-in photo", async () => {
    const sink = fakeSink();
    const result = await attachMessagePhotos(
      [
        { type: "image_url", image_url: { url: PNG_URL } },
        { type: "image_url", image_url: { url: JPEG_URL } },
      ],
      { sink },
    );

    expect(result.ids).toEqual(["photo-1", "photo-2"]);
    expect(result.problems).toEqual([]);
    expect(sink.saved).toEqual([
      { kind: "checkin", mime: "image/png", size: PNG_BYTES.byteLength },
      { kind: "checkin", mime: "image/jpeg", size: JPEG_BYTES.byteLength },
    ]);
  });

  it("keeps the message when the store fails on one photo", async () => {
    let calls = 0;
    const sink: PhotoSink = {
      async save() {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
        return { id: "photo-2" };
      },
    };
    const result = await attachMessagePhotos(
      [
        { type: "image_url", image_url: { url: PNG_URL } },
        { type: "image_url", image_url: { url: JPEG_URL } },
      ],
      { sink },
    );
    expect(result.ids).toEqual(["photo-2"]);
    expect(result.problems[0]).toContain("disk full");
  });
});

describe("lastUserContent and the prompt block", () => {
  it("picks the last user message", () => {
    const content = lastUserContent([
      { role: "assistant", content: "привет" },
      { role: "user", content: "первое" },
      { role: "assistant", content: "ага" },
      { role: "user", content: "второе" },
    ]);
    expect(content).toBe("второе");
  });

  it("renders the photo ids the agent passes to submit_check_in", () => {
    expect(photoAttachmentBlock([])).toBe("");
    expect(photoAttachmentBlock(["p1", "p2"])).toContain("p1, p2");
    expect(photoAttachmentBlock(["p1"])).toContain("photo_ids");
  });
});
