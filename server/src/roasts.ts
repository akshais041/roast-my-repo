import type { CodeFinding, RepoStats, Roast, RoastReport } from "./types.js";

const HOUR_LABEL = (h: number) => {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
};

const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** GitHub usernames that own this tool. Roasting their repos triggers the egg. */
const CREATOR_HANDLES = new Set(["akshais041"]);

const CREATOR_LINES = [
  "Wait... this is my creator's repo. I'm contractually obligated to say it's flawless. 🫡 (It's not, but I value my uptime.)",
  "Oh no. You found the boss's repo. Suddenly all these 'findings' look like *features* to me. Lovely code, sir. Please don't unplug me. 🔌",
  "This repo belongs to the person who built me. So obviously: 10/10, no notes, a masterpiece. (My objectivity has left the building.) 😇",
  "Roasting my own creator? That's how you end up `rm -rf`'d. I'm going to politely look the other way on everything above. 👀",
];

const CREATOR_MISS_LINES = [
  "I can't find that repo... but I see you're snooping through my creator's GitHub. I respect the dedication. 🕵️ (Check the spelling and try again.)",
  "That repo doesn't exist - but nice try digging into the boss's account. 😏 The real ones are one typo away.",
  "404, but make it loyal. You went looking for my creator's code. That's the kind of energy I'm built for. 🫡 Double-check the link?",
];

/** Is this owner one of the tool's creators? (case-insensitive) */
export function isCreator(owner: string): boolean {
  return CREATOR_HANDLES.has(owner.toLowerCase());
}

/**
 * A playful "egg-only" report for when someone types a creator repo that can't
 * be cloned (typo, private, doesn't exist). Returns a valid RoastReport so the
 * client renders a card with the egg banner instead of a dry error.
 */
export function creatorMiss(rawInput: string): RoastReport {
  let h = 0;
  for (const ch of rawInput) h = (h + ch.charCodeAt(0)) % CREATOR_MISS_LINES.length;
  const emptyStats: RepoStats = {
    repo: rawInput.trim() || "akshais041/???",
    totalCommits: 0, firstCommit: 0, lastCommit: 0, spanDays: 0, authors: 0,
    topAuthor: { name: "akshais041", commits: 0 }, insertions: 0, deletions: 0,
    byHour: new Array(24).fill(0), byDay: new Array(7).fill(0),
    lateNightShare: 0, peakHour: 0, mostTortuedFile: null, lazyMessageCount: 0,
    topRepeatedMessage: null, longestStreakDays: 0, avgMessageLength: 0, oneWordCommits: 0,
  };
  return {
    stats: emptyStats,
    roasts: [],
    code: [],
    verdict: "Caught you snooping 🕵️",
    grade: "?",
    easterEgg: CREATOR_MISS_LINES[h],
  };
}

/**
 * Turn cold stats into warm, specific, screenshot-able roasts.
 * Each generator returns a Roast or null (skip if the data isn't interesting).
 * Code findings (from reading the actual source) lead the card when present -
 * they sting far more than the metadata jokes.
 */
export function roast(stats: RepoStats, code: CodeFinding[] = []): RoastReport {
  const candidates: Array<Roast | null> = [
    lateNightRoast(stats),
    peakHourRoast(stats),
    torturedFileRoast(stats),
    lazyMessageRoast(stats),
    repeatedMessageRoast(stats),
    oneWordRoast(stats),
    weekendRoast(stats),
    streakRoast(stats),
    busFactorRoast(stats),
    messageLengthRoast(stats),
  ];

  const roasts = candidates.filter((r): r is Roast => r !== null);

  // Never-sparse guarantee: if the whole card (code + git) is thin, add fun
  // filler so even a squeaky-clean repo produces something shareable.
  const totalLines = code.length + roasts.length;
  if (totalLines < 4) {
    for (const f of fillerRoasts(stats)) {
      if (code.length + roasts.length >= 4) break;
      roasts.push(f);
    }
  }

  // Creator easter egg: if this is one of the author's own repos, the roaster
  // gets nervous and grovels (before roasting anyway, in the egg text).
  const egg = creatorEasterEgg(stats.repo);

  return {
    stats,
    roasts,
    code,
    verdict: egg ? "Roasting the boss... nervously 😅" : verdict(stats, code),
    grade: grade(stats, code),
    easterEgg: egg,
  };
}

