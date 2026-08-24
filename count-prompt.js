const fs = require('fs');
const raw = fs.readFileSync('/home/node/.openclaw/agents/main/sessions/5e5887dc-1efd-4469-8179-802778683a08.trajectory.jsonl', 'utf8');
for (const line of raw.split('\n')) {
  if (!line.includes('prompt.submitted')) continue;
  try {
    const obj = JSON.parse(line);
    const sp = obj.data && obj.data.systemPrompt;
    if (sp) {
      console.log('chars:', sp.length);
      console.log('words:', sp.split(/\s+/).length);
      console.log('tokens (est ~1.3 words/tok):', Math.round(sp.split(/\s+/).length / 1.3));
      process.exit(0);
    }
  } catch(e) {}
}
console.log('no systemPrompt found in prompt.submitted entries');
