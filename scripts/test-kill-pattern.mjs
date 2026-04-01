import { Sandbox } from "@vercel/sandbox";

const sb = await Sandbox.create({ ports: [3000], timeout: 60000 });
console.log("Created:", sb.name);

const script = `#!/bin/bash
set -euo pipefail
_gw_pids=$(ps aux | grep "[o]penclaw.gateway" | awk '{print $2}' || true)
if [ -n "$_gw_pids" ]; then kill $_gw_pids 2>/dev/null; fi
true
echo kill_done
`;

await sb.writeFiles([{ path: "/tmp/kill-test.sh", content: Buffer.from(script) }]);
const r = await sb.runCommand("bash", ["/tmp/kill-test.sh"]);
console.log("exitCode:", r.exitCode);
console.log("stdout:", (await r.output("stdout")).trim());
console.log("stderr:", (await r.output("stderr")).trim());

await sb.stop({ blocking: true });
console.log("Done");
