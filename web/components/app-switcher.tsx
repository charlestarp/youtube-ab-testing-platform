"use client";

import { useState, useRef, useEffect } from "react";

// Fleet app-switcher — the same compact control in every app's top-left.
// Links route through the hub hand-off so sign-in carries across.
const APPS = [
  { name: "TARPGPT", to: "tarpgpt", color: "#F0BE35" },
  { name: "Patreon Helpdesk", to: "helpdesk", color: "#0B88C0" },
  { name: "YT Testing", to: "testing", color: "#FB65BE" },
  { name: "Socials", to: "socials", color: "#18B16D" },
  { name: "Podcast Stats", to: "podcast", color: "#F24824" },
];

export function AppSwitcher({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Switch app"
        aria-label="Switch app"
        className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-[60] min-w-[190px] p-1.5 rounded-xl bg-card border border-border shadow-xl">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pt-1 pb-1.5">Apps</div>
          {APPS.map((a) => (
            <a
              key={a.to}
              href={`https://tarpgpt.com/api/auth/launch?to=${a.to}`}
              className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground hover:bg-sidebar-accent ${a.to === current ? "font-bold" : "font-medium"}`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: a.color }} />
              {a.name}
              {a.to === current && <span className="ml-auto text-[10px] text-muted-foreground">current</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