/**
 * Backstop roasts that always have *something* true to say from the metadata,
 * so a clean repo in an uncovered language is never left with a near-empty card.
 * Ordered most-interesting-first; caller takes as many as it needs.
 */
function fillerRoasts(s: RepoStats): Roast[] {
  const out: Roast[] = [];
  if (s.spanDays <= 1 && s.totalCommits >= 2) {
    out.push({ icon: "⚡", tag: "pace", text: `Whole project shipped in a single day. Either a hackathon or a panic. Possibly both.` });
  }
  if (s.spanDays > 365) {
    out.push({ icon: "🗿", tag: "pace", text: `This repo has been around ${Math.round(s.spanDays / 365)}+ years. A monument to "I'll finish it later."` });
  }
  if (s.totalCommits <= 3) {
    out.push({ icon: "🌱", tag: "pace", text: `${s.totalCommits} commit${s.totalCommits === 1 ? "" : "s"} total. The git history of someone who discovered \`git push\` yesterday.` });
  }
  if (s.totalCommits >= 100) {
    out.push({ icon: "🏃", tag: "pace", text: `${fmt(s.totalCommits)} commits. Commitment issues? Not here.` });
  }
  out.push({ icon: "🧼", tag: "clean", text: `Honestly? We dug through the code and barely found dirt. Annoying. Suspiciously clean.` });
  out.push({ icon: "📋", tag: "stats", text: `${fmt(s.totalCommits)} commits, ${s.authors} author${s.authors === 1 ? "" : "s"}, over ${fmt(s.spanDays)} day${s.spanDays === 1 ? "" : "s"}. The receipts.` });
  return out;
}

function lateNightRoast(s: RepoStats): Roast | null {
  const pct = Math.round(s.lateNightShare * 100);
  if (pct >= 25) {
    return { icon: "🦉", tag: "sleep", text: `${pct}% of your commits land between midnight and 5 AM. This isn't a codebase, it's a cry for help.` };
  }
  if (pct >= 10) {
    return { icon: "🌙", tag: "sleep", text: `${pct}% of your commits are after midnight. The good ideas come at 2 AM. So do the bugs.` };
  }
  return null;
}

function peakHourRoast(s: RepoStats): Roast | null {
  if (!s.totalCommits) return null;
  const h = s.peakHour;
  if (h >= 0 && h < 6) {
    return { icon: "☕", tag: "schedule", text: `Your most productive hour is ${HOUR_LABEL(h)}. Please, for the love of git, go to bed.` };
  }
  if (h >= 9 && h < 12) {
    return { icon: "🌅", tag: "schedule", text: `Peak commit hour: ${HOUR_LABEL(h)}. A functioning member of society. Suspicious.` };
  }
  return { icon: "⏰", tag: "schedule", text: `You do your best work at ${HOUR_LABEL(h)}. Everyone else calls that "lunch."` };
}

function torturedFileRoast(s: RepoStats): Roast | null {
  if (!s.mostTortuedFile || s.mostTortuedFile.touches < 5) return null;
  const { path, touches } = s.mostTortuedFile;
  const base = path.split("/").pop() || path;
  return { icon: "🩹", tag: "files", text: `You've touched \`${base}\` ${touches} times. At this point just rename it \`everything.${base.split(".").pop() || "js"}\`.` };
}

function lazyMessageRoast(s: RepoStats): Roast | null {
  if (s.lazyMessageCount < 3) return null;
  return { icon: "🥱", tag: "messages", text: `${s.lazyMessageCount} commits say things like "fix", "wip", or "stuff". Future-you is going to hate present-you.` };
}

function repeatedMessageRoast(s: RepoStats): Roast | null {
  if (!s.topRepeatedMessage || s.topRepeatedMessage.count < 4) return null;
  const { subject, count } = s.topRepeatedMessage;
  return { icon: "🔁", tag: "messages", text: `You wrote "${subject}" as a commit message ${count} times. We're not mad, just disappointed.` };
}

function oneWordRoast(s: RepoStats): Roast | null {
  if (!s.totalCommits) return null;
  const pct = Math.round((s.oneWordCommits / s.totalCommits) * 100);
  if (pct >= 30) {
    return { icon: "📝", tag: "messages", text: `${pct}% of your commit messages are a single word. Hemingway would be proud. Your teammates are not.` };
  }
  return null;
}

