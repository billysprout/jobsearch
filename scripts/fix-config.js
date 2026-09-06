const fs = require('fs');
const p = process.argv[2] || '/workspace/openclaw.json';
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));

// Add colibri provider
if (!cfg.models) cfg.models = {};
if (!cfg.models.providers) cfg.models.providers = {};
cfg.models.providers['coli-local'] = {
  baseUrl: 'http://host.docker.internal:8000/v1',
  api: 'openai-completions',
  apiKey: 'coli-no-auth',
  models: [{
    id: 'glm-5.2-colibri',
    name: 'GLM-5.2 Colibri Local',
    reasoning: true,
    input: ['text'],
    contextWindow: 131072,
    maxTokens: 98304
  }],
  timeoutSeconds: 900
};

// Add agent timeout (colibri needs it)
if (!cfg.agents) cfg.agents = {};
if (!cfg.agents.defaults) cfg.agents.defaults = {};
cfg.agents.defaults.timeoutSeconds = 900;

// Add MCP server (correct schema: mcp.servers, not root mcpServers)
if (!cfg.mcp) cfg.mcp = {};
if (!cfg.mcp.servers) cfg.mcp.servers = {};
cfg.mcp.servers['colibri'] = {
  url: 'http://mcp-colibri:3000/sse',
  transport: 'sse',
  enabled: true,
  // Colibri MoE prefill takes 30-90s; request timeout must accommodate this.
  connectionTimeoutMs: 10000,
  requestTimeoutMs: 600000
};

// Salary research MCP (mcp-salary container) — synchronous BLS fetches are
// fast, so a modest timeout is correct here (unlike colibri's 600s).
cfg.mcp.servers['salary'] = {
  url: 'http://mcp-salary:3000/sse',
  transport: 'sse',
  enabled: true,
  connectionTimeoutMs: 10000,
  requestTimeoutMs: 30000
};

// Job-scrape configuration MCP (mcp-jobscrape container) — thin proxy to the
// host-side config-server.mjs, local and fast like salary.
cfg.mcp.servers['jobscrape'] = {
  url: 'http://mcp-jobscrape:3000/sse',
  transport: 'sse',
  enabled: true,
  connectionTimeoutMs: 10000,
  requestTimeoutMs: 15000
};

fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('Config updated: coli-local provider + 900s timeout + mcp.servers.colibri/salary/jobscrape');
