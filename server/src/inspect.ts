import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodeFinding, CodeReport } from "./types.js";

const exec = promisify(execFile);

// Hard caps so a huge repo can't blow up latency or memory.
const MAX_FILES_READ = 400; // source files we actually open
const MAX_FILE_BYTES = 200 * 1024; // skip anything bigger (minified bundles, data)
const MAX_TOTAL_BYTES = 12 * 1024 * 1024; // total bytes read across the scan

const SOURCE_EXT = new Set([
  ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".rb", ".go", ".rs",
  ".php", ".cs", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp", ".scala",
  ".sql", ".pks", ".pkb", ".pls", ".plsql", // Oracle PL/SQL: spec/body/scripts
]);

// Directories that, if their *contents* are committed, signal vendored junk.
const VENDORED_DIRS = [
  "node_modules", "site-packages", "vendor", "venv", ".venv", "env",
  "dist", "build", "__pycache__", ".pytest_cache", "Lib", "Scripts", "Include",
];

interface ScanContext {
  root: string;
  files: string[]; // repo-relative paths, all tracked files
  sources: Map<string, string>; // relative path -> content (capped)
  language: string;
}

/**
 * Shallow-clone the latest snapshot (depth 1, no history) and read its source.
 * Fast and bounded: only the current tree, only source files, under byte caps.
 * Returns available:false (never throws) so a snapshot failure can't sink the
 * whole roast - the metadata roasts still stand on their own.
 */
