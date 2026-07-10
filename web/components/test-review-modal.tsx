"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { tests as testsApi } from "@/lib/api";

export type ReviewState =
  | { mode: "title"; videoId: string; control: string; challenger: string }
  | { mode: "thumb"; videoId: string; title: string; chain: boolean }
  | null;

export function TestReviewModal({ state, onClose, onStarted }: { state: ReviewState; onClose: () => void; onStarted?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [control, setControl] = useState("");
  const [challengers, setChallengers] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<{ label: string; path: string; file: string; is_control: number }[]>([]);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [chain, setChain] = useState(false);
  const [chainCurrent, setChainCurrent] = useState("");
  const [chainTitle, setChainTitle] = useState("");
  const [loadingSug, setLoadingSug] = useState(false);

  useEffect(() => {
    if (!state) return;
    if (state.mode === "title") {
      setControl(state.control);
      setChallengers([state.challenger]);
    } else {
      setChain(state.chain);
      setDropped(new Set());
      setThumbs([]);
      testsApi.priorThumbnails(state.videoId).then((r) => setThumbs(r.thumbnails)).catch(() => {});
    }
  }, [state]);

  if (!state) return null;

  const startTitle = async () => {
    const titles = [control.trim(), ...challengers.map((c) => c.trim())].filter(Boolean);
    if (titles.length < 2) { alert("Need the control plus at least one challenger."); return; }
    setBusy(true);
    try {
      const r = await testsApi.testSuggestedTitle(state.videoId, titles);
      onStarted?.();
      if (r.test_id) router.push(`/tests/${r.test_id}`);
    } catch (e: any) { alert(e?.message || "Could not start the test."); } finally { setBusy(false); }
  };

  const toggleChain = async (on: boolean) => {
    setChain(on);
    if (on && !chainTitle && state?.mode === "thumb") {
      setLoadingSug(true);
      try {
        const s = await testsApi.suggestTitle(state.videoId);
        setChainCurrent(s.current_title || state.title || "");
        setChainTitle(s.suggested_title || s.current_title || state.title || "");
      } catch { /* leave blank; chain will generate one at run time */ } finally { setLoadingSug(false); }
    }
  };

  const startThumb = async () => {
    const keep = thumbs.filter((t) => !dropped.has(t.path)).map((t) => t.path);
    if (keep.length < 2) { alert("Keep at least 2 thumbnails to test."); return; }
    setBusy(true);
    try {
      const r = await testsApi.retestThumbnail(state.videoId, chain, keep, chain ? chainTitle.trim() : undefined);
      if (r.test_id) router.push(`/tests/${r.test_id}`);
      else alert(r.detail || "Could not start the re-test.");
    } catch (e: any) { alert(e?.message || "Could not start the re-test."); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-card border border-border rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">{state.mode === "title" ? "Review title test" : "Review thumbnail test"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">Close</button>
        </div>

        {state.mode === "title" ? (
          <div className="space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Control (current title)</label>
              <input value={control} onChange={(e) => setControl(e.target.value)} className="w-full mt-1 px-3 py-2 bg-background border border-border rounded-lg text-sm outline-none focus:border-primary" />
            </div>
            {challengers.map((c, i) => (
              <div key={i}>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Challenger {String.fromCharCode(66 + i)}</label>
                <div className="flex gap-2 mt-1">
                  <input value={c} onChange={(e) => setChallengers((cs) => cs.map((x, j) => (j === i ? e.target.value : x)))} className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm outline-none focus:border-primary" />
                  {challengers.length > 1 && <button onClick={() => setChallengers((cs) => cs.filter((_, j) => j !== i))} className="text-xs text-neg px-2 shrink-0">Remove</button>}
                </div>
              </div>
            ))}
            <button onClick={() => setChallengers((cs) => [...cs, ""])} className="text-[11px] text-info hover:underline">+ add another title</button>
            <p className="text-[11px] text-muted-foreground">Tweak the wording, add or drop options. It starts rotating on YouTube on the next hour.</p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-4 py-1.5 text-sm border border-border rounded-lg hover:bg-accent">Cancel</button>
              <button onClick={startTitle} disabled={busy} className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50">{busy ? "Starting…" : "Start test"}</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Re-running the thumbnails you already made for this video. Tap any to drop it from the test.</p>
            <div className="grid grid-cols-3 gap-2">
              {thumbs.map((t) => {
                const off = dropped.has(t.path);
                return (
                  <button key={t.path} onClick={() => setDropped((d) => { const n = new Set(d); off ? n.delete(t.path) : n.add(t.path); return n; })} className={`relative rounded-lg overflow-hidden border-2 transition-all ${off ? "border-transparent opacity-40 grayscale" : "border-primary"}`}>
                    <img src={`/api/uploads/${t.file}`} alt="" className="w-full aspect-video object-cover" />
                    <span className="absolute top-1 left-1 text-[9px] font-bold px-1 rounded bg-black/70 text-white">{t.label}</span>
                    {off && <span className="absolute inset-0 grid place-items-center text-[11px] font-semibold text-white bg-black/40">removed</span>}
                  </button>
                );
              })}
              {thumbs.length === 0 && <p className="col-span-3 text-xs text-muted-foreground py-6 text-center">Loading thumbnails…</p>}
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={chain} onChange={(e) => toggleChain(e.target.checked)} />
              Then auto-start a title test when the thumbnail test finishes
            </label>
            {chain && (
              <div className="rounded-lg border border-border bg-background/60 p-3 space-y-2">
                {loadingSug ? (
                  <p className="text-[11px] text-muted-foreground">Working out the title to test…</p>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground">When the thumbnail winner is set, this title test starts automatically:</p>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Control (current)</label>
                      <p className="text-xs mt-0.5">{chainCurrent || state.title}</p>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Challenger (edit if you want)</label>
                      <input value={chainTitle} onChange={(e) => setChainTitle(e.target.value)} placeholder="Leave blank to auto-generate at run time" className="w-full mt-0.5 px-2.5 py-1.5 bg-background border border-border rounded-lg text-xs outline-none focus:border-primary" />
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-4 py-1.5 text-sm border border-border rounded-lg hover:bg-accent">Cancel</button>
              <button onClick={startThumb} disabled={busy} className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50">{busy ? "Starting…" : "Start test"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
