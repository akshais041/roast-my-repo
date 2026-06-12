import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectCode } from "./inspect.js";
import type { CodeReport, Commit, RepoStats } from "./types.js";

const exec = promisify(execFile);

// Cap the history clone so a giant repo fails fast with a friendly message.
// Generous enough to survive the free-tier's slower disk/network under load.
const CLONE_TIMEOUT_MS = 45_000;

/**
 * Full analysis: git-history stats AND a source-code inspection, run in
 * PARALLEL so wall-clock is the slower of the two clones, not their sum.
 * The metadata clone is blob-less (history only); the inspection clone is
 * depth-1 (snapshot only). Different temp dirs, both cleaned up by their owners.
 */
export async function analyzeRepoFull(
  repoUrl: string
): Promise<{ stats: RepoStats; code: CodeReport }> {
  // Make a unique parent dir, then point the clone at a NON-existent child path
  // inside it. `git clone` insists on creating its own target dir (older git
  // versions reject cloning into a pre-existing dir, even an empty one), so we
  // never pre-create the clone target itself.
  const parent = await mkdtemp(join(tmpdir(), "roast-snap-"));
  const inspectDir = join(parent, "repo");
  const [stats, code] = await Promise.all([
    analyzeRepo(repoUrl),
    inspectCode(repoUrl, inspectDir),
  ]);
  return { stats, code };
}

/** Unique record separator so commit messages with newlines don't break parsing. */
const REC = "\x1e";
const FLD = "\x1f";

/**
 * Clone a public repo's history (no file contents) into a temp dir, run git log,
 * parse it into structured commits, then delete the clone. Blob-less so it's fast
 * even on large repos and never downloads source.
 */
export async function analyzeRepo(repoUrl: string): Promise<RepoStats> {
  const dir = await mkdtemp(join(tmpdir(), "roast-"));
  try {
    await exec(
      "git",
      [
        "clone",
        "--bare",
        "--filter=blob:none",
        "--no-tags",
        "--single-branch",
        repoUrl,
        dir,
      ],
      { timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 64 }
    );

    // Leading REC so splitting yields one clean chunk per commit (header line +
    // following file-path lines). %H hash | %an author | %ae email | %at ts |
    // %ai author date in ISO incl. the author's own UTC offset | %s subject.
    // --name-only (not --numstat): only needs tree objects, so blob:none stays fast.
    const format = REC + ["%H", "%an", "%ae", "%at", "%ai", "%s"].join(FLD);
    const { stdout } = await exec(
      "git",
      ["--git-dir", dir, "log", `--pretty=format:${format}`, "--name-only", "--no-merges"],
      { maxBuffer: 1024 * 1024 * 256 }
    );

    return computeStats(repoUrl, parseLog(stdout));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  const records = stdout.split(REC);

  for (const record of records) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;

    const newlineIdx = trimmed.indexOf("\n");
    const header = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
    const body = newlineIdx === -1 ? "" : trimmed.slice(newlineIdx + 1);

    const [hash, authorName, authorEmail, at, authorDate, subject] = header.split(FLD);
    if (!hash || !at) continue;

    const timestamp = Number(at);
    const { hour: localHour, day: localDay } = authorLocal(authorDate, timestamp);

    // With --name-only each remaining line is a bare file path.
    const files: string[] = [];
    for (const line of body.split("\n")) {
      const path = line.trim();
      if (path) files.push(path);
    }

    commits.push({
      hash,
      authorName: authorName || "unknown",
      authorEmail: authorEmail || "",
      timestamp,
      localHour,
      localDay,
      subject: subject || "",
      filesChanged: files.length,
      insertions: 0,
      deletions: 0,
      files,
    });
  }

  return commits;
}

/**
 * Extract the wall-clock hour/day the author actually experienced, from git's
 * `%ai` ("2023-04-15 02:34:11 +0200"). We apply the embedded offset to the UTC
 * timestamp ourselves so we don't depend on the server's local timezone.
 * Falls back to UTC if the date can't be parsed.
 */
