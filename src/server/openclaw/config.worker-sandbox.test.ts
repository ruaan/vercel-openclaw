import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkerSandboxSkill,
  buildWorkerSandboxScript,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
} from "@/server/openclaw/config";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("worker-sandbox skill describes the execute entrypoint and JSON contract", () => {
  const skill = buildWorkerSandboxSkill();

  assert.match(skill, /^---\nname: worker-sandbox/m);
  assert.match(skill, /Execute a bounded job in a fresh Vercel Sandbox/);
  assert.match(skill, new RegExp(escapeRegExp(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH)));
  assert.match(skill, /WorkerSandboxExecuteRequest shape/);
  assert.match(skill, /capturePaths/);
  assert.match(skill, /Response shape/);
  assert.match(skill, /capturedFiles/);
  assert.match(skill, /stdout/);
  assert.match(skill, /stderr/);
});

test("worker-sandbox script posts to the internal execute route with bearer auth", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /Could not resolve host origin from openclaw\.json/);
  assert.match(script, /worker-sandbox:v1\\0/);
  assert.match(script, /authorization:\s*"Bearer "\s*\+\s*bearer/);
  assert.match(script, /\/api\/internal\/worker-sandboxes\/execute/);
  assert.match(script, /method:\s*"POST"/);
  assert.match(script, /"content-type":\s*"application\/json"/);
});

test("worker-sandbox script materializes captured files into the canonical worker media directory", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /\/workspace\/openclaw-generated\/worker/);
  assert.match(script, /writeFile\(/);
  assert.match(script, /mkdir\(/);
  assert.match(script, /materializeCapturedFiles/);
});

test("worker-sandbox script emits MEDIA: lines for captured artifacts", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /MEDIA: /);
  assert.match(script, /"MEDIA: " \+ media\.path/);
});

test("worker-sandbox script sanitizes filenames to safe characters", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /sanitizeMediaName/);
  assert.ok(script.includes("[^a-zA-Z0-9._-]"), "script should contain the sanitization regex");
});

test("worker-sandbox script returns channelMedia in structured output", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /channelMedia/);
  assert.match(script, /inferMimeTypeFromFilename/);
  assert.match(script, /sourcePath: file\.path/);
});

test("worker-sandbox script supports --json-only flag", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /--json-only/);
  assert.match(script, /jsonOnly/);
});

test("worker-sandbox skill documents one-command channel media delivery", () => {
  const skill = buildWorkerSandboxSkill();

  assert.match(skill, /--send-channel-media/);
  assert.match(skill, /message send --media/);
  assert.match(skill, /channelMedia\[\]\.path/);
});

test("worker-sandbox script supports automatic channel media sends", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /--send-channel-media/);
  assert.match(script, /spawnSync\("message"/);
  assert.match(script, /stdio: \["ignore", "ignore", "inherit"\]/);
  assert.match(script, /\/workspace\/openclaw-generated\/worker\//);
  assert.match(script, /channelMedia/);
  assert.match(script, /isCanonicalWorkerMediaPath/);
  assert.match(script, /sendChannelMedia/);
});

test("worker-sandbox script supports --text flag for caption on first send", () => {
  const script = buildWorkerSandboxScript();

  assert.match(script, /text.*type: "string"/);
  assert.match(script, /--text/);
  assert.match(script, /caption/);
});

test("worker-sandbox script does not print raw contentBase64 to model-visible stdout", () => {
  const script = buildWorkerSandboxScript();

  // The script parses JSON and emits a summary with path-only capturedFiles
  assert.match(script, /\.map\(\(f\) => \(\{ path: f\.path \}\)\)/);
  // The final console.log uses JSON.stringify on the output variable, not raw text
  assert.match(script, /JSON\.stringify\(output/);
  // Raw `console.log(text)` should NOT appear — it was replaced by parsed output
  assert.doesNotMatch(script, /console\.log\(text\)/);
});
