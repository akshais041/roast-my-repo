import { useState } from "react";
import { Card } from "./Card.tsx";
import type { RoastReport } from "./types.ts";

export function App() {
  const [repo, setRepo] = useState("");
  const [report, setReport] = useState<RoastReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function run(target: string) {
    const value = target.trim();
    if (!value) return;
    setLoading(true);
    setError("");
    setReport(null);
    try {
      const res = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something broke.");
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something broke.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <h1>
          Roast My Repo <span className="flame">🔥</span>
        </h1>
        <p className="tagline">
          Git Wrapped, but it hurts. Paste a public GitHub repo and face the truth.
        </p>
      </header>

      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          run(repo);
        }}
      >
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="Drop a GitHub repo. Let's see how bad it is."
          aria-label="GitHub repository"
          autoFocus
        />
        <button type="submit" disabled={loading}>
          {loading ? "Roasting…" : "Roast it 🔥"}
        </button>
      </form>

      {loading && (
        <p className="status">Cloning history and judging your life choices…</p>
      )}
      {error && <p className="status error">{error}</p>}

      {report && <Card report={report} />}

      <footer className="foot">
        Nothing is stored. We clone history, count commits, delete it, and walk away.
      </footer>
    </div>
  );
}
