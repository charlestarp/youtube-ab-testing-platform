"use client";

import { useEffect, useRef, useState } from "react";

// Polls /version.json (the Next build id). Baselines against the id this tab
// loaded with, and only prompts when a later poll differs, so a redeploy of
// changed code surfaces a quiet "refresh" pill. No false prompt on first load.
export function UpdateBanner() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as { id?: string };
        if (cancelled || !data.id) return;
        if (loadedId.current === null) { loadedId.current = data.id; return; }
        if (data.id !== loadedId.current) setUpdateAvailable(true);
      } catch { /* offline / transient */ }
    };
    check();
    const iv = setInterval(check, 60_000);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(iv); window.removeEventListener("focus", onFocus); };
  }, []);

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex items-center gap-2.5 rounded-full pl-3.5 pr-1.5 py-1.5 shadow-lg bg-card border border-border animate-in fade-in slide-in-from-top-2 duration-300">
      <span className="relative flex size-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-green opacity-75" />
        <span className="relative inline-flex rounded-full size-2 bg-brand-green" />
      </span>
      <span className="text-xs font-semibold whitespace-nowrap">New version available</span>
      <button
        onClick={() => window.location.reload()}
        className="rounded-full bg-primary text-primary-foreground px-3 py-1 text-xs font-bold hover:bg-primary/90 active:scale-95 transition"
      >
        Refresh
      </button>
      <button onClick={() => setDismissed(true)} className="text-muted-foreground hover:text-foreground px-1 text-sm" aria-label="Dismiss">×</button>
    </div>
  );
}
