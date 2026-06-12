import cors from "cors";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { analyzeRepoFull } from "./analyze.js";
import { creatorMiss, isCreator, roast } from "./roasts.js";
import type { RoastReport } from "./types.js";

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; needed for real client IPs.
app.use(cors());
app.use(express.json({ limit: "16kb" }));

/** Only allow well-formed GitHub repo URLs - no arbitrary clone targets. */
function normalizeRepo(input: string): string | null {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const m = trimmed.match(/^(?:https:\/\/github\.com\/|git@github\.com:|github\.com\/)?([\w.-]+)\/([\w.-]+)$/i);
  if (!m) return null;
  const [, owner, repo] = m;
  if (owner.includes("..") || repo.includes("..")) return null;
  return `https://github.com/${owner}/${repo}.git`;
}

/** Best-effort owner extraction, even from sloppy input, for the creator egg. */
function extractOwner(input: string): string {
  const trimmed = input.trim().replace(/^https?:\/\//, "").replace(/^github\.com\//i, "");
  const owner = trimmed.split(/[/\s]/)[0] || "";
  return owner.toLowerCase();
}

// --- Per-IP rate limiting (sliding window, in-memory) ----------------------
const RATE_LIMIT = 12; // requests
const RATE_WINDOW_MS = 60_000; // per minute
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}

// Periodically purge stale IP entries so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// --- Global concurrency cap -------------------------------------------------
// Each roast spawns git clones (CPU + disk + network). Cap how many run at once
// so a burst can't exhaust the tiny free instance.
const MAX_CONCURRENT = 3;
let active = 0;

// --- Result cache -----------------------------------------------------------
// Same repo roasted twice returns instantly and skips the clone entirely.
const CACHE_TTL_MS = 30 * 60_000; // 30 min
const cache = new Map<string, { at: number; report: RoastReport }>();

function cacheGet(url: string): RoastReport | null {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;
  if (hit) cache.delete(url);
  return null;
}

app.post("/api/roast", async (req, res) => {
  const ip = req.ip || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Whoa, slow down. Too many roasts. Give it a minute." });
  }

  const raw = String(req.body?.repo ?? "");
  const url = normalizeRepo(raw);
  if (!url) {
    if (isCreator(extractOwner(raw))) return res.json(creatorMiss(raw));
    return res.status(400).json({ error: "Give me a valid GitHub repo, like owner/name or a github.com URL." });
  }

  // Serve from cache if we've roasted this repo recently.
  const cached = cacheGet(url);
  if (cached) return res.json(cached);

  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: "The roaster is at capacity right now. Try again in a few seconds." });
  }

  active++;
  try {
    const { stats, code } = await analyzeRepoFull(url);
    if (!stats.totalCommits) {
      if (isCreator(extractOwner(raw))) return res.json(creatorMiss(raw));
      return res.status(422).json({ error: "No commits found. Is the repo public and non-empty?" });
    }
    const report = roast(stats, code.findings);
    cache.set(url, { at: Date.now(), report });
    res.json(report);
  } catch (err) {
    if (isCreator(extractOwner(raw))) return res.json(creatorMiss(raw));
    const msg = err instanceof Error ? err.message : String(err);
    const friendly = /not found|repository|authenticate|403|404/i.test(msg)
      ? "Couldn't clone that repo. Is it public and spelled right?"
      : /timed out|timeout|ETIMEDOUT/i.test(msg)
      ? "That repo's too big to roast in time. Try a smaller one."
      : "Something broke while roasting. Try a different repo.";
    res.status(500).json({ error: friendly });
  } finally {
    active--;
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Serve the built frontend (single-service production) -------------------
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = join(here, "..", "public");
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback: any non-API route serves index.html.
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(clientDist, "index.html")));
}

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`  roast-my-repo server on :${port}`));
