"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Dest = { label: string; route: string; hint: string; keywords: string[] };

const DESTINATIONS: Dest[] = [
  { label: "Dashboard", route: "/dashboard", hint: "Overview and live tests", keywords: ["home", "overview", "start", "main", "summary"] },
  { label: "Tests", route: "/tests", hint: "A/B tests", keywords: ["ab", "a/b", "experiments", "variants", "thumbnail", "title", "running"] },
  { label: "Retests", route: "/retests", hint: "Re-run tests", keywords: ["rerun", "repeat", "again", "redo"] },
  { label: "Schedule", route: "/schedule", hint: "Upcoming rotations", keywords: ["calendar", "upcoming", "queue", "timing", "rotation"] },
  { label: "Videos", route: "/videos", hint: "Video library", keywords: ["library", "clips", "youtube", "content", "uploads"] },
  { label: "What we've learned", route: "/learned", hint: "Learnings and takeaways", keywords: ["learnings", "learn", "lessons", "takeaways", "findings", "notes"] },
  { label: "Insights", route: "/insights", hint: "Trends and analysis", keywords: ["trends", "analysis", "data", "patterns", "stats", "metrics"] },
  { label: "Tag Analytics", route: "/tag-analytics", hint: "Tag performance", keywords: ["tags", "labels", "categories", "keywords", "performance"] },
  { label: "Retention Spikes", route: "/retention-spikes", hint: "Audience retention", keywords: ["retention", "spikes", "graph", "dropoff", "audience", "watch"] },
  { label: "Competitors", route: "/competitors", hint: "Competitor channels", keywords: ["competition", "rivals", "channels", "others", "benchmark"] },
  { label: "Comments", route: "/listening", hint: "Social listening", keywords: ["listening", "social", "comments", "feedback", "audience", "sentiment"] },
  { label: "Ask AI", route: "/ai-chat", hint: "Ask the AI", keywords: ["chat", "ai", "assistant", "ask", "producer", "gpt"] },
  { label: "Admin", route: "/admin", hint: "Settings and users", keywords: ["settings", "users", "config", "manage", "admin"] },
];

function score(query: string, d: Dest): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  const hay = (d.label + " " + d.keywords.join(" ")).toLowerCase();
  const labelLower = d.label.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (labelLower.startsWith(t)) s += 10;
    else if (labelLower.includes(t)) s += 6;
    else if (d.keywords.some((k) => k.startsWith(t))) s += 4;
    else if (hay.includes(t)) s += 2;
    else return -1; // every token must match something
  }
  return s;
}

export function GoToSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return DESTINATIONS.slice(0, 6);
    return DESTINATIONS.map((d) => ({ d, s: score(q, d) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.d);
  }, [query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Cmd/Ctrl+K focuses and opens
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function go(route: string) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(route);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      const pick = results[active];
      if (pick) go(pick.route);
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full max-w-xs">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 h-8 focus-within:border-primary/60 transition-colors">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground shrink-0">
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Go to a page or stat…"
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground"
          aria-label="Go to a page or stat"
        />
        <kbd className="hidden sm:inline-flex items-center text-[10px] font-medium text-muted-foreground border border-border rounded px-1 py-0.5 shrink-0">
          ⌘K
        </kbd>
      </div>

      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 mt-1.5 z-50 rounded-xl border border-border bg-card shadow-[0_12px_40px_rgba(0,0,0,0.25)] py-1">
          <p className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Go to
          </p>
          {results.map((d, i) => (
            <button
              key={d.route}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => go(d.route)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                i === active ? "bg-sidebar-accent" : ""
              }`}
            >
              <span className="text-sm font-semibold text-foreground">{d.label}</span>
              <span className="text-xs text-muted-foreground truncate ml-auto">{d.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