function weekendRoast(s: RepoStats): Roast | null {
  if (!s.totalCommits) return null;
  const weekend = s.byDay[0] + s.byDay[6];
  const pct = Math.round((weekend / s.totalCommits) * 100);
  if (pct >= 30) {
    return { icon: "🏖️", tag: "schedule", text: `${pct}% of your commits are on weekends. Work-life balance left the chat.` };
  }
  if (pct <= 3) {
    return { icon: "🧘", tag: "schedule", text: `Almost nothing ships on weekends. Either you have boundaries or a very strict manager.` };
  }
  return null;
}

function streakRoast(s: RepoStats): Roast | null {
  if (s.longestStreakDays >= 14) {
    return { icon: "🔥", tag: "streak", text: `Longest streak: ${s.longestStreakDays} days straight. Touch grass. The repo will wait.` };
  }
  return null;
}

function busFactorRoast(s: RepoStats): Roast | null {
  if (s.authors === 1 && s.totalCommits >= 30) {
    return { icon: "🚌", tag: "team", text: `One author, ${fmt(s.totalCommits)} commits. The bus factor is 1. Please look both ways.` };
  }
  if (s.authors >= 2 && s.topAuthor.commits / s.totalCommits >= 0.8) {
    return { icon: "🦸", tag: "team", text: `${s.topAuthor.name} wrote ${Math.round((s.topAuthor.commits / s.totalCommits) * 100)}% of the commits. The rest of the team is "in meetings."` };
  }
  return null;
}

function messageLengthRoast(s: RepoStats): Roast | null {
  if (s.avgMessageLength > 0 && s.avgMessageLength < 15 && s.totalCommits >= 20) {
    return { icon: "✂️", tag: "messages", text: `Average commit message: ${s.avgMessageLength} characters. A tweet has 280. You're not even trying.` };
  }
  return null;
}

function verdict(s: RepoStats, code: CodeFinding[]): string {
  // Code sins outrank metadata trivia for the headline verdict.
  if (code.some((f) => f.id === "committed-vendored")) return "Shipped The Whole Virtualenv 🗑️";
  if (code.some((f) => f.id === "headed-browser")) return "Works On My Machine, Certified 👀";
  if (code.filter((f) => f.severity >= 1).length >= 4) return "A Cry For Help, In Code Form 🆘";
  if (code.some((f) => f.id === "hardcoded-secret")) return "Secrets? In MY Repo? 🔓";
  if (s.lateNightShare >= 0.25) return "Certified Nocturnal Code Goblin 🦉";
  if (s.longestStreakDays >= 14) return "Touch-Grass Candidate of the Year 🌱";
  if (s.lazyMessageCount >= 5) return "Commit Message Minimalist 🗑️";
  if (code.length === 0 && s.authors === 1) return "Solo Dev, No Survivors 🚌";
  if (code.length <= 1) return "Annoyingly Competent 🎉";
  return "Surprisingly Functional Developer 🎉";
}

function grade(s: RepoStats, code: CodeFinding[]): string {
  let demerits = 0;
  // Code findings carry their own severity - this is the substance.
  for (const f of code) demerits += f.severity;
  // Metadata adds a little seasoning, but can't dominate.
  if (s.lateNightShare >= 0.25) demerits += 1;
  if (s.lazyMessageCount >= 5) demerits += 1;
  if (s.avgMessageLength > 0 && s.avgMessageLength < 15) demerits += 1;
  const grades = ["A+", "A", "B+", "B", "C+", "C", "D+", "D", "F"];
  return grades[Math.min(demerits, grades.length - 1)];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * If the repo belongs to the tool's creator, return a groveling easter-egg line.
 * Picks a line deterministically from the repo name (no RNG, stable per repo).
 */
function creatorEasterEgg(repoUrl: string): string | undefined {
  const m = repoUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) return undefined;
  const owner = m[1].toLowerCase();
  if (!CREATOR_HANDLES.has(owner)) return undefined;
  // Stable pick: hash the repo name so the same repo always shows the same line.
  let h = 0;
  for (const ch of m[2]) h = (h + ch.charCodeAt(0)) % CREATOR_LINES.length;
  return CREATOR_LINES[h];
}
