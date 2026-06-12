import { toPng } from "html-to-image";
import { useRef, useState } from "react";
import type { RoastReport } from "./types.ts";

const HOUR_LABEL = (h: number) => {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
};

const SEVERITY_LABEL = ["NIT", "SMELL", "BAD", "CRIMINAL"];

/** Turn `code` spans (backtick markdown) into real <code> elements. */
function renderBackticks(text: string) {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export function Card({ report }: { report: RoastReport }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const { stats, roasts, code, verdict, grade, easterEgg } = report;
  // The coverage note is a friendly footer, not a severity finding - split it out.
  const coverageNote = code.find((f) => f.id === "coverage-note");
  const realFindings = code.filter((f) => f.id !== "coverage-note");
  const repoName = stats.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const maxHour = Math.max(...stats.byHour, 1);
  // Creator repo that couldn't be cloned: show just the egg, no empty stats.
  const eggOnly = !!easterEgg && stats.totalCommits === 0;

  async function download() {
    if (!cardRef.current) return;
    setSaving(true);
    try {
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true });
      const link = document.createElement("a");
      link.download = `roast-${repoName.replace("/", "-")}.png`;
      link.href = dataUrl;
      link.click();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card-wrap">
      <div className="card" ref={cardRef}>
        <div className="card-head">
          <div>
            <div className="card-kicker">ROAST MY REPO 🔥</div>
            <div className="card-repo">{repoName}</div>
          </div>
          <div className={`grade grade-${grade[0]}`}>{grade}</div>
        </div>

        <div className="verdict">{verdict}</div>

        {easterEgg && (
          <div className="easter-egg">
            <span className="egg-badge">CREATOR DETECTED</span>
            {easterEgg}
          </div>
        )}

        {/* Egg-only card: a creator repo that couldn't be cloned. Skip the empty
            stats/heatmap/git sections that would otherwise look broken. */}
        {eggOnly ? (
          <div className="card-foot">roast-my-repo · find yours</div>
        ) : (
        <>
        <div className="meta">
          <span><b>{stats.totalCommits.toLocaleString()}</b> commits</span>
          <span><b>{stats.authors}</b> authors</span>
          <span><b>{stats.spanDays.toLocaleString()}</b> days</span>
        </div>

        {/* Code roasts lead - they're the substance, pulled from reading the source.
            The coverage note (if any) is pulled out and shown as a footer note,
            not as a severity finding. */}
        {realFindings.length > 0 && (
          <div className="code-section">
            <div className="section-label">
              <span>🔬 What the code says</span>
              <span className="finding-count">{realFindings.length} findings</span>
            </div>
            <div className="findings">
              {realFindings.map((f, i) => (
                <div key={i} className={`finding sev-${Math.min(f.severity, 3)}`}>
                  <div className="finding-icon">{f.icon}</div>
                  <div className="finding-body">
                    <div className="finding-top">
                      <span className="finding-tag">{f.tag}</span>
                      <span className="finding-sev">{SEVERITY_LABEL[Math.min(f.severity, 3)]}</span>
                    </div>
                    <div className="finding-text">{renderBackticks(f.text)}</div>
                  </div>
                </div>
              ))}
            </div>
            {coverageNote && (
              <div className="coverage-note">
                {coverageNote.icon} {renderBackticks(coverageNote.text)}
              </div>
            )}
          </div>
        )}

        <div className="section-label">📊 Git Wrapped</div>
        {/* 24-hour commit heatmap - the "when do you actually code" strip */}
        <div className="heatmap">
          {stats.byHour.map((count, h) => (
            <div key={h} className="heat-col" title={`${HOUR_LABEL(h)}: ${count} commits`}>
              <div
                className="heat-bar"
                style={{ height: `${Math.round((count / maxHour) * 100)}%` }}
              />
              {h % 6 === 0 && <span className="heat-tick">{HOUR_LABEL(h)}</span>}
            </div>
          ))}
        </div>

        <ul className="roasts">
          {roasts.map((r, i) => (
            <li key={i}>
              <span className="r-icon">{r.icon}</span>
              <span className="r-text">{renderBackticks(r.text)}</span>
            </li>
          ))}
        </ul>

        <div className="card-foot">roast-my-repo · find yours</div>
        </>
        )}
      </div>

      <button className="download" onClick={download} disabled={saving}>
        {saving ? "Rendering…" : "Download card 📸"}
      </button>
    </div>
  );
}
