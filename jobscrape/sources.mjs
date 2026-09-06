// sources.mjs — job board fetchers, all normalizing to a common shape.
// Zero external deps — built-in fetch + text parsing only.
// Request parameters (User-Agent, optional timeout) come from config.fetch —
// timeoutMs: null (the default) issues requests exactly as before.

/** All URLs go through here so config.fetch applies uniformly. */
function fetchPage(url, fetchCfg) {
  const opts = { headers: { "User-Agent": fetchCfg.userAgent } };
  if (fetchCfg.timeoutMs != null) opts.signal = AbortSignal.timeout(fetchCfg.timeoutMs);
  return fetch(url, opts);
}

/** @typedef {{ source: string, id: string, url: string, company: string, title: string, location: string, salary: string, bodyText: string, postedAt?: string }} Posting */

/**
 * Fetch all sources, return normalized postings.
 * @param {import('./config.json')} config
 * @returns {Promise<Posting[]>}
 */
export async function fetchAll(config) {
  const results = [];
  const src = config.sources;
  const fetchCfg = config.fetch;

  if (src.remoteok?.enabled) {
    try { results.push(...await fetchRemoteOK(fetchCfg)); } catch (e) { console.error("[sources] remoteok error:", e.message); }
  }
  if (src.remotive?.enabled) {
    try { results.push(...await fetchRemotive(fetchCfg)); } catch (e) { console.error("[sources] remotive error:", e.message); }
  }
  if (src.wwr?.enabled) {
    try { results.push(...await fetchWWR(config.wwr.categories, fetchCfg)); } catch (e) { console.error("[sources] wwr error:", e.message); }
  }
  if (src.hn?.enabled) {
    try { results.push(...await fetchHN(fetchCfg)); } catch (e) { console.error("[sources] hn error:", e.message); }
  }
  if (src.greenhouse?.enabled) {
    for (const [slug, meta] of Object.entries(config.ats.greenhouse)) {
      try { results.push(...await fetchGreenhouse(slug, meta.label, fetchCfg)); } catch (e) { console.error(`[sources] greenhouse/${slug} error:`, e.message); }
    }
  }
  if (src.lever?.enabled) {
    for (const [slug, meta] of Object.entries(config.ats.lever)) {
      try { results.push(...await fetchLever(slug, meta.label, fetchCfg)); } catch (e) { console.error(`[sources] lever/${slug} error:`, e.message); }
    }
  }
  if (src.workable?.enabled) {
    for (const [slug, meta] of Object.entries(config.ats.workable)) {
      try { results.push(...await fetchWorkable(slug, meta.label, fetchCfg)); } catch (e) { console.error(`[sources] workable/${slug} error:`, e.message); }
    }
  }
  if (src.ashby?.enabled) {
    for (const [slug, meta] of Object.entries(config.ats.ashby)) {
      try { results.push(...await fetchAshby(slug, meta.label, fetchCfg)); } catch (e) { console.error(`[sources] ashby/${slug} error:`, e.message); }
    }
  }

  console.error(`[sources] total fetched: ${results.length}`);
  return results;
}

// --- RemoteOK ---
async function fetchRemoteOK(fetchCfg) {
  const res = await fetchPage("https://remoteok.com/api", fetchCfg);
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
async function fetchRemotive(fetchCfg) {
  const res = await fetchPage("https://remotive.com/api/remote-jobs", fetchCfg);
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
async function fetchWWR(categories, fetchCfg) {
  const all = [];
  for (const cat of categories) {
    const rssUrl = `https://weworkremotely.com/categories/${cat}.rss`;
    const res = await fetchPage(rssUrl, fetchCfg);
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
async function fetchHN(fetchCfg) {
  const hn = fetchCfg.hn;
  // Find latest "Ask HN: Who is Hiring" story via Algolia
  const searchUrl = "https://hn.algolia.com/api/v1/search?query=Ask%20HN%3A%20Who%20is%20hiring&tags=story&hitsPerPage=1";
  const res = await fetchPage(searchUrl, fetchCfg);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const story = data.hits?.[0];
  if (!story) return [];

  // Fetch top-level comments (children) of the story
  const commentsUrl = `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=${hn.hitsPerPage}`;
  const cRes = await fetchPage(commentsUrl, fetchCfg);
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
      const firstLine = text.split("\n")[0].substring(0, hn.firstLineMaxChars);
      return {
        source: "hn",
        id: `hn-${c.objectID}`,
        url: urls[0] || `https://news.ycombinator.com/item?id=${c.objectID}`,
        company: firstLine.replace(/[|\-–—]/g, " ").trim().substring(0, hn.companyMaxChars),
        title: "Who is Hiring (HN)",
        location: "",
        salary: "",
        bodyText: text.substring(0, hn.maxBodyChars),
        postedAt: c.created_at,
      };
    });
}

// --- Greenhouse ---
async function fetchGreenhouse(slug, label, fetchCfg) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await fetchPage(url, fetchCfg);
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
async function fetchLever(slug, label, fetchCfg) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetchPage(url, fetchCfg);
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

// --- Workable ---
// Public "widget" API — same one job-board aggregators use, no API key.
// Slug = the account name in apply.workable.com/{slug}/. Verify a slug works:
// curl https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
async function fetchWorkable(slug, label, fetchCfg) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
  const res = await fetchPage(url, fetchCfg);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs
    .filter(j => j && j.shortcode)
    .map(j => ({
      source: "workable",
      id: `workable-${slug}-${j.shortcode}`,
      url: j.application_url || j.url || j.shortlink || "",
      company: label,
      title: j.title || "",
      location: [j.city, j.state, j.country].filter(Boolean).join(", "),
      salary: "",
      bodyText: stripHtml(j.description || ""),
      postedAt: j.published_on || j.created_at,
    }));
}

// --- Ashby ---
// Public Job Board API (documented: developers.ashbyhq.com/docs/public-job-posting-api).
// Slug = the job board name in jobs.ashbyhq.com/{slug}. Verify a slug works:
// curl https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
async function fetchAshby(slug, label, fetchCfg) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  const res = await fetchPage(url, fetchCfg);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const jobs = data.jobs || [];
  return jobs
    .filter(j => j && j.id && j.isListed !== false)
    .map(j => ({
      source: "ashby",
      id: `ashby-${slug}-${j.id}`,
      url: j.jobUrl || j.applyUrl || "",
      company: label,
      title: j.title || "",
      location: j.location || "",
      salary: "",
      bodyText: stripHtml(j.descriptionPlain || j.descriptionHtml || ""),
      postedAt: j.publishedAt,
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