function authorLocal(authorDate: string | undefined, timestamp: number): { hour: number; day: number } {
  const m = authorDate?.match(/([+-])(\d{2})(\d{2})\s*$/);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const offsetSec = sign * (Number(m[2]) * 3600 + Number(m[3]) * 60);
    const shifted = new Date((timestamp + offsetSec) * 1000);
    return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
  }
  const d = new Date(timestamp * 1000);
  return { hour: d.getUTCHours(), day: d.getUTCDay() };
}

const LAZY_WORDS = new Set([
  "fix", "fixes", "fixed", "wip", "stuff", "things", "update", "updates",
  "misc", "cleanup", "minor", "tweak", "tweaks", "oops", "typo", "test",
  "asdf", "temp", "tmp", "changes", "more", "again", ".", "...",
]);

function computeStats(repo: string, commits: Commit[]): RepoStats {
  const byHour = new Array(24).fill(0);
  const byDay = new Array(7).fill(0);
  const authorCounts = new Map<string, number>();
  const fileTouches = new Map<string, number>();
  const messageCounts = new Map<string, number>();

  let insertions = 0;
  let deletions = 0;
  let lateNight = 0;
  let lazyMessageCount = 0;
  let messageLengthTotal = 0;
  let oneWordCommits = 0;
  let first = Infinity;
  let last = 0;

  for (const c of commits) {
    byHour[c.localHour]++;
    byDay[c.localDay]++;
    authorCounts.set(c.authorName, (authorCounts.get(c.authorName) || 0) + 1);
    insertions += c.insertions;
    deletions += c.deletions;
    if (c.localHour >= 0 && c.localHour < 5) lateNight++;
    first = Math.min(first, c.timestamp);
    last = Math.max(last, c.timestamp);

    for (const f of c.files) {
      fileTouches.set(f, (fileTouches.get(f) || 0) + 1);
    }

    const subject = c.subject.trim();
    const lower = subject.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length === 1) oneWordCommits++;
    if (LAZY_WORDS.has(lower) || (words.length === 1 && LAZY_WORDS.has(words[0]))) {
      lazyMessageCount++;
    }
    messageLengthTotal += subject.length;
    const key = lower;
    if (key) messageCounts.set(key, (messageCounts.get(key) || 0) + 1);
  }

  const topAuthor = [...authorCounts.entries()].sort((a, b) => b[1] - a[1])[0] || ["unknown", 0];
  const topFile = [...fileTouches.entries()].sort((a, b) => b[1] - a[1])[0];
  const topMessage = [...messageCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const peakHour = byHour.indexOf(Math.max(...byHour));

  return {
    repo,
    totalCommits: commits.length,
    firstCommit: first === Infinity ? 0 : first,
    lastCommit: last,
    spanDays: last && first !== Infinity ? Math.max(1, Math.round((last - first) / 86400)) : 0,
    authors: authorCounts.size,
    topAuthor: { name: topAuthor[0], commits: topAuthor[1] },
    insertions,
    deletions,
    byHour,
    byDay,
    lateNightShare: commits.length ? lateNight / commits.length : 0,
    peakHour,
    mostTortuedFile: topFile ? { path: topFile[0], touches: topFile[1] } : null,
    lazyMessageCount,
    topRepeatedMessage: topMessage && topMessage[1] > 1 ? { subject: topMessage[0], count: topMessage[1] } : null,
    longestStreakDays: computeLongestStreak(commits),
    avgMessageLength: commits.length ? Math.round(messageLengthTotal / commits.length) : 0,
    oneWordCommits,
  };
}

function computeLongestStreak(commits: Commit[]): number {
  if (!commits.length) return 0;
  const days = new Set<number>();
  for (const c of commits) {
    days.add(Math.floor(c.timestamp / 86400));
  }
  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }
  return longest;
}
