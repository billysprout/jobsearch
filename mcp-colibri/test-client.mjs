// Throwaway MCP client to sanity-check ask_colibri/check_colibri fire-and-poll
// behavior directly, without going through the full OpenClaw agent stack.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const client = new Client({ name: "test-client", version: "1.0.0" });
const transport = new SSEClientTransport(new URL(process.env.MCP_URL || "http://localhost:3000/sse"));
await client.connect(transport);

console.log("--- calling ask_colibri ---");
const t0 = Date.now();
const askResult = await client.callTool({
  name: "ask_colibri",
  arguments: { prompt: "Reply with exactly the word OK and nothing else.", max_tokens: 16 },
});
console.log(`ask_colibri returned in ${Date.now() - t0}ms`);
console.log(JSON.stringify(askResult, null, 2));

const jobIdMatch = askResult.content[0].text.match(/job_id:\s*(\S+)/);
const jobId = jobIdMatch?.[1];
if (!jobId) {
  console.error("Could not extract job_id, aborting");
  process.exit(1);
}

console.log(`\n--- polling check_colibri (job_id=${jobId}) ---`);
for (let i = 0; i < 60; i++) {
  const checkResult = await client.callTool({ name: "check_colibri", arguments: { job_id: jobId } });
  const text = checkResult.content[0].text;
  console.log(`[poll ${i}] ${text.slice(0, 150)}`);
  if (!text.startsWith("Still running")) {
    console.log("\n--- final result ---");
    console.log(text);
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 10000));
}
console.log("gave up after 10 minutes of polling");
process.exit(1);
