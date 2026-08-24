// sources.mjs — job board fetchers, all normalizing to a common shape.
// Zero external deps — built-in fetch + text parsing only.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** @typedef {{ source: string, id: string, url: string, company: string, title: string, location: string, salary: string, bodyText: string, postedAt?: string }} Posting */

/**
 * Fetch all sources, return normalized postings.
 * @param {import('./config.json')} config
 * @returns {Promise<Posting[]>}
 */
export async function fetchAll(config) {
  const results = [];
  const src = config.sources;

  if (src.remoteok?.enabled) {
    try { results.push(...await fetchRemoteOK()); } catch (e) { console.error("[sources] remoteok error:", e.message); }
  }
  if (src.remotive?.enabled) {
    try { results.push(...await fetchRemotive()); } catch (e) { console.error("[sources] remotive error:", e.message); }
  }
  if (src.wwr?.enabled) {
    try { results.push(...await fetchWWR(config.wwr.categories)); } catch (e) { console.error("[sources] wwr error:", e.message); }
  }
  if (src.hn?.enabled) {
    try { results.push(...await fetchHN()); } catch (e) { console.error("[sources] hn error:", e.message); }
  }
  if (src.greenhouse?.enabled) {
    for (const [slug, meta] of Object.entries(config.ats.greenhouse)) {
      try { results.push(...await fetchGreenhouse(slug, meta.label)); } catch (e) { console.error(`[sources] greenhouse/${slug} error:`, e.message); }
    }
  }
  if (src.lever?.enabled) {
    for (const [slug, meta] of Object.entries(config.ats.lever)) {
      try { results.push(...await fetchLever(slug, meta.label)); } catch (e) { console.error(`[sources] lever/${slug} error:`, e.message); }
    }
  }

  console.error(`[sources] total fetched: ${results.length}`);
  return results;
}

// --- RemoteOK ---
async function fetchRemoteOK() {
  const res = await fetch("https://remoteok.com/api", { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // [0] is a legal/credit object, skip it
  const jobs = Array.isArray(data) ? data.slice(1) : [];
  return jobs
    .filter(j => j && j.id && j.url)
    .map(j => ({
      source: "remoteok",
      id: `remoteok-${j.id}`,
      url: j.url,
      company: j.company || "",
      title: j.position || j.title || "",
      location: j.location || "",
      salary: j.salary || "",
      bodyText: [j.description, j.tags?.join(" ")].filter(Boolean).join(" "),
      postedAt: j.epoch ? new Date(j.epoch * 1000).toISOString() : undefined,
    }));
}

// --- Remotive ---
async function fetchRemotive() {
  const res = await fetch("https://remotive.com/api/remote-jobs", { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs
    .filter(j => j && j.id)
    .map(j => ({
      source: "remotive",
      id: `remotive-${j.id}`,
      url: j.url,
      company: j.company_name || "",
      title: j.title || "",
      location: j.candidate_required_location || "",
      salary: j.salary || "",
      bodyText: [j.description, j.tags?.join(" ")].filter(Boolean).join(" "),
      postedAt: j.publication_date,
    }));
}

// --- We Work Remotely (RSS) ---
async function fetchWWR(categories) {
  const all = [];
  for (const cat of categories) {
    const rssUrl = `https://weworkremotely.com/categories/${cat}.rss`;
    const res = await fetch(rssUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) { console.error(`[sources] wwr/${cat} HTTP ${res.status}, skipping`); continue; }
    const xml = await res.text();
    // Minimal RSS parser — extract <item> blocks via regex
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
    for (const [, block] of items) {
      const title = textOf(block, "title");
      const link = textOf(block, "link");
      const desc = textOf(block, "description");
      // WWR titles are often "Company: Job Title"
      const [company, ...rest] = title.split(":");
      if (!link) continue;
      all.push({
        source: "wwr",
        id: `wwr-${hashStr(link)}`,
        url: link,
        company: (company || "").trim(),
        title: rest.join(":").trim() || title,
        location: "",
        salary: "",
        bodyText: stripHtml(desc),
      });
    }
  }
  return all;
}

// --- Hacker News (Who is Hiring) ---
async function fetchHN() {
  // Find latest "Ask HN: Who is Hiring" story via Algolia
  const searchUrl = "https://hn.algolia.com/api/v1/search?query=Ask%20HN%3A%20Who%20is%20hiring&tags=story&hitsPerPage=1";
  const res = await fetch(searchUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const story = data.hits?.[0];
  if (!story) return [];

  // Fetch top-level comments (children) of the story
  const commentsUrl = `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=200`;
  const cRes = await fetch(commentsUrl, { headers: { "User-Agent": UA } });
  if (!cRes.ok) return [];
  const cData = await cRes.json();
  const comments = cData.hits || [];

  // Pre-filter: only comments that look like job postings (have URLs or keywords)
  const hiringKw = /hiring|job|position|role|engineer|developer|manager|remote|apply|intern/gi;
  const urlRe = /https?:\/\/[^\s)\]]+/gi;

  return comments
    .filter(c => {
      const text = c.comment_text || "";
      return hiringKw.test(text) || urlRe.test(text);
    })
    .map(c => {
      const text = c.comment_text || "";
      const urls = text.match(urlRe) || [];
      // Extract company from first line (often "COMPANY - City" or "| COMPANY")
      const firstLine = text.split("\n")[0].substring(0, 120);
      return {
        source: "hn",
        id: `hn-${c.objectID}`,
        url: urls[0] || `https://news.ycombinator.com/item?id=${c.objectID}`,
        company: firstLine.replace(/[|\-–—]/g, " ").trim().substring(0, 60),
        title: "Who is Hiring (HN)",
        location: "",
        salary: "",
        bodyText: text.substring(0, 3000),
        postedAt: c.created_at,
      };
    });
}

// --- Greenhouse ---
async function fetchGreenhouse(slug, label) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs
    .filter(j => j && j.id)
    .map(j => {
      const content = j.content || "";
      const loc = j.location?.name || "";
      return {
        source: "greenhouse",
        id: `gh-${slug}-${j.id}`,
        url: j.absolute_url || j.github_job_url || "",
        company: label,
        title: j.title || "",
        location: loc,
        salary: "",
        bodyText: stripHtml(content),
        postedAt: j.updated_at,
      };
    });
}

// --- Lever ---
async function fetchLever(slug, label) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Lever wraps postings in an object keyed by team name
  const postings = Object.values(data).flat().filter(p => p && p.id);
  return postings
    .map(p => ({
      source: "lever",
      id: `lever-${slug}-${p.id}`,
      url: p.hostedUrl || `https://jobs.lever.co/${slug}/${p.id}`,
      company: label,
      title: p.text || p.title || "",
      location: (p.categories?.location || ""),
      salary: p.categories?.compensation || "",
      bodyText: [p.descriptionPlain || p.description || "", p.lists?.additional || ""].filter(Boolean).join(" "),
      postedAt: p.createdAt,
    }));
}

// --- Helpers ---

function textOf(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\[CDATA\[([\s\S]*?)\]\]></${tag}>`))
         || xml.match(new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`));
  return m ? m[1].trim() : "";
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ").replace(/\s+/g, " ").trim();
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
