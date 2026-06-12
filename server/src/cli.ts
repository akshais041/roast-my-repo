// Quick demo runner: `tsx src/cli.ts <repo-url>` - prints the roast report.
import { analyzeRepoFull } from "./analyze.js";
import { roast } from "./roasts.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: tsx src/cli.ts <public-git-repo-url>");
  process.exit(1);
}

console.log(`\n  Cloning + analyzing ${url} ...\n`);
const t0 = Date.now();
const { stats, code } = await analyzeRepoFull(url);
const report = roast(stats, code.findings);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log("  ┌─────────────────────────────────────────────");
console.log(`  │  ROAST MY REPO`);
console.log(`  │  ${stats.repo}`);
console.log("  ├─────────────────────────────────────────────");
console.log(`  │  Verdict: ${report.verdict}`);
console.log(`  │  Grade:   ${report.grade}`);
console.log(`  │  ${stats.totalCommits} commits · ${stats.authors} authors · ${stats.spanDays} days`);
console.log(`  │  ${code.available ? `${code.language}, ${code.fileCount.toLocaleString()} files tracked` : "code snapshot unavailable"}`);
if (report.code.length) {
  console.log("  ├──────────── CODE ROASTS (from reading the source) ────────────");
  for (const f of report.code) {
    console.log(`  │  ${f.icon}  ${f.text}`);
  }
}
console.log("  ├──────────── GIT WRAPPED (from history) ────────────");
for (const r of report.roasts) {
  console.log(`  │  ${r.icon}  ${r.text}`);
}
console.log("  └─────────────────────────────────────────────");
console.log(`\n  Analyzed in ${secs}s\n`);