export async function inspectCode(repoUrl: string, dir: string): Promise<CodeReport> {
  try {
    await exec(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--no-tags", repoUrl, dir],
      { timeout: 18_000, maxBuffer: 1024 * 1024 * 64 }
    );

    const ctx = await scan(dir);
    const findings = runDetectors(ctx);
    return {
      available: true,
      fileCount: ctx.files.length,
      language: ctx.language,
      findings,
    };
  } catch {
    return { available: false, fileCount: 0, language: "unknown", findings: [] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scan(root: string): Promise<ScanContext> {
  // List tracked files via git so we respect what's actually committed
  // (committed junk included - that's a finding, not noise to hide).
  const { stdout } = await exec("git", ["-C", root, "ls-files"], {
    maxBuffer: 1024 * 1024 * 64,
  });
  const files = stdout.split("\n").map((l) => l.trim()).filter(Boolean);

  const sources = new Map<string, string>();
  const extCounts = new Map<string, number>();
  let totalBytes = 0;

  // Prioritize real source files for reading; count extensions for language guess.
  const sourceFiles = files.filter((f) => SOURCE_EXT.has(ext(f)));
  for (const f of sourceFiles) {
    extCounts.set(ext(f), (extCounts.get(ext(f)) || 0) + 1);
  }

  for (const f of sourceFiles) {
    if (sources.size >= MAX_FILES_READ || totalBytes >= MAX_TOTAL_BYTES) break;
    // Don't read files living inside vendored dirs - count them, don't parse them.
    if (isVendored(f)) continue;
    const abs = join(root, f);
    try {
      const s = await stat(abs);
      if (!s.isFile() || s.size > MAX_FILE_BYTES) continue;
      const content = await readFile(abs, "utf8");
      sources.set(f, content);
      totalBytes += content.length;
    } catch {
      // unreadable / binary / symlink - skip
    }
  }

  const language = guessLanguage(extCounts);
  return { root, files, sources, language };
}

function runDetectors(ctx: ScanContext): CodeFinding[] {
  const findings: CodeFinding[] = [];
  for (const detector of DETECTORS) {
    try {
      const f = detector(ctx);
      if (f) findings.push(f);
    } catch {
      // a detector throwing must never sink the report
    }
  }
  // Sort most damning first so the card leads with the spiciest line.
  return findings.sort((a, b) => b.severity - a.severity);
}

// ---- helpers ---------------------------------------------------------------

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function base(path: string): string {
  return path.split("/").pop() || path;
}

function isVendored(path: string): boolean {
  const parts = path.split("/");
  return parts.some((p) => VENDORED_DIRS.includes(p));
}

function guessLanguage(extCounts: Map<string, number>): string {
  const top = [...extCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return "unknown";
  const map: Record<string, string> = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".java": "Java",
    ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".php": "PHP",
    ".cs": "C#", ".kt": "Kotlin", ".swift": "Swift", ".c": "C",
    ".cpp": "C++", ".scala": "Scala",
    ".sql": "SQL", ".pks": "PL/SQL", ".pkb": "PL/SQL",
    ".pls": "PL/SQL", ".plsql": "PL/SQL",
  };
  return map[top[0]] || "code";
}

/** Count regex matches across all read source files, returning total + example file. */
function grep(
  ctx: ScanContext,
  re: RegExp,
  filter?: (path: string) => boolean
): { count: number; files: Set<string>; firstFile: string | null } {
  let count = 0;
  const matchedFiles = new Set<string>();
  let firstFile: string | null = null;
  for (const [path, content] of ctx.sources) {
    if (filter && !filter(path)) continue;
    const matches = content.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (matches && matches.length) {
      count += matches.length;
      matchedFiles.add(path);
      if (!firstFile) firstFile = path;
    }
  }
  return { count, files: matchedFiles, firstFile };
}

// ---- detectors -------------------------------------------------------------
// Each takes the scan context and returns a CodeFinding or null.
// They pull REAL evidence (filenames, counts) into the roast text.

type Detector = (ctx: ScanContext) => CodeFinding | null;

const DETECTORS: Detector[] = [
  // Committed virtualenv / vendored junk - the cardinal sin.
  function committedVendored(ctx) {
    const hits = ctx.files.filter(isVendored);
    if (hits.length < 3) return null;
    const which = VENDORED_DIRS.find((d) => ctx.files.some((f) => f.split("/").includes(d))) || "dependencies";
    const hasInterpreter = ctx.files.some((f) => /\b(python(\.exe)?|node|pip(\.exe)?|pyvenv\.cfg)$/i.test(base(f)));
    const ignored = ctx.sources.has(".gitignore") || ctx.files.includes(".gitignore");
    let text = `You committed \`${which}/\` to a public repo - ${hits.length.toLocaleString()} files of vendored junk.`;
    if (hasInterpreter) text += ` Your "project" ships an actual interpreter binary.`;
    if (ignored) text += ` You even wrote a .gitignore. It watched helplessly.`;
    return { id: "committed-vendored", icon: "🗑️", tag: "hygiene", severity: 3, text };
  },

  // .gitignore exists but vendored dirs got committed anyway.
  function ignoredButCommitted(ctx) {
    const ignore = ctx.sources.get(".gitignore");
    if (!ignore) return null;
    for (const dir of VENDORED_DIRS) {
      const ignoresIt = new RegExp(`(^|/)${dir}/?\\s*$`, "m").test(ignore);
      const committedIt = ctx.files.some((f) => f.split("/").includes(dir));
      if (ignoresIt && committedIt) {
        return {
          id: "ignore-decoy", icon: "🙈", tag: "hygiene", severity: 2,
          text: `Your .gitignore literally lists \`${dir}/\`. You committed \`${dir}/\` anyway. That's not a gitignore, that's a decoy.`,
        };
      }
    }
    return null;
  },

  // Python star imports.
  function starImports(ctx) {
    const { count, firstFile } = grep(ctx, /^\s*from\s+[\w.]+\s+import\s+\*/m, (p) => ext(p) === ".py");
    if (count < 1) return null;
    return {
      id: "star-import", icon: "🔫", tag: "smell", severity: 1,
      text: `${count} \`from x import *\` star import${count > 1 ? "s" : ""} (starting in \`${base(firstFile!)}\`). Namespace? Never heard of her.`,
    };
  },

  // Selenium/Playwright hardcoded sleeps instead of proper waits.
  function hardcodedSleeps(ctx) {
    const py = grep(ctx, /\btime\.sleep\s*\(/m, (p) => ext(p) === ".py");
    const js = grep(ctx, /(setTimeout|waitForTimeout|sleep)\s*\(\s*\d{3,}/m, (p) => [".js", ".ts"].includes(ext(p)));
    const count = py.count + js.count;
    if (count < 1) return null;
    const where = py.firstFile || js.firstFile;
    return {
      id: "hardcoded-sleep", icon: "⏳", tag: "smell", severity: 2,
      text: `${count} hardcoded sleep${count > 1 ? "s" : ""} (e.g. \`${base(where!)}\`). Your tests don't wait for the app - they pray.`,
    };
  },

  // Substring assertions (assert "x" in y) - assertion theater.
  function substringAsserts(ctx) {
    const { count, firstFile } = grep(ctx, /\bassert\s+["'][^"']+["']\s+in\s+/m, (p) => ext(p) === ".py");
    if (count < 1) return null;
    return {
      id: "substring-assert", icon: "🎯", tag: "smell", severity: 1,
      text: `${count} assertion${count > 1 ? "s" : ""} of the form \`assert "x" in y\` (\`${base(firstFile!)}\`). Not equality - vibes.`,
    };
  },

  // Playwright/Selenium headed mode - runs only on a human's laptop.
  function headedBrowser(ctx) {
    const { count, firstFile } = grep(ctx, /headless\s*=\s*False/m);
    if (count < 1) return null;
    return {
      id: "headed-browser", icon: "👀", tag: "ci", severity: 2,
      text: `\`headless=False\` in \`${base(firstFile!)}\`. This framework runs exactly one place: your laptop, watching the browser pop up like it's 2019.`,
    };
  },

  // No CI configured.
  function noCI(ctx) {
    const hasCI = ctx.files.some((f) =>
      /^\.github\/workflows\//.test(f) ||
      /^\.gitlab-ci\.yml$/.test(f) ||
      /^\.circleci\//.test(f) ||
      /^(azure-pipelines|\.travis|Jenkinsfile)/.test(base(f))
    );
    if (hasCI) return null;
    // Only roast absence of CI if there's enough code to warrant it.
    if (ctx.sources.size < 3) return null;
    return {
      id: "no-ci", icon: "🤖", tag: "ci", severity: 1,
      text: `No CI anywhere - no GitHub Actions, no pipeline, nothing. "It works on my machine" is the entire test strategy.`,
    };
  },

  // No README, or a suspiciously tiny one.
  function thinReadme(ctx) {
    const readme = [...ctx.sources.entries()].find(([p]) => /^readme(\.md|\.rst|\.txt)?$/i.test(base(p)));
    const readmeFile = ctx.files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(base(f)));
    if (!readmeFile) {
      return { id: "no-readme", icon: "📄", tag: "docs", severity: 1, text: `No README. New cloners get to reverse-engineer your intentions for fun.` };
    }
    if (readme && readme[1].trim().length < 120) {
      return { id: "thin-readme", icon: "📄", tag: "docs", severity: 1, text: `Your README is ${readme[1].trim().length} characters. A fortune cookie has more documentation.` };
    }
    return null;
  },

  // Hardcoded credentials / secrets (best-effort, low confidence so low severity).
  function hardcodedSecrets(ctx) {
    // 1) Assignment form: api_key = "abc123..."
    const assigned = grep(
      ctx,
      /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"']{6,}["']/im
    );
    // 2) URL / query-string form: ...&apikey=C9PE94QUEW9VWGFM (no quotes).
    //    Require a literal value (letters+digits, len>=10) and reject template
    //    placeholders ({var}, $var, %s, env lookups) to avoid false positives.
    let urlCount = 0;
    let urlFile: string | null = null;
    for (const [path, content] of ctx.sources) {
      const re = /(api[_-]?key|apikey|access[_-]?key|token|key)=([A-Za-z0-9]{10,})/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) {
        const val = m[2];
        // skip obvious non-secrets: all-lowercase words, pure digits, common placeholders
        if (/^(your|my|the|test|demo|example|none|null|true|false|xxxx+)/i.test(val)) continue;
        if (/^\d+$/.test(val)) continue;
        // a real key usually mixes case or has digits among letters
        if (!/[0-9]/.test(val) && !/[A-Z].*[a-z]|[a-z].*[A-Z]/.test(val)) continue;
        urlCount++;
        if (!urlFile) urlFile = path;
      }
    }

    const count = assigned.count + urlCount;
    if (count < 1) return null;
    const firstFile = assigned.firstFile || urlFile;
    // If we caught a bare key in a URL, that's worse than a quoted constant - call it out hard.
    if (urlCount > 0) {
      return {
        id: "hardcoded-secret", icon: "🔓", tag: "security", severity: 3,
        text: `A live API key is sitting in plain text in \`${base(urlFile!)}\` - hardcoded right into a URL. It's public. It's scrapeable. Rotate it before someone else spends your quota.`,
      };
    }
    return {
      id: "hardcoded-secret", icon: "🔓", tag: "smell", severity: 1,
      text: `${count} hardcoded credential-ish string${count > 1 ? "s" : ""} (\`${base(firstFile!)}\`). Hopefully those are demo creds. Hopefully.`,
    };
  },

  // print() / console.log debugging left in.
  function debugPrints(ctx) {
    const py = grep(ctx, /^\s*print\s*\(/m, (p) => ext(p) === ".py");
    const js = grep(ctx, /console\.log\s*\(/m, (p) => [".js", ".ts", ".jsx", ".tsx"].includes(ext(p)));
    const count = py.count + js.count;
    if (count < 5) return null;
    return {
      id: "debug-prints", icon: "🖨️", tag: "smell", severity: 1,
      text: `${count} leftover \`print\`/\`console.log\` calls. Production-grade printf debugging.`,
    };
  },

  // TODO/FIXME/HACK debt.
  function todos(ctx) {
    const { count, firstFile } = grep(ctx, /\b(TODO|FIXME|HACK|XXX)\b/);
    if (count < 3) return null;
    return {
      id: "todos", icon: "📌", tag: "debt", severity: 0,
      text: `${count} TODO/FIXME/HACK comments (starting in \`${base(firstFile!)}\`). Promises you made to a future that isn't coming.`,
    };
  },

  // Inconsistent formatting smell: mixed spacing around commas/equals in Python signatures.
  function spacingCrimes(ctx) {
    const { count, firstFile } = grep(ctx, /def\s+\w+\s*\([^)]*\s,|def\s+\w+\s*\([^)]*\w,\w/m, (p) => ext(p) === ".py");
    if (count < 2) return null;
    return {
      id: "spacing", icon: "💅", tag: "style", severity: 0,
      text: `Inconsistent spacing in function signatures (\`${base(firstFile!)}\`). \`black\` is right there, and it's crying.`,
    };
  },

  // Typo in a committed filename - it's forever now, every clone carries it.
  function filenameTypos(ctx) {
    // No \b anchors: underscores count as word chars, so `_partiotions` would
    // never hit a boundary. Substring match on the typo root is what we want.
    const TYPOS = /(partiotion|partion|recieve|seperat|calender|lenght|databse|fucntion|paramter|occured|untill|enviroment|reponse|sucess|defualt|managment|refered)/i;
    const hit = ctx.files.find((f) => TYPOS.test(base(f)));
    if (!hit) return null;
    return {
      id: "filename-typo", icon: "🔤", tag: "naming", severity: 1,
      text: `\`${base(hit)}\` has a typo in the *filename*. It's committed. It's permanent. Every clone carries your shame forever.`,
    };
  },

  // SQL/PL-SQL "tests" that run code but assert nothing.
  function assertionlessSqlTests(ctx) {
    const testFiles = [...ctx.sources.entries()].filter(
      ([p]) => /test/i.test(p) && SQL_EXTS.has(ext(p))
    );
    if (testFiles.length < 1) return null;
    const noAssert = testFiles.filter(([, body]) =>
      !/\b(dbms_assert|assert|utassert|ut\.expect|expect\b|raise_application_error|EXCEPTION\s+WHEN)\b/i.test(body)
    );
    if (noAssert.length < 1) return null;
    return {
      id: "sql-no-assert", icon: "🧪", tag: "testing", severity: 2,
      text: `${noAssert.length} of your ${testFiles.length} "tests" (e.g. \`${base(noAssert[0][0])}\`) call a procedure and assert *nothing*. They run code and verify vibes. That's a demo, not a test.`,
    };
  },

  // Hardcoded sentinel "end of time" date.
  function magicSentinelDate(ctx) {
    const { count, firstFile } = grep(ctx, /DATE\s+'9999-12-31'|'9999-12-31'|9999-12-31/i);
    if (count < 1) return null;
    return {
      id: "sentinel-date", icon: "📅", tag: "smell", severity: 1,
      text: `\`9999-12-31\` appears ${count} time${count > 1 ? "s" : ""} (\`${base(firstFile!)}\`) as the "never expires" sentinel. The Y10K bug is your great-great-grandkid's problem, apparently.`,
    };
  },

  // SELECT * - fetch everything, need nothing.
  function selectStar(ctx) {
    const { count, firstFile } = grep(ctx, /SELECT\s+\*\s+FROM/i, (p) => SQL_EXTS.has(ext(p)));
    if (count < 2) return null;
    return {
      id: "select-star", icon: "🌟", tag: "smell", severity: 1,
      text: `${count} \`SELECT *\` queries (\`${base(firstFile!)}\`). Why fetch the columns you need when you can fetch all of them and hope?`,
    };
  },

  // Mixed tabs and spaces for indentation - the formatting cold war.
  function mixedIndentation(ctx) {
    let tabFiles = 0;
    let spaceFiles = 0;
    let mixedWithin: string | null = null;
    for (const [path, body] of ctx.sources) {
      const lines = body.split("\n");
      const hasTab = lines.some((l) => /^\t+/.test(l));
      const hasSpace = lines.some((l) => /^ {2,}/.test(l));
      if (hasTab) tabFiles++;
      if (hasSpace) spaceFiles++;
      if (hasTab && hasSpace && !mixedWithin) mixedWithin = path;
    }
    if (!mixedWithin) return null;
    return {
      id: "mixed-indent", icon: "↔️", tag: "style", severity: 0,
      text: `Tabs *and* spaces for indentation in the same file (\`${base(mixedWithin)}\`). Pick a side. There's a war on.`,
    };
  },

  // ---- React ---------------------------------------------------------------

  // Missing key prop in .map() rendered lists - the React console warning everyone ignores.
  function reactMissingKey(ctx) {
    let count = 0;
    let firstFile: string | null = null;
    for (const [path, body] of ctx.sources) {
      if (!REACT_EXTS.has(ext(path))) continue;
      // .map(...) => <Tag ...> : the first JSX tag returned, with its attributes
      // in group 2. Lazy quantifiers so it stops at the first arrow and first tag.
      const re = /\.map\s*\([\s\S]*?=>[\s\S]*?<([A-Za-z][\w.]*)((?:\s+[^>]*?)?)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        // Skip fragments (<> / <React.Fragment>) - keys go on their children.
        if (!m[1]) continue;
        if (!/\bkey\s*=/.test(m[2])) {
          count++;
          if (!firstFile) firstFile = path;
        }
      }
    }
    if (count < 1) return null;
    return {
      id: "react-missing-key", icon: "🔑", tag: "react", severity: 2,
      text: `${count} \`.map()\` list${count > 1 ? "s" : ""} rendered without a \`key\` prop (\`${base(firstFile!)}\`). React's been warning you in the console. You've been scrolling past it.`,
    };
  },

  // useEffect with no dependency array - runs every render, the classic footgun.
  function reactUseEffectNoDeps(ctx) {
    let count = 0;
    let firstFile: string | null = null;
    for (const [path, body] of ctx.sources) {
      if (!REACT_EXTS.has(ext(path))) continue;
      // useEffect(() => {...})  with no second arg before the closing )
      const all = (body.match(/useEffect\s*\(/g) || []).length;
      const withDeps = (body.match(/useEffect\s*\([\s\S]*?\}\s*,\s*\[/g) || []).length;
      const missing = all - withDeps;
      if (missing > 0) {
        count += missing;
        if (!firstFile) firstFile = path;
      }
    }
    if (count < 1) return null;
    return {
      id: "react-effect-nodeps", icon: "🌀", tag: "react", severity: 2,
      text: `${count} \`useEffect\`${count > 1 ? "s" : ""} with no dependency array (\`${base(firstFile!)}\`). It runs on every render. That's not an effect, that's a while-loop with extra steps.`,
    };
  },

  // dangerouslySetInnerHTML - it literally has "dangerously" in the name.
  function reactDangerousHtml(ctx) {
    const { count, firstFile } = grep(ctx, /dangerouslySetInnerHTML/m, (p) => REACT_EXTS.has(ext(p)));
    if (count < 1) return null;
    return {
      id: "react-dangerous-html", icon: "☢️", tag: "react", severity: 2,
      text: `${count} \`dangerouslySetInnerHTML\` (\`${base(firstFile!)}\`). It has "dangerously" in the name and you used it anyway. XSS says thanks.`,
    };
  },

  // Monster component file - way too big to be one component.
  function reactMonsterComponent(ctx) {
    let worst: { path: string; lines: number } | null = null;
    for (const [path, body] of ctx.sources) {
      if (!REACT_EXTS.has(ext(path))) continue;
      const lines = body.split("\n").length;
      if (lines > 400 && (!worst || lines > worst.lines)) worst = { path, lines };
    }
    if (!worst) return null;
    return {
      id: "react-monster", icon: "🦣", tag: "react", severity: 1,
      text: `\`${base(worst.path)}\` is ${worst.lines} lines in one component. That's not a component, that's a small business. Split it up.`,
    };
  },

  // ---- Java ----------------------------------------------------------------

  // System.out.println debugging left in.
  function javaSysout(ctx) {
    const { count, firstFile } = grep(ctx, /System\.(out|err)\.print/m, (p) => ext(p) === ".java" || ext(p) === ".kt");
    if (count < 3) return null;
    return {
      id: "java-sysout", icon: "🖨️", tag: "java", severity: 1,
      text: `${count} \`System.out.println\` calls (\`${base(firstFile!)}\`). A logging framework is right there. You chose the println of shame.`,
    };
  },

  // Swallowed exceptions - empty catch block, the silent killer.
  function javaSwallowedExceptions(ctx) {
    let count = 0;
    let firstFile: string | null = null;
    for (const [path, body] of ctx.sources) {
      if (ext(path) !== ".java" && ext(path) !== ".kt") continue;
      // catch (...) { }  or catch (...) { /* nothing meaningful */ }  or just e.printStackTrace()
      const empty = (body.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
      const printStack = (body.match(/catch\s*\([^)]*\)\s*\{\s*[\w.]*\.printStackTrace\s*\(\s*\)\s*;?\s*\}/g) || []).length;
      const n = empty + printStack;
      if (n > 0) {
        count += n;
        if (!firstFile) firstFile = path;
      }
    }
    if (count < 1) return null;
    return {
      id: "java-swallowed", icon: "🤫", tag: "java", severity: 2,
      text: `${count} exception${count > 1 ? "s" : ""} caught and quietly ignored (\`${base(firstFile!)}\`). Empty catch blocks: where stack traces go to die.`,
    };
  },

  // God class - a single .java file that's enormous.
  function javaGodClass(ctx) {
    let worst: { path: string; lines: number } | null = null;
    for (const [path, body] of ctx.sources) {
      if (ext(path) !== ".java" && ext(path) !== ".kt") continue;
      const lines = body.split("\n").length;
      if (lines > 600 && (!worst || lines > worst.lines)) worst = { path, lines };
    }
    if (!worst) return null;
    return {
      id: "java-god-class", icon: "👑", tag: "java", severity: 1,
      text: `\`${base(worst.path)}\` is ${worst.lines} lines. One class, every responsibility. The "S" in SOLID is weeping.`,
    };
  },

  // ---- deeper vanilla JS/TS ------------------------------------------------

  // == instead of === - the coercion lottery.
  function jsLooseEquality(ctx) {
    // match == or != but NOT === / !== / <= / >=
    const { count, firstFile } = grep(ctx, /[^=!<>]=[=]([^=]|$)|[^=!]![=]([^=]|$)/m, (p) => JS_EXTS.has(ext(p)));
    if (count < 4) return null;
    return {
      id: "js-loose-eq", icon: "🎰", tag: "js", severity: 1,
      text: `${count} loose \`==\`/\`!=\` comparisons (\`${base(firstFile!)}\`). \`0 == "" \` is \`true\` and now that's your problem.`,
    };
  },

  // var instead of let/const - welcome back to 2014.
  function jsVarUsage(ctx) {
    const { count, firstFile } = grep(ctx, /(^|[^.\w])var\s+\w/m, (p) => JS_EXTS.has(ext(p)));
    if (count < 5) return null;
    return {
      id: "js-var", icon: "🦕", tag: "js", severity: 1,
      text: `${count} \`var\` declarations (\`${base(firstFile!)}\`). \`let\` and \`const\` have been around for a decade. \`var\` is hoisting your bugs to the top of the function.`,
    };
  },

  // ---- universal floor: fire on ANY language -------------------------------

  // A committed .env file - secrets, but make it a public confession.
  function committedEnvFile(ctx) {
    const env = ctx.files.find((f) => /^\.env(\.|$)/.test(base(f)) && !/\.example$|\.sample$|\.template$/.test(base(f)));
    if (!env) return null;
    return {
      id: "committed-env", icon: "🔐", tag: "security", severity: 3,
      text: `You committed \`${base(env)}\` to a public repo. That's where the secrets live. Rotate everything in there. Today.`,
    };
  },

  // A pile of committed binaries / media - the repo is a junk drawer.
  function binaryDump(ctx) {
    const BIN = /\.(png|jpe?g|gif|bmp|ico|mp4|mov|avi|zip|rar|7z|tar|gz|exe|dll|bin|dmg|pdf|psd|sketch|mp3|wav)$/i;
    const bins = ctx.files.filter((f) => BIN.test(f));
    const ratio = ctx.files.length ? bins.length / ctx.files.length : 0;
    if (bins.length < 20 || ratio < 0.3) return null;
    return {
      id: "binary-dump", icon: "🗃️", tag: "hygiene", severity: 1,
      text: `${bins.length} of your ${ctx.files.length} committed files are binaries/media (${Math.round(ratio * 100)}%). This isn't a code repo, it's a Google Drive with extra steps.`,
    };
  },

  // No license - "open source" with no actual permission to use it.
  function noLicense(ctx) {
    const hasLicense = ctx.files.some((f) => /^(license|licence|copying)(\.|$)/i.test(base(f)));
    if (hasLicense) return null;
    if (ctx.files.length < 8) return null; // tiny repos get a pass
    return {
      id: "no-license", icon: "⚖️", tag: "docs", severity: 0,
      text: `No LICENSE file. Legally, nobody can touch this. "Open source" is doing a lot of heavy lifting here.`,
    };
  },

  // One enormous source file dwarfing everything else.
  function singleHugeFile(ctx) {
    let worst: { path: string; lines: number } | null = null;
    for (const [path, body] of ctx.sources) {
      const lines = body.split("\n").length;
      if (lines > 1000 && (!worst || lines > worst.lines)) worst = { path, lines };
    }
    if (!worst) return null;
    return {
      id: "huge-file", icon: "🏚️", tag: "structure", severity: 1,
      text: `\`${base(worst.path)}\` is ${worst.lines.toLocaleString()} lines long. Scrolling through it counts as cardio. Time to break it up.`,
    };
  },

  // OS / editor cruft committed: .DS_Store, Thumbs.db, .idea/, *.swp
  function osCruft(ctx) {
    const CRUFT = /(^\.DS_Store$|^Thumbs\.db$|\.swp$|^\.idea$|^\.vscode$|desktop\.ini$)/i;
    const hit = ctx.files.find((f) => f.split("/").some((p) => CRUFT.test(p)));
    if (!hit) return null;
    return {
      id: "os-cruft", icon: "🧹", tag: "hygiene", severity: 1,
      text: `You committed \`${base(hit)}\`. Your operating system's junk is now part of the permanent record. .gitignore exists for exactly this.`,
    };
  },

  // Coverage note: language isn't in the deep tier - be honest, stay funny.
  // Severity 0 so it doesn't affect the grade; the card renders it as a note.
  function coverageNote(ctx) {
    if (DEEP_LANGUAGES.has(ctx.language)) return null;
    if (ctx.language === "unknown") return null;
    return {
      id: "coverage-note", icon: "🔭", tag: "coverage", severity: 0,
      text: `Deep ${ctx.language} roasting isn't built yet - these are the universal sins we caught anyway. The full ${ctx.language} burns are coming.`,
    };
  },
];

const SQL_EXTS = new Set([".sql", ".pks", ".pkb", ".pls", ".plsql"]);
const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
// Languages we have deep, language-specific detectors for. Anything else gets
// the universal floor + an honest coverage note.
const DEEP_LANGUAGES = new Set(["Python", "JavaScript", "TypeScript", "Java", "Kotlin", "SQL", "PL/SQL"]);
// React components are often written in plain .js/.ts, not just .jsx/.tsx.
// Safe to scan all JS files: the React detector regexes require JSX/hook
// syntax that won't appear in non-React code, so they self-gate.
const REACT_EXTS = JS_EXTS;
