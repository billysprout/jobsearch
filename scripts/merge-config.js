// Deep-merges hardened-config.json (stdin) into openclaw.json inside the
// config volume, preserving everything onboarding created. Runs as a one-shot
// `node -e` inside the gateway image; pure JSON in, no dependencies.
const fs = require("fs");
const CONFIG_PATH = "/home/node/.openclaw/openclaw.json";

function deepMerge(target, patch) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const current = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const merged = deepMerge(current, JSON.parse(input));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log("[merge-config] hardened overlay applied ->", CONFIG_PATH);
});
