/**
 * Tests for channels/driver.ts — sandbox media resolution.
 *
 * Covers image, audio, video, and file resolution from sandbox candidate
 * paths, rejection of unsafe filenames, oversized artifacts, and
 * preservation of HTTPS URLs and data URIs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelReply, ReplyMedia } from "@/server/channels/core/types";
import {
  inferMimeTypeFromFilename,
  isSafeFilename,
  isSandboxRelativePath,
  resolveFilenameFromSandbox,
  resolveSandboxMedia,
  SANDBOX_CANDIDATE_DIRS,
} from "@/server/channels/driver";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeSandbox(files: Record<string, Buffer>) {
  return {
    readFileToBuffer({ path }: { path: string }) {
      const buf = files[path];
      if (!buf) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(buf);
    },
  };
}

function png1x1(): Buffer {
  // Minimal valid-ish PNG bytes (just enough for testing)
  return Buffer.from("iVBORw0KGgo=", "base64");
}

function mp3Stub(): Buffer {
  return Buffer.from("SUQzBAAAAAAA", "base64");
}

function mp4Stub(): Buffer {
  return Buffer.from("AAAAIGZ0eXA=", "base64");
}

function pdfStub(): Buffer {
  return Buffer.from("JVBERi0xLjQK", "base64");
}

// ---------------------------------------------------------------------------
// isSandboxRelativePath
// ---------------------------------------------------------------------------

test("driver: isSandboxRelativePath identifies bare filenames", () => {
  assert.ok(isSandboxRelativePath("chart.png"));
  assert.ok(isSandboxRelativePath("answer.mp3"));
});

test("driver: isSandboxRelativePath rejects HTTPS URLs", () => {
  assert.ok(!isSandboxRelativePath("https://example.com/img.png"));
});

test("driver: isSandboxRelativePath rejects data URIs", () => {
  assert.ok(!isSandboxRelativePath("data:image/png;base64,abc"));
});

// ---------------------------------------------------------------------------
// isSafeFilename
// ---------------------------------------------------------------------------

test("driver: isSafeFilename allows alphanumeric with dots, dashes, underscores", () => {
  assert.ok(isSafeFilename("chart.png"));
  assert.ok(isSafeFilename("csv-to-chart-1-chart.png"));
  assert.ok(isSafeFilename("my_file.mp3"));
});

test("driver: isSafeFilename rejects path separators", () => {
  assert.ok(!isSafeFilename("../etc/passwd"));
  assert.ok(!isSafeFilename("foo/bar.png"));
});

test("driver: isSafeFilename rejects dotfiles", () => {
  assert.ok(!isSafeFilename(".hidden"));
});

test("driver: isSafeFilename rejects spaces and special chars", () => {
  assert.ok(!isSafeFilename("my file.png"));
  assert.ok(!isSafeFilename("file;rm -rf.png"));
});

// ---------------------------------------------------------------------------
// inferMimeTypeFromFilename
// ---------------------------------------------------------------------------

test("driver: inferMimeTypeFromFilename covers image types", () => {
  assert.equal(inferMimeTypeFromFilename("a.png"), "image/png");
  assert.equal(inferMimeTypeFromFilename("a.jpg"), "image/jpeg");
  assert.equal(inferMimeTypeFromFilename("a.jpeg"), "image/jpeg");
  assert.equal(inferMimeTypeFromFilename("a.gif"), "image/gif");
  assert.equal(inferMimeTypeFromFilename("a.webp"), "image/webp");
  assert.equal(inferMimeTypeFromFilename("a.svg"), "image/svg+xml");
});

test("driver: inferMimeTypeFromFilename covers audio types", () => {
  assert.equal(inferMimeTypeFromFilename("a.mp3"), "audio/mpeg");
  assert.equal(inferMimeTypeFromFilename("a.wav"), "audio/wav");
  assert.equal(inferMimeTypeFromFilename("a.m4a"), "audio/mp4");
  assert.equal(inferMimeTypeFromFilename("a.ogg"), "audio/ogg");
});

test("driver: inferMimeTypeFromFilename covers video types", () => {
  assert.equal(inferMimeTypeFromFilename("a.mp4"), "video/mp4");
  assert.equal(inferMimeTypeFromFilename("a.mov"), "video/quicktime");
  assert.equal(inferMimeTypeFromFilename("a.webm"), "video/webm");
});

test("driver: inferMimeTypeFromFilename covers document types", () => {
  assert.equal(inferMimeTypeFromFilename("a.pdf"), "application/pdf");
});

test("driver: inferMimeTypeFromFilename returns octet-stream for unknown", () => {
  assert.equal(inferMimeTypeFromFilename("a.xyz"), "application/octet-stream");
});

// ---------------------------------------------------------------------------
// SANDBOX_CANDIDATE_DIRS includes worker output directory
// ---------------------------------------------------------------------------

test("driver: candidate dirs include .openclaw/generated/worker/", () => {
  assert.ok(
    SANDBOX_CANDIDATE_DIRS.some((d) => d.includes(".openclaw/generated/worker")),
  );
});

// ---------------------------------------------------------------------------
// resolveFilenameFromSandbox
// ---------------------------------------------------------------------------

test("driver: resolveFilenameFromSandbox finds image in home dir", async () => {
  const sandbox = makeFakeSandbox({
    "/home/vercel-sandbox/chart.png": png1x1(),
  });
  const result = await resolveFilenameFromSandbox(sandbox as never, "chart.png");
  assert.ok(result);
  assert.equal(result.kind, "data");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.filename, "chart.png");
});

test("driver: resolveFilenameFromSandbox finds audio in worker dir", async () => {
  const sandbox = makeFakeSandbox({
    "/home/vercel-sandbox/.openclaw/generated/worker/answer.mp3": mp3Stub(),
  });
  const result = await resolveFilenameFromSandbox(sandbox as never, "answer.mp3");
  assert.ok(result);
  assert.equal(result.kind, "data");
  assert.equal(result.mimeType, "audio/mpeg");
});

test("driver: resolveFilenameFromSandbox finds video in tmp", async () => {
  const sandbox = makeFakeSandbox({
    "/tmp/demo.mp4": mp4Stub(),
  });
  const result = await resolveFilenameFromSandbox(sandbox as never, "demo.mp4");
  assert.ok(result);
  assert.equal(result.kind, "data");
  assert.equal(result.mimeType, "video/mp4");
});

test("driver: resolveFilenameFromSandbox finds file (pdf)", async () => {
  const sandbox = makeFakeSandbox({
    "/home/vercel-sandbox/Downloads/report.pdf": pdfStub(),
  });
  const result = await resolveFilenameFromSandbox(sandbox as never, "report.pdf");
  assert.ok(result);
  assert.equal(result.kind, "data");
  assert.equal(result.mimeType, "application/pdf");
});

test("driver: resolveFilenameFromSandbox returns null when not found", async () => {
  const sandbox = makeFakeSandbox({});
  const result = await resolveFilenameFromSandbox(sandbox as never, "missing.png");
  assert.equal(result, null);
});

test("driver: resolveFilenameFromSandbox rejects oversized files", async () => {
  const big = Buffer.alloc(21 * 1024 * 1024); // 21 MB > 20 MB limit
  const sandbox = makeFakeSandbox({
    "/home/vercel-sandbox/huge.mp4": big,
  });
  const result = await resolveFilenameFromSandbox(sandbox as never, "huge.mp4");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// resolveSandboxMedia — integration with sandbox controller mock
// ---------------------------------------------------------------------------

test("driver: resolveSandboxMedia resolves image in legacy images array", async () => {
  const imgData = png1x1();
  const fakeSandbox = makeFakeSandbox({
    "/home/vercel-sandbox/chart.png": imgData,
  });
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Done.",
    images: [{ kind: "url", url: "chart.png" }],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.ok(resolved.images);
  assert.equal(resolved.images.length, 1);
  assert.equal(resolved.images[0]!.kind, "data");
  if (resolved.images[0]!.kind === "data") {
    assert.equal(resolved.images[0]!.mimeType, "image/png");
    assert.equal(resolved.images[0]!.filename, "chart.png");
  }
});

test("driver: resolveSandboxMedia resolves audio in media array", async () => {
  const audioData = mp3Stub();
  const fakeSandbox = makeFakeSandbox({
    "/home/vercel-sandbox/.openclaw/generated/worker/narration.mp3": audioData,
  });
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Here is the audio.",
    media: [
      { type: "audio", source: { kind: "url", url: "narration.mp3" } },
    ],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.ok(resolved.media);
  assert.equal(resolved.media.length, 1);
  assert.equal(resolved.media[0]!.type, "audio");
  assert.equal(resolved.media[0]!.source.kind, "data");
  if (resolved.media[0]!.source.kind === "data") {
    assert.equal(resolved.media[0]!.source.mimeType, "audio/mpeg");
    assert.equal(resolved.media[0]!.source.filename, "narration.mp3");
  }
});

test("driver: resolveSandboxMedia resolves video in media array", async () => {
  const videoData = mp4Stub();
  const fakeSandbox = makeFakeSandbox({
    "/tmp/render.mp4": videoData,
  });
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Video ready.",
    media: [
      { type: "video", source: { kind: "url", url: "render.mp4" } },
    ],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.ok(resolved.media);
  assert.equal(resolved.media[0]!.type, "video");
  assert.equal(resolved.media[0]!.source.kind, "data");
});

test("driver: resolveSandboxMedia resolves file (pdf) in media array", async () => {
  const pdfData = pdfStub();
  const fakeSandbox = makeFakeSandbox({
    "/home/vercel-sandbox/Desktop/report.pdf": pdfData,
  });
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Report attached.",
    media: [
      { type: "file", source: { kind: "url", url: "report.pdf" } },
    ],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.ok(resolved.media);
  assert.equal(resolved.media[0]!.type, "file");
  assert.equal(resolved.media[0]!.source.kind, "data");
  if (resolved.media[0]!.source.kind === "data") {
    assert.equal(resolved.media[0]!.source.mimeType, "application/pdf");
  }
});

test("driver: resolveSandboxMedia leaves HTTPS URLs untouched", async () => {
  _setSandboxControllerForTesting({
    get: () => Promise.reject(new Error("should not be called")),
  } as never);

  const reply: ChannelReply = {
    text: "See image.",
    images: [{ kind: "url", url: "https://example.com/photo.jpg" }],
    media: [
      { type: "image", source: { kind: "url", url: "https://example.com/photo.jpg" } },
    ],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.equal(resolved.images![0]!.kind, "url");
  assert.equal(resolved.media![0]!.source.kind, "url");
});

test("driver: resolveSandboxMedia rejects unsafe filenames with path separators", async () => {
  const fakeSandbox = makeFakeSandbox({});
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Uh oh.",
    media: [
      { type: "file", source: { kind: "url", url: "../etc/passwd" } },
    ],
    images: [{ kind: "url", url: "../../secrets.txt" }],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  // Unsafe names are kept as-is (unresolved) but not fetched
  assert.equal(resolved.images![0]!.kind, "url");
  assert.equal(resolved.media![0]!.source.kind, "url");
});

test("driver: resolveSandboxMedia returns reply unchanged when no sandboxId", async () => {
  const reply: ChannelReply = {
    text: "No sandbox.",
    images: [{ kind: "url", url: "chart.png" }],
  };
  const resolved = await resolveSandboxMedia(reply, null);
  assert.deepStrictEqual(resolved, reply);
});

test("driver: resolveSandboxMedia handles mixed resolved and unresolved media", async () => {
  const fakeSandbox = makeFakeSandbox({
    "/home/vercel-sandbox/chart.png": png1x1(),
    // answer.mp3 is NOT available
  });
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Mixed results.",
    media: [
      { type: "image", source: { kind: "url", url: "chart.png" } },
      { type: "audio", source: { kind: "url", url: "missing-audio.mp3" } },
      { type: "video", source: { kind: "url", url: "https://cdn.example.com/video.mp4" } },
    ],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.ok(resolved.media);
  assert.equal(resolved.media.length, 3);
  // Image resolved to data
  assert.equal(resolved.media[0]!.source.kind, "data");
  // Audio stayed as url (not found)
  assert.equal(resolved.media[1]!.source.kind, "url");
  // HTTPS video untouched
  assert.equal(resolved.media[2]!.source.kind, "url");
  if (resolved.media[2]!.source.kind === "url") {
    assert.equal(resolved.media[2]!.source.url, "https://cdn.example.com/video.mp4");
  }
});

test("driver: resolveSandboxMedia preserves reply with no images or media", async () => {
  const reply: ChannelReply = { text: "Just text." };
  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.deepStrictEqual(resolved, reply);
});

// ---------------------------------------------------------------------------
// Regression: worker-sandbox media hop — bare filename → kind: "data"
// ---------------------------------------------------------------------------

test("driver: resolveSandboxMedia resolves worker-sandbox audio artifact (job-1-answer.mp3)", async () => {
  const audioBytes = mp3Stub();
  const fakeSandbox = makeFakeSandbox({
    "/home/vercel-sandbox/.openclaw/generated/worker/job-1-answer.mp3": audioBytes,
  });
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "Done",
    media: [
      { type: "audio", source: { kind: "url", url: "job-1-answer.mp3" } },
    ],
  };

  const resolved = await resolveSandboxMedia(reply, "sbx-worker-1");

  assert.ok(resolved.media, "media array must be present after resolution");
  assert.equal(resolved.media.length, 1);

  const item = resolved.media[0]!;
  assert.equal(item.type, "audio");
  assert.equal(item.source.kind, "data", "sandbox-relative URL must resolve to data source");
  if (item.source.kind === "data") {
    assert.equal(item.source.mimeType, "audio/mpeg");
    assert.equal(item.source.filename, "job-1-answer.mp3");
    assert.ok(item.source.base64.length > 0, "base64 payload must be non-empty");
  }
});

// ---------------------------------------------------------------------------
// Path-shape behavior: bare filenames vs slash-containing sandbox paths
// ---------------------------------------------------------------------------

test("driver: /workspace/ absolute paths are classified as sandbox-relative but rejected as unsafe", async () => {
  // Bare filenames work — they pass both isSandboxRelativePath and isSafeFilename
  assert.ok(isSandboxRelativePath("out.mp3"), "bare filename is sandbox-relative");
  assert.ok(isSafeFilename("out.mp3"), "bare filename is safe");

  // /workspace/out.mp3 is considered sandbox-relative (no protocol) but
  // contains a path separator, so isSafeFilename rejects it — this is
  // intentional to prevent path traversal.
  assert.ok(
    isSandboxRelativePath("/workspace/out.mp3"),
    "/workspace path has no protocol, so it is sandbox-relative",
  );
  assert.ok(
    !isSafeFilename("/workspace/out.mp3"),
    "/workspace path contains slash, so it is rejected as unsafe",
  );

  // Verify the full resolution path leaves the slash-path unresolved
  const fakeSandbox = makeFakeSandbox({});
  _setSandboxControllerForTesting({
    get: () => Promise.resolve(fakeSandbox),
  } as never);

  const reply: ChannelReply = {
    text: "",
    media: [
      { type: "audio", source: { kind: "url", url: "/workspace/out.mp3" } },
    ],
  };
  const resolved = await resolveSandboxMedia(reply, "sbx-123");
  assert.equal(
    resolved.media![0]!.source.kind,
    "url",
    "/workspace/ path must stay unresolved (kept as original URL source)",
  );
});
