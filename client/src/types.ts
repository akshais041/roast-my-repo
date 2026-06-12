export interface Roast {
  icon: string;
  text: string;
  tag: string;
}

export interface CodeFinding {
  id: string;
  icon: string;
  tag: string;
  severity: number;
  text: string;
}

export interface RepoStats {
  repo: string;
  totalCommits: number;
  authors: number;
  spanDays: number;
  peakHour: number;
  lateNightShare: number;
  byHour: number[];
}

export interface RoastReport {
  stats: RepoStats;
  roasts: Roast[];
  code: CodeFinding[];
  verdict: string;
  grade: string;
  easterEgg?: string;
}
