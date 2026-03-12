/**
 * Tests for channels/core/reply.ts — extractReply and toPlainText.
 *
 * Covers string content, multipart content, image extraction (URL, data URI,
 * markdown images, MEDIA: lines), edge cases, and toPlainText formatting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractReply, toPlainText } from "@/server/channels/core/reply";

// ---------------------------------------------------------------------------
// extractReply — string content
// ---------------------------------------------------------------------------

test("reply: extractReply with string content returns text", () => {
  const result = extractReply({
    choices: [{ message: { content: "Hello world" } }],
  });
  assert.ok(result);
  assert.equal(result.text, "Hello world");
  assert.equal(result.images, undefined);
});

test("reply: extractReply normalizes whitespace", () => {
  const result = extractReply({
    choices: [{ message: { content: "  line1  \r\n  line2  \n\n\n\n  line3  " } }],
  });
  assert.ok(result);
  assert.equal(result.text, "line1\n  line2\n\n  line3");
});

test("reply: extractReply returns null for empty string", () => {
  const result = extractReply({
    choices: [{ message: { content: "   " } }],
  });
  assert.equal(result, null);
});

test("reply: extractReply returns null for missing choices", () => {
  assert.equal(extractReply({}), null);
  assert.equal(extractReply({ choices: [] }), null);
  assert.equal(extractReply({ choices: [{}] }), null);
  assert.equal(extractReply({ choices: [{ message: {} }] }), null);
});

test("reply: extractReply returns null for non-string non-array content", () => {
  const result = extractReply({
    choices: [{ message: { content: 42 } }],
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// extractReply — multipart content (array)
// ---------------------------------------------------------------------------

test("reply: extractReply with text parts concatenates them", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    }],
  });
  assert.ok(result);
  assert.equal(result.text, "Hello world");
});

test("reply: extractReply with image_url parts extracts images", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: [
          { type: "text", text: "Here is an image" },
          { type: "image_url", image_url: { url: "https://example.com/img.png" } },
        ],
      },
    }],
  });
  assert.ok(result);
  assert.equal(result.text, "Here is an image");
  assert.ok(result.images);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]!.kind, "url");
});

// ---------------------------------------------------------------------------
// extractReply — image extraction from text
// ---------------------------------------------------------------------------

test("reply: extractReply extracts MEDIA: lines", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: "Some text\nMEDIA: https://example.com/photo.jpg\nMore text",
      },
    }],
  });
  assert.ok(result);
  assert.ok(result.text.includes("Some text"));
  assert.ok(result.text.includes("More text"));
  assert.ok(!result.text.includes("MEDIA:"));
  assert.ok(result.images);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]!.kind, "url");
  if (result.images[0]!.kind === "url") {
    assert.equal(result.images[0]!.url, "https://example.com/photo.jpg");
  }
});

test("reply: extractReply extracts markdown images", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: "Check this out: ![alt text](https://example.com/img.png)",
      },
    }],
  });
  assert.ok(result);
  assert.ok(!result.text.includes("!["));
  assert.ok(result.images);
  assert.equal(result.images.length, 1);
  if (result.images[0]!.kind === "url") {
    assert.equal(result.images[0]!.url, "https://example.com/img.png");
    assert.equal(result.images[0]!.alt, "alt text");
  }
});

test("reply: extractReply parses base64 data URI images", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgo=";
  const result = extractReply({
    choices: [{
      message: {
        content: `MEDIA: ${dataUri}`,
      },
    }],
  });
  assert.ok(result);
  assert.ok(result.images);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]!.kind, "data");
  if (result.images[0]!.kind === "data") {
    assert.equal(result.images[0]!.mimeType, "image/png");
    assert.equal(result.images[0]!.base64, "iVBORw0KGgo=");
  }
});

test("reply: extractReply rejects data URI without base64 flag", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: "MEDIA: data:image/png,rawdata",
      },
    }],
  });
  // Without base64 flag, the data URI is treated as a URL image
  assert.ok(result);
  assert.ok(result.images);
  assert.equal(result.images[0]!.kind, "url");
});

test("reply: extractReply handles data URI with filename", () => {
  const dataUri = 'data:image/jpeg;filename="photo.jpg";base64,/9j/4AAQ';
  const result = extractReply({
    choices: [{
      message: {
        content: `MEDIA: ${dataUri}`,
      },
    }],
  });
  assert.ok(result);
  assert.ok(result.images);
  if (result.images[0]!.kind === "data") {
    assert.equal(result.images[0]!.filename, "photo.jpg");
  }
});

// ---------------------------------------------------------------------------
// extractReply — combined parts + text images
// ---------------------------------------------------------------------------

test("reply: extractReply combines image_url parts with text markdown images", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: [
          { type: "text", text: "![alt](https://a.com/1.png)" },
          { type: "image_url", image_url: { url: "https://b.com/2.png" } },
        ],
      },
    }],
  });
  assert.ok(result);
  assert.ok(result.images);
  assert.equal(result.images.length, 2);
});

// ---------------------------------------------------------------------------
// toPlainText
// ---------------------------------------------------------------------------

test("reply: toPlainText with text only", () => {
  const result = toPlainText({ text: "Hello world" });
  assert.equal(result, "Hello world");
});

test("reply: toPlainText with text and URL image", () => {
  const result = toPlainText({
    text: "Check this",
    images: [{ kind: "url", url: "https://example.com/img.png" }],
  });
  assert.equal(result, "Check this\nImage: https://example.com/img.png");
});

test("reply: toPlainText with text and data image", () => {
  const result = toPlainText({
    text: "See below",
    images: [{ kind: "data", mimeType: "image/png", base64: "abc" }],
  });
  assert.equal(result, "See below\nImage: [inline image/png]");
});

test("reply: toPlainText with no text but images", () => {
  const result = toPlainText({
    text: "",
    images: [{ kind: "url", url: "https://example.com/img.png" }],
  });
  assert.equal(result, "Image: https://example.com/img.png");
});

test("reply: toPlainText with multiple images", () => {
  const result = toPlainText({
    text: "Two pics",
    images: [
      { kind: "url", url: "https://a.com/1.png" },
      { kind: "data", mimeType: "image/jpeg", base64: "xyz" },
    ],
  });
  const lines = result.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Two pics");
  assert.equal(lines[1], "Image: https://a.com/1.png");
  assert.equal(lines[2], "Image: [inline image/jpeg]");
});
