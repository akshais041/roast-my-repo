// Shared types between analysis, roasts, and the API response.

export interface Commit {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Unix timestamp (seconds), author-local. */
  timestamp: number;
  /** Hour 0-23 in the author's own timezone (how they experienced it). */
  localHour: number;
  /** Day of week 0-6 (0 = Sunday) in author-local time. */
  localDay: number;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface RepoStats {
  repo: string;
  totalCommits: number;
  firstCommit: number;
  lastCommit: number;
  /** Span of the project in days. */
  spanDays: number;
  authors: number;
  topAuthor: { name: string; commits: number };
  insertions: number;
  deletions: number;
  /** Commit count per hour-of-day, index 0-23. */
  byHour: number[];
  /** Commit count per day-of-week, index 0-6 (0 = Sunday). */
  byDay: number[];
  /** Share of commits between 00:00 and 04:59 local time. */
  lateNightShare: number;
  /** The hour with the most commits. */
  peakHour: number;
  /** Most frequently touched file and its edit count. */
  mostTortuedFile: { path: string; touches: number } | null;
  /** Count of low-effort commit subjects ("fix", "wip", "stuff", etc.). */
  lazyMessageCount: number;
  /** The single most-repeated commit subject and its count. */
  topRepeatedMessage: { subject: string; count: number } | null;
  /** Longest streak of consecutive days with at least one commit. */
  longestStreakDays: number;
  /** Average commit message length in characters. */
  avgMessageLength: number;
  /** Count of commits whose message is a single word. */
  oneWordCommits: number;
}

export interface Roast {
  /** Short emoji/icon for the card line. */
  icon: string;
  /** The roast line itself - punchy, screenshot-able. */
  text: string;
  /** Category, used for grouping/coloring on the card. */
  tag: string;
}

/**
 * A code-level finding from reading the actual source (not git metadata).
 * `text` is the roast line with evidence baked in; `severity` feeds the grade.
 */
export interface CodeFinding {
  id: string;
  icon: string;
  tag: string;
  /** Demerits toward the letter grade. 0 = neutral/observation, 3 = damning. */
  severity: number;
  text: string;
}

/** What reading the snapshot produced. */
export interface CodeReport {
  /** True if the snapshot clone succeeded and files were read. */
  available: boolean;
  /** Total files in the tree (including vendored/committed junk). */
  fileCount: number;
  /** Primary language guess, by source-file extension count. */
  language: string;
  findings: CodeFinding[];
}

export interface RoastReport {
  stats: RepoStats;
  roasts: Roast[];
  /** Code-level findings from reading the source (empty if snapshot unavailable). */
  code: CodeFinding[];
  /** A single headline verdict for the top of the card. */
  verdict: string;
  /** A letter grade for fun. */
  grade: string;
  /** Creator easter egg: set when the repo belongs to the tool's author. */
  easterEgg?: string;
}
