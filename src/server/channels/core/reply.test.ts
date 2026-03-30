/**
 * Tests for channels/core/reply.ts — extractReply and toPlainText.
 *
 * Covers string content, multipart content, image extraction (URL, data URI,
 * markdown images, MEDIA: lines), edge cases, and toPlainText formatting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractReply, inferMediaType, toPlainText } from "@/server/channels/core/reply";

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

// ---------------------------------------------------------------------------
// inferMediaType
// ---------------------------------------------------------------------------

test("reply: inferMediaType classifies image extensions", () => {
  assert.equal(inferMediaType("chart.png"), "image");
  assert.equal(inferMediaType("photo.jpg"), "image");
  assert.equal(inferMediaType("icon.webp"), "image");
});

test("reply: inferMediaType classifies audio extensions", () => {
  assert.equal(inferMediaType("answer.mp3"), "audio");
  assert.equal(inferMediaType("clip.wav"), "audio");
  assert.equal(inferMediaType("voice.m4a"), "audio");
  assert.equal(inferMediaType("song.ogg"), "audio");
});

test("reply: inferMediaType classifies video extensions", () => {
  assert.equal(inferMediaType("demo.mp4"), "video");
  assert.equal(inferMediaType("screen.webm"), "video");
  assert.equal(inferMediaType("clip.mov"), "video");
});

test("reply: inferMediaType classifies unknown extensions as file", () => {
  assert.equal(inferMediaType("report.pdf"), "file");
  assert.equal(inferMediaType("data.csv"), "file");
  assert.equal(inferMediaType("archive.zip"), "file");
});

test("reply: inferMediaType prefers MIME type over extension", () => {
  assert.equal(inferMediaType("noext", "audio/mpeg"), "audio");
  assert.equal(inferMediaType("noext", "video/mp4"), "video");
  assert.equal(inferMediaType("noext", "image/png"), "image");
});

// ---------------------------------------------------------------------------
// inferMediaType — path-shape invariance
//
// inferMediaType must classify correctly regardless of whether the reference
// is a bare filename (e.g. "out.mp3") or a slash-containing path (e.g.
// "/workspace/out.mp3"). Path safety filtering happens downstream in the
// driver's isSafeFilename, not here.
// ---------------------------------------------------------------------------

test("reply: inferMediaType classifies bare filenames and absolute paths identically", () => {
  assert.equal(inferMediaType("out.mp3"), "audio");
  assert.equal(inferMediaType("/workspace/out.mp3"), "audio");
  assert.equal(inferMediaType("chart.png"), "image");
  assert.equal(inferMediaType("/workspace/chart.png"), "image");
  assert.equal(inferMediaType("demo.mp4"), "video");
  assert.equal(inferMediaType("/workspace/demo.mp4"), "video");
  assert.equal(inferMediaType("report.pdf"), "file");
  assert.equal(inferMediaType("/workspace/report.pdf"), "file");
});

// ---------------------------------------------------------------------------
// extractReply — generic media (MEDIA: lines)
// ---------------------------------------------------------------------------

test("reply: extractReply classifies MEDIA: .png as image with backward-compat images", () => {
  const result = extractReply({
    choices: [{ message: { content: "Done.\nMEDIA: chart.png" } }],
  });
  assert.ok(result);
  assert.equal(result.text, "Done.");
  assert.ok(result.media);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]!.type, "image");
  assert.equal(result.media[0]!.source.kind, "url");
  if (result.media[0]!.source.kind === "url") {
    assert.equal(result.media[0]!.source.url, "chart.png");
  }
  // backward compat: images should also be populated for image types
  assert.ok(result.images);
  assert.equal(result.images.length, 1);
});

test("reply: extractReply classifies MEDIA: .mp3 as audio", () => {
  const result = extractReply({
    choices: [{ message: { content: "MEDIA: summary.mp3" } }],
  });
  assert.ok(result);
  assert.ok(result.media);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]!.type, "audio");
  // audio should NOT be in legacy images
  assert.equal(result.images, undefined);
});

test("reply: extractReply classifies MEDIA: .mp4 as video", () => {
  const result = extractReply({
    choices: [{ message: { content: "MEDIA: run.mp4" } }],
  });
  assert.ok(result);
  assert.ok(result.media);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]!.type, "video");
  assert.equal(result.images, undefined);
});

test("reply: extractReply classifies MEDIA: .pdf as file", () => {
  const result = extractReply({
    choices: [{ message: { content: "MEDIA: report.pdf" } }],
  });
  assert.ok(result);
  assert.ok(result.media);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]!.type, "file");
  assert.equal(result.images, undefined);
});

test("reply: extractReply handles mixed media types", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: "Done.\nMEDIA: chart.png\nMEDIA: summary.mp3\nMEDIA: run.mp4\nMEDIA: report.pdf",
      },
    }],
  });
  assert.ok(result);
  assert.equal(result.text, "Done.");
  assert.ok(result.media);
  assert.equal(result.media.length, 4);
  assert.equal(result.media[0]!.type, "image");
  assert.equal(result.media[1]!.type, "audio");
  assert.equal(result.media[2]!.type, "video");
  assert.equal(result.media[3]!.type, "file");
  // only images go to legacy field
  assert.ok(result.images);
  assert.equal(result.images.length, 1);
});

test("reply: extractReply infers media type from data URI MIME", () => {
  const audioUri = "data:audio/mpeg;base64,SUQzBAAAAAAA";
  const result = extractReply({
    choices: [{ message: { content: `MEDIA: ${audioUri}` } }],
  });
  assert.ok(result);
  assert.ok(result.media);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0]!.type, "audio");
  assert.equal(result.media[0]!.source.kind, "data");
  if (result.media[0]!.source.kind === "data") {
    assert.equal(result.media[0]!.source.mimeType, "audio/mpeg");
    assert.equal(result.media[0]!.source.base64, "SUQzBAAAAAAA");
  }
});

test("reply: extractReply preserves filename from data URI in media", () => {
  const dataUri = 'data:video/mp4;filename="clip.mp4";base64,AAAAIGZ0eXA=';
  const result = extractReply({
    choices: [{ message: { content: `MEDIA: ${dataUri}` } }],
  });
  assert.ok(result);
  assert.ok(result.media);
  assert.equal(result.media[0]!.type, "video");
  assert.equal(result.media[0]!.source.kind, "data");
  if (result.media[0]!.source.kind === "data") {
    assert.equal(result.media[0]!.source.filename, "clip.mp4");
  }
});

// ---------------------------------------------------------------------------
// extractReply — path-shape pass-through
//
// extractReply does NOT filter paths; it preserves whatever reference the
// gateway emits. The driver's resolveSandboxMedia is responsible for deciding
// which references are safe to fetch. This test documents that both bare
// filenames and slash-containing paths survive extraction unchanged so the
// downstream safety check can run on the original value.
// ---------------------------------------------------------------------------

test("reply: extractReply preserves slash-containing MEDIA references for downstream safety filtering", () => {
  const result = extractReply({
    choices: [{
      message: {
        content: "MEDIA: /workspace/out.mp3\nMEDIA: out.mp3",
      },
    }],
  });
  assert.ok(result);
  assert.ok(result.media);
  assert.equal(result.media.length, 2);
  // Both are passed through as URL sources
  assert.equal(result.media[0]!.source.kind, "url");
  assert.equal(result.media[1]!.source.kind, "url");
  if (result.media[0]!.source.kind === "url") {
    assert.equal(result.media[0]!.source.url, "/workspace/out.mp3");
  }
  if (result.media[1]!.source.kind === "url") {
    assert.equal(result.media[1]!.source.url, "out.mp3");
  }
  // Both are classified as audio regardless of path shape
  assert.equal(result.media[0]!.type, "audio");
  assert.equal(result.media[1]!.type, "audio");
});

// ---------------------------------------------------------------------------
// toPlainText — generic media
// ---------------------------------------------------------------------------

test("reply: toPlainText uses media labels when media is present", () => {
  const result = toPlainText({
    text: "Results",
    media: [
      { type: "image", source: { kind: "url", url: "chart.png" } },
      { type: "audio", source: { kind: "url", url: "answer.mp3" } },
      { type: "video", source: { kind: "data", mimeType: "video/mp4", base64: "abc" } },
      { type: "file", source: { kind: "url", url: "report.pdf" } },
    ],
  });
  const lines = result.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "Results");
  assert.equal(lines[1], "Image: chart.png");
  assert.equal(lines[2], "Audio: answer.mp3");
  assert.equal(lines[3], "Video: [inline video/mp4]");
  assert.equal(lines[4], "File: report.pdf");
});
