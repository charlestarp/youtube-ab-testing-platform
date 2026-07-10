"use client";

import { use, useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { tests as testsApi } from "@/lib/api";
import { TagSelector } from "@/components/tag-selector";

const variantColors = ["#7c63ff", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#8b5cf6", "#14b8a6"];

const statusColors: Record<string, string> = {
  running: "bg-green-500/20 text-pos border-green-500/30",
  pending: "bg-yellow-500/20 text-warn border-yellow-500/30",
  completed: "bg-blue-500/20 text-info border-blue-500/30",
  paused: "bg-orange-500/20 text-warn border-orange-500/30",
  failed: "bg-red-500/20 text-neg border-red-500/30",
};

// Rotations fire a minute or two off the hour (upload timing); show the clean
// hour so a slot reads "11:00" not "10:58". Underlying data stays exact.
function fmtSlot(d: Date): string {
  const r = new Date(Math.round(d.getTime() / 3_600_000) * 3_600_000);
  return r.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + r.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function TestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const testId = parseInt(id);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addingTitle, setAddingTitle] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  // Default sort = the metric that decides the winner, so the top row IS the
  // winner (sorting by display CTR put a non-winner on top, 2026-07-10).
  const [sortBy, setSortBy] = useState("vpi");
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null); // measurement ID to show single hour

  const { data: test, mutate } = useSWR<any>(`test-${testId}`, () => testsApi.get(testId), {
    refreshInterval: 30000,
  });

  if (!test) return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;

  const handleStartNow = async () => {
    setActionError(null);
    try {
      await testsApi.startNow(testId);
      mutate();
    } catch (err: any) {
      setActionError(err.message || "Start now failed");
    }
  };

  const handleAction = async (action: "start" | "pause" | "complete" | "delete") => {
    setActionError(null);
    try {
      if (action === "start") await testsApi.start(testId);
      else if (action === "pause") await testsApi.pause(testId);
      else if (action === "complete") await testsApi.complete(testId);
      else if (action === "delete") {
        if (!confirm("Delete this test? This cannot be undone.")) return;
        await fetch(`/api/tests/${testId}`, { method: "DELETE", credentials: "include" });
        window.location.href = window.location.pathname.startsWith("/retests") ? "/retests" : "/tests";
        return;
      }
      mutate();
    } catch (err: any) {
      setActionError(err.message || "Action failed");
    }
  };

  const handleEditSchedule = async () => {
    const input = prompt("Enter start time (YYYY-MM-DD HH:mm, AEST):");
    if (!input) return;
    try {
      const [datePart, timePart] = input.split(" ");
      const dt = new Date(datePart + "T" + timePart + ":00+10:00");
      await fetch(`/api/tests/${testId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled_start: dt.toISOString(), started_at: dt.toISOString() }),
      });
      mutate();
    } catch (err: any) {
      setActionError("Invalid date format");
    }
  };

  const variants = test.variants || [];
  const timesEach = (test as any).duration_hours_per_variant || 4;
  const isHourly = (test as any).test_speed === "hourly";
  const totalSlots = variants.length * timesEach;

  // Build schedule from actual measurements + remaining planned slots
  const schedule: any[] = [];

  // First: add actual measurements (what really happened)
  const measurements = test.measurements || [];
  const measurementsByVariant: Record<number, any[]> = {};
  for (const v of variants) measurementsByVariant[v.id] = [];
  for (const m of measurements) {
    if (measurementsByVariant[m.variant_id]) measurementsByVariant[m.variant_id].push(m);
  }

  // Sort measurements by time to build actual timeline
  const sortedMeasurements = [...measurements].sort((a: any, b: any) =>
    new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime()
  );

  // Add actual run slots
  for (let i = 0; i < sortedMeasurements.length; i++) {
    const m = sortedMeasurements[i];
    const variant = variants.find((v: any) => v.id === m.variant_id);
    if (!variant) continue;
    const slotTime = new Date(m.measured_at.endsWith('Z') ? m.measured_at : m.measured_at + 'Z');
    schedule.push({
      slotIndex: i,
      cycle: measurementsByVariant[m.variant_id].indexOf(m),
      variant,
      variantIndex: variants.indexOf(variant),
      slotTime,
      isActive: false,
      isShown: true,
      measurement: m,
    });
  }

  // Find currently active variant - add its active slot to the schedule
  const activeVariant = variants.find((v: any) => v.active_since);
  if (activeVariant) {
    const activeTime = new Date(activeVariant.active_since.endsWith('Z') ? activeVariant.active_since : activeVariant.active_since + 'Z');
    // Check if this active session already has a measurement in the schedule
    const hasSlot = schedule.some(s => s.variant.id === activeVariant.id && s.slotTime && Math.abs(s.slotTime.getTime() - activeTime.getTime()) < 3600000);
    if (!hasSlot) {
      // Add the current LIVE slot
      schedule.push({
        slotIndex: schedule.length,
        cycle: schedule.filter(s => s.variant.id === activeVariant.id).length,
        variant: activeVariant,
        variantIndex: variants.indexOf(activeVariant),
        slotTime: activeTime,
        isActive: true,
        isShown: true,
        measurement: null,
      });
    } else {
      // Mark existing slot as active
      const activeSlots = schedule.filter(s => s.variant.id === activeVariant.id);
      if (activeSlots.length > 0) activeSlots[activeSlots.length - 1].isActive = true;
    }
  }

  // Add remaining "Not Shown Yet" slots based on how many slots each variant has used
  const slotsPerVariant: Record<number, number> = {};
  for (const v of variants) {
    slotsPerVariant[v.id] = schedule.filter(s => s.variant.id === v.id).length;
  }

  for (const v of variants) {
    const remaining = timesEach - slotsPerVariant[v.id];
    for (let r = 0; r < remaining; r++) {
      schedule.push({
        slotIndex: schedule.length,
        cycle: slotsPerVariant[v.id] + r,
        variant: v,
        variantIndex: variants.indexOf(v),
        slotTime: null,
        isActive: false,
        isShown: false,
        measurement: null,
      });
    }
  }

  // Aggregate stats per variant - supports single-slot view when a time is clicked
  const selectedMeasurement = selectedSlot ? test.measurements?.find((m: any) => m.id === selectedSlot) : null;

  const variantAgg = variants.map((v: any, i: number) => {
    const slots = schedule.filter(s => s.variant.id === v.id);
    const allMs = test.measurements?.filter((m: any) => m.variant_id === v.id) || [];

    // If a specific slot is selected, only show that measurement for its variant
    let ms: any[];
    if (selectedMeasurement && selectedMeasurement.variant_id === v.id) {
      ms = [selectedMeasurement];
    } else if (selectedMeasurement) {
      ms = []; // Other variants show empty when viewing a single slot
    } else {
      // Headline = COMPLETED hours only. The in-progress ("live") slot is still
      // captured every 20 min and shown in the timeline as "collecting", but its
      // partial number is kept out of the headline so a mid-hour reading never
      // looks like a finished result.
      ms = allMs.filter((m: any) => m.impressions > 0 && !((m.realtime_views_json || '').includes('"live":true')));
    }

    const totalViews = ms.reduce((s: number, m: any) => s + (m.views || 0), 0);
    const totalImp = ms.reduce((s: number, m: any) => s + (m.impressions || 0), 0);
    const totalLikes = ms.reduce((s: number, m: any) => s + (m.likes || 0), 0);
    const totalComments = ms.reduce((s: number, m: any) => s + (m.comments || 0), 0);
    const totalWatchTime = ms.reduce((s: number, m: any) => s + (m.watch_time_hours || 0), 0);
    // Weighted averages: arithmetic mean is wrong when slots have different view counts
    const avgViewDuration = totalViews > 0 ? (totalWatchTime * 3600) / totalViews : 0;
    const avgViewPct = totalViews > 0
      ? ms.reduce((s: number, m: any) => s + (m.views || 0) * (m.avg_view_pct || 0), 0) / totalViews
      : 0;
    const totalSubs = ms.reduce((s: number, m: any) => s + (m.subs_gained || 0), 0);
    // CTR: a manual override (the real Studio VTR) always wins; otherwise impression-weighted measurement CTR.
    const computedCtr = totalImp > 0
      ? ms.reduce((s: number, m: any) => s + (m.impressions || 0) * (m.ctr || 0), 0) / totalImp
      : 0;
    const ctr = v.ctr_override != null ? v.ctr_override : computedCtr;
    // The metric that DECIDES the winner: views per impression.
    const vpi = totalImp > 0 ? (totalViews / totalImp) * 100 : 0;

    return {
      ...v, color: variantColors[i], totalViews, totalImp, totalLikes, totalComments,
      totalWatchTime, avgViewDuration, avgViewPct, totalSubs, ctr, vpi, slots,
      isWinner: (test as any).winner_variant_id === v.id,
      _allMeasurements: allMs,
    };
  });

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${statusColors[test.status] || ""}`}>
              {test.status}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${test.test_type === "title" ? "bg-blue-500/15 text-info border-blue-500/30" : test.test_type === "both" ? "bg-primary/15 text-primary border-primary/30" : "bg-purple-500/15 text-purple-500 border-purple-500/30"}`}>
              {test.test_type === "title" ? "Title test" : test.test_type === "both" ? "Title + Thumbnail test" : "Thumbnail test"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              Rotating {test.test_type === "title" ? "titles" : test.test_type === "both" ? "titles + thumbnails" : "thumbnails"} · {isHourly ? "Hourly" : "Daily"} · {(test as any).test_format || "Classic"} format
            </span>
          </div>
          <h1 className="text-xl font-bold">{test.video_title || test.video_id}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {test.status === "pending" && (
            <>
              <button onClick={() => handleAction("start")} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">Start Test</button>
              <button onClick={handleEditSchedule} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent">Edit Time</button>
              <button onClick={() => handleAction("delete")} className="px-3 py-1.5 text-xs border border-red-500/50 text-neg rounded-lg hover:bg-red-500/10">Delete</button>
            </>
          )}
          {test.status === "running" && (
            <>
              {/* Start Now - when test is waiting for next hour */}
              {schedule.filter((s: any) => s.isShown).length === 0 && (
                <button onClick={handleStartNow} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">Start Now</button>
              )}
              {/* Add a variant - only before first full cycle */}
              {schedule.filter((s: any) => s.isShown).length < variants.length && (
                test.test_type === "title" ? (
                  addingTitle ? (
                    <form
                      className="flex flex-wrap items-center gap-1.5"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const t = newTitle.trim();
                        if (!t) return;
                        await fetch(`/api/tests/${testId}/variants`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t }) });
                        setNewTitle(""); setAddingTitle(false); mutate();
                      }}
                    >
                      <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New title to test" className="px-2.5 py-1.5 text-xs bg-background border border-border rounded-lg outline-none focus:border-primary flex-1 min-w-[160px] sm:w-64 sm:flex-none" />
                      <button type="submit" disabled={!newTitle.trim()} className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg disabled:opacity-50">Add</button>
                      <button type="button" onClick={() => { setAddingTitle(false); setNewTitle(""); }} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                    </form>
                  ) : (
                    <button onClick={() => setAddingTitle(true)} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent">+ Add Title</button>
                  )
                ) : (
                  <label className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent cursor-pointer">
                    + Add Thumbnail
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const formData = new FormData();
                      formData.append("file", file);
                      await fetch(`/api/tests/${testId}/variants`, { method: "POST", credentials: "include", body: formData });
                      mutate();
                      e.target.value = "";
                    }} />
                  </label>
                )
              )}
              <button onClick={() => handleAction("pause")} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-accent">Cancel</button>
              <button onClick={() => handleAction("complete")} className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90">Complete</button>
            </>
          )}
          {test.status === "paused" && (
            <button onClick={() => handleAction("start")} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">Resume</button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-sm text-neg">{actionError}</div>
      )}

      {/* Upload failure warning */}
      {test.error_msg?.startsWith("upload_fail") && (() => {
        const n = parseInt(test.error_msg.replace("upload_fail:", "")) || 1;
        const paused = test.status === "paused";
        return (
          <div className={`border rounded-lg px-4 py-3 text-sm flex items-start gap-3 ${paused ? "bg-orange-500/10 border-orange-500/30 text-warn" : "bg-yellow-500/10 border-yellow-500/30 text-warn"}`}>
            <span className="text-lg leading-none mt-0.5">{paused ? "⏸" : "⚠"}</span>
            <div>
              <p className="font-medium">{paused ? "Test paused - thumbnail uploads failing" : `Thumbnail upload failed ${n} time${n > 1 ? "s" : ""}`}</p>
              <p className="text-xs opacity-75 mt-1">The Firefox Studio session may have expired. Re-login to Firefox, then {paused ? "resume the test" : "uploads will retry automatically"}.</p>
            </div>
          </div>
        );
      })()}

      {/* Status bar */}
      {test.scheduled_start && test.status === "pending" && (
        <CountdownBar scheduledStart={test.scheduled_start} totalSlots={totalSlots} isHourly={isHourly} />
      )}
      {test.status === "running" && test.started_at && (() => {
        const slotsShown = schedule.filter((s: any) => s.isShown).length;
        const hasStarted = slotsShown > 0;
        const firstCycleComplete = slotsShown >= variants.length;
        return (
        <>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded-xl p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              {hasStarted ? "Time Left" : "Starts In"}
            </p>
            <p className="text-lg font-bold">
              {hasStarted
                ? <RunningTimer startedAt={test.started_at} durationHours={isHourly ? totalSlots : totalSlots * 24} slotsRemaining={totalSlots - slotsShown} isHourly={isHourly} />
                : <CountdownToStart startedAt={test.started_at} />
              }
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Test Length</p>
            <p className="text-lg font-bold">{totalSlots} {isHourly ? "Hours" : "Days"}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Progress</p>
            <p className="text-lg font-bold">{slotsShown}/{totalSlots} slots</p>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground text-center flex items-center justify-center gap-1.5">
          <span className="relative flex size-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-green opacity-75" /><span className="relative inline-flex rounded-full size-1.5 bg-brand-green" /></span>
          {hasStarted
            ? "Live from YouTube every 20 min. The running slot accrues real impressions as they happen; each slot is finalised when its hour completes."
            : "Stats begin once the first slot runs, then refresh live every 20 min from YouTube."}
        </p>
        {hasStarted && (
          <p className="text-[11px] text-muted-foreground text-center">
            Heads up: YouTube underreports the newest ~2 hours of data, so the most recent CTR always reads a little low. It corrects itself as each hour settles, and final results are confirmed after the test ends.
          </p>
        )}
        </>
        );
      })()}

      {/* Completed but YouTube is still settling the final hours of data */}
      {test.status === "completed" && test.completed_at && (() => {
        const raw = String(test.completed_at);
        const completedMs = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z").getTime();
        const hoursLeft = 48 - (Date.now() - completedMs) / 3600000;
        const flip = (() => { try { return test.settled_flip ? JSON.parse(test.settled_flip) : null; } catch { return null; } })();
        if (hoursLeft <= 0 && !flip) return null;
        return (
          <div className="bg-blue-500/10 border border-blue-500/30 text-info rounded-lg px-4 py-3 text-sm space-y-1">
            {hoursLeft > 0 && (
              <p>
                <span className="font-medium">Results still settling.</span> YouTube underreports the final hours of a test, so these numbers keep auto-correcting for about {Math.ceil(hoursLeft)} more {Math.ceil(hoursLeft) === 1 ? "hour" : "hours"}. The winner is re-checked automatically as the data settles, and a final settled report is emailed when it locks in.
              </p>
            )}
            {flip && (
              <p>
                <span className="font-medium">Winner changed during settling:</span> the live data pointed to Variant {flip.from} at completion, but the settled numbers show Variant {flip.to} actually won. The correct variant {hoursLeft > 0 ? "has been" : "was"} applied to the video.
              </p>
            )}
          </div>
        );
      })()}

      {/* The winner, and WHY it won */}
      {test.status === "completed" && test.winner_variant_id && (() => {
        const w = variantAgg.find((v: any) => v.id === test.winner_variant_id);
        if (!w) return null;
        const next = variantAgg
          .filter((v: any) => v.id !== w.id && v.active !== 0)
          .sort((a: any, b: any) => b.vpi - a.vpi)[0];
        return (
          <div className="bg-green-500/10 border border-green-500/30 text-pos rounded-lg px-4 py-3 text-sm">
            <span className="font-semibold">Winner: Variant {w.label}.</span>{" "}
            {test.winner_manual
              ? "Chosen manually. Automatic re-checks will never change a manual decision."
              : <>Highest True CTR (views per impression) at {w.vpi.toFixed(2)}%{next ? <>, ahead of Variant {next.label} at {next.vpi.toFixed(2)}%</> : null}. True CTR is the metric this test decides on.</>}
          </div>
        );
      })()}

      {/* Desktop: grid table */}
      <div className="hidden md:block">
        <StatsTable variantAgg={variantAgg} schedule={schedule} sortBy={sortBy} setSortBy={setSortBy} testId={testId} mutate={mutate} testStatus={test.status} selectedSlot={selectedSlot} setSelectedSlot={setSelectedSlot} />
      </div>

      {/* Mobile: card view */}
      <MobileCards variantAgg={variantAgg} schedule={schedule} testId={testId} mutate={mutate} testStatus={test.status} />

      {/* Pending state */}
      {test.status === "pending" && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Click "Start Test" to begin. The first thumbnail will be uploaded to YouTube at the top of the next hour.
        </div>
      )}
    </div>
  );
}

function StatsTable({ variantAgg, schedule, sortBy, setSortBy, testId, mutate, testStatus, selectedSlot, setSelectedSlot }: { variantAgg: any[]; schedule: any[]; sortBy: string; setSortBy: (s: string) => void; testId: number; mutate: () => void; testStatus: string; selectedSlot: number | null; setSelectedSlot: (id: number | null) => void }) {
  // Compute ranking from FULL data (all slots, ignoring selectedSlot)
  // so column order never changes when clicking a time slot
  const fullData = useMemo(() => {
    if (!selectedSlot) return variantAgg;
    // Recompute without slot selection to get stable sort order
    return variantAgg.map((v: any) => {
      const allMs = (v._allMeasurements || []).filter((m: any) => m.impressions > 0);
      const totalViews = allMs.reduce((s: number, m: any) => s + (m.views || 0), 0);
      const totalImp = allMs.reduce((s: number, m: any) => s + (m.impressions || 0), 0);
      const ctr = totalImp > 0 ? allMs.reduce((s: number, m: any) => s + (m.impressions || 0) * (m.ctr || 0), 0) / totalImp : 0;
      const avgViewDuration = allMs.length > 0 ? allMs.reduce((s: number, m: any) => s + (m.avg_view_duration || 0), 0) / allMs.length : 0;
      const totalWatchTime = allMs.reduce((s: number, m: any) => s + (m.watch_time_hours || 0), 0);
      return { ...v, totalViews, totalImp, ctr, avgViewDuration, totalWatchTime };
    });
  }, [variantAgg, selectedSlot]);

  const sorted = [...fullData].sort((a: any, b: any) => {
    // Soft-removed variants always sort to the end (greyed-out, not competing for winner)
    const ra = a.active === 0 ? 1 : 0, rb = b.active === 0 ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const valA = getStatValue(a, sortBy);
    const valB = getStatValue(b, sortBy);
    return valB - valA;
  });
  // Map sorted order to actual display data (which may show single-slot values)
  const displayed = sorted.map((full: any) => variantAgg.find((v: any) => v.id === full.id) || full);
  const rankOf: Record<number, number> = {};
  sorted.forEach((v: any, i: number) => { rankOf[v.id] = i; });

  const stats = [
    { key: "totalViews", label: "Views", tip: "Total views during this variant's rotation slots", get: (v: any) => v.totalViews.toLocaleString() },
    { key: "vpi", label: "True CTR", tip: "Views per impression - the metric that DECIDES the winner", get: (v: any) => v.vpi.toFixed(2) + "%" },
    { key: "ctr", label: "Studio CTR", tip: "YouTube Studio's reported CTR (VTR) - display only, the winner is NOT decided on this", get: (v: any) => v.ctr.toFixed(2) + "%" },
    { key: "totalImp", label: "Impressions", tip: "How many times the thumbnail was shown to viewers", get: (v: any) => v.totalImp.toLocaleString() },
    { key: "avgViewDuration", label: "Avg View Duration", tip: "How long viewers watched on average", get: (v: any) => fmtDur(v.avgViewDuration) },
    { key: "advCtr", label: "AVD x CTR", tip: "Avg view duration (seconds) multiplied by CTR - higher means the thumbnail attracts viewers who also watch longer", get: (v: any) => (v.avgViewDuration * v.ctr).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
    { key: "avgViewPct", label: "Avg % Watched", tip: "Average percentage of the video watched per view", get: (v: any) => v.avgViewPct.toFixed(1) + "%" },
    { key: "totalWatchTime", label: "Watch Time", tip: "Total hours of watch time across all views", get: (v: any) => fmtWatchTime(v.totalWatchTime) },
    { key: "totalLikes", label: "Likes", tip: "Likes gained during this variant's rotation slots", get: (v: any) => v.totalLikes.toLocaleString() },
    { key: "totalComments", label: "Comments", tip: "Comments gained during this variant's rotation slots", get: (v: any) => v.totalComments.toLocaleString() },
    { key: "totalSubs", label: "Subs Gained", tip: "Net subscribers gained during this variant's rotation slots", get: (v: any) => v.totalSubs.toString() },
  ];

  const cols = displayed.length;
  const rankColors = ["#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899", "#ef4444", "#14b8a6"];

  return (
    <div className="overflow-x-auto -mx-6 px-6">
      <div className="min-w-[700px]">
      {/* Thumbnails row */}
      <div className="grid mb-4" style={{ gridTemplateColumns: `140px repeat(${cols}, 1fr)` }}>
        <div className="flex items-end justify-between px-3 pb-2">
          <div>
            <p className="text-xs font-semibold">Tested Combinations:</p>
            <p className="text-[10px] text-muted-foreground">{selectedSlot ? "Viewing single hour - click time again to show all" : "(in Rotation Order)"}</p>
          </div>
          {selectedSlot && (
            <button onClick={() => setSelectedSlot(null)} className="text-[10px] text-primary hover:underline">Show All</button>
          )}
        </div>
        {displayed.map((v: any) => {
          const rank = rankOf[v.id] ?? 0;
          const slots = schedule.filter((s: any) => s.variant.id === v.id);
          const isActive = slots.some((s: any) => s.isActive);
          const borderColor = rankColors[rank] || rankColors[0];
          const removed = v.active === 0;
          return (
            <div key={`thumb-${v.id}`} className={`px-2 relative group${removed ? " opacity-45 grayscale" : ""}`}>
              {v.thumbnail_path ? (
                <>
                <div className="rounded-lg overflow-hidden border-2 relative" style={{ borderColor: removed ? "#6b7280" : borderColor }}>
                  {v.isWinner && testStatus === "completed" && (
                    <span className="absolute top-1 left-1 z-10 bg-green-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">WINNER</span>
                  )}
                  <img src={`/api/thumb/${v.thumbnail_path.split('/').pop()}`} alt="" className="w-full aspect-video object-cover" />
                  <span className="absolute top-1 left-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md z-10" style={{ backgroundColor: removed ? "#6b7280" : borderColor, color: "white" }}>{removed ? "OUT" : `#${rank + 1}`}</span>
                  <span className="absolute bottom-1 left-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white">{v.label}</span>
                  {removed && <span className="absolute bottom-1 right-1 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-gray-700/90 text-white">REMOVED</span>}
                </div>
                {v.title && <p className="text-[11px] mt-1 leading-tight line-clamp-2 text-muted-foreground" title={v.title}>{v.title}</p>}
                </>
              ) : (
                <div className="rounded-lg border-2 px-2 py-2" style={{ borderColor }}>
                  <p className="text-xs font-medium leading-tight line-clamp-3">{v.title || "No title"}</p>
                  <div className="flex items-center gap-1 mt-1.5">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ backgroundColor: borderColor, color: "white" }}>#{rank + 1}</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted">{v.label}</span>
                  </div>
                </div>
              )}
              {/* Tags */}
              <div className="mt-1">
                <TagSelector testId={Number(testId)} variantId={v.id} initialTags={v.tags || []} compact onTagsChange={() => mutate()} />
              </div>
              {/* 3-dot menu */}
              <div className="absolute top-1 right-3 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const menu = e.currentTarget.nextElementSibling as HTMLElement;
                    document.querySelectorAll('[data-thumb-menu]').forEach(el => { if (el !== menu) el.classList.add('hidden'); });
                    menu.classList.toggle('hidden');
                  }}
                  className="w-6 h-6 flex items-center justify-center bg-black/60 rounded-full text-white hover:bg-black/80"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                </button>
                <div data-thumb-menu className="hidden absolute right-0 top-7 bg-popover border border-border rounded-lg shadow-lg py-1 z-20 min-w-[160px]">
                  <button
                    onClick={async () => {
                      if (!confirm(`Make variant ${v.label} the WINNER and put it live on YouTube? This ends the test with ${v.label} as the recorded winner, and automatic re-checks will not change a manual decision.`)) return;
                      try {
                        await fetch(`/api/tests/${testId}/set-winner`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant_id: v.id }) });
                        mutate();
                      } catch {}
                    }}
                    className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent text-pos"
                  >Make Winner, Set Live</button>
                  {testStatus === "running" && (
                    <button
                      onClick={async () => {
                        if (!confirm(`Remove variant ${v.label}?`)) return;
                        try { await fetch(`/api/tests/${testId}/variants/${v.id}`, { method: "DELETE", credentials: "include" }); mutate(); } catch {}
                      }}
                      className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent text-neg"
                    >Remove from Test</button>
                  )}
                </div>
              </div>
              {isActive && <p className="text-[8px] text-pos font-bold text-center mt-0.5">LIVE</p>}
            </div>
          );
        })}
      </div>

      {/* Dates + Stats table */}
      <div className="grid" style={{ gridTemplateColumns: `170px repeat(${cols}, 1fr)` }}>
        {/* Dates */}
        <div className="px-3 py-2.5 border-b border-border/30 flex items-start">
          <p className="text-xs text-muted-foreground cursor-pointer">Dates</p>
        </div>
        {displayed.map((v: any) => {
          const slots = schedule.filter((s: any) => s.variant.id === v.id);
          return (
            <div key={`d-${v.id}`} className="px-2 py-2.5 border-b border-border/30 text-center space-y-0.5">
              {(() => {
                const shownSlots = slots.filter((s: any) => s.isShown);
                const pendingCount = slots.filter((s: any) => !s.isShown).length;
                return (
                  <>
                    {shownSlots.map((s: any, i: number) => {
                      const isSelected = selectedSlot && s.measurement?.id === selectedSlot;
                      const isLive = (s.measurement?.realtime_views_json || "").includes('"live":true');
                      const canClick = s.measurement?.impressions > 0 && !isLive;
                      if (isLive) {
                        // Current hour: captured live, but shown as "collecting" (not a
                        // partial number) until the hour finishes and the slot finalises.
                        return (
                          <p key={i} className="text-[11px] text-muted-foreground flex items-center justify-center gap-1">
                            <span className="relative flex size-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-green opacity-75" /><span className="relative inline-flex rounded-full size-1.5 bg-brand-green" /></span>
                            {s.slotTime ? fmtSlot(s.slotTime) : "Active"} · collecting
                          </p>
                        );
                      }
                      return (
                        <p key={i}
                          className={`text-[11px] ${canClick ? "cursor-pointer hover:text-primary" : ""} ${isSelected ? "text-primary font-medium" : "text-foreground/80"}`}
                          onClick={() => canClick && setSelectedSlot(isSelected ? null : s.measurement.id)}
                        >
                          {s.slotTime
                            ? fmtSlot(s.slotTime)
                            : "Active"}
                        </p>
                      );
                    })}
                    {pendingCount > 0 && (
                      <p className="text-[11px] text-muted-foreground/40">+{pendingCount} more</p>
                    )}
                  </>
                );
              })()}
            </div>
          );
        })}

        {/* Stats */}
        {stats.map((stat) => {
          // "best" (green highlight) considers active variants only
          const best = Math.max(0, ...displayed.filter((v: any) => v.active !== 0).map((v: any) => getStatValue(v, stat.key)));
          return [
            <div
              key={`l-${stat.key}`}
              className="px-3 py-2.5 border-b border-border/30 cursor-pointer hover:bg-muted/10"
              onClick={() => setSortBy(stat.key)}
            >
              <p className={`text-xs ${sortBy === stat.key ? "text-primary font-medium" : "text-muted-foreground"}`} title={(stat as any).tip || ""}>
                {stat.label}
              </p>
            </div>,
            ...displayed.map((v: any) => {
              const val = getStatValue(v, stat.key);
              const removed = v.active === 0;
              const isBest = !removed && val === best && best > 0;
              return (
                <div key={`v-${stat.key}-${v.id}`} className={`px-2 py-2.5 border-b border-border/30 text-center${removed ? " opacity-45" : ""}`}>
                  <p className={`text-sm font-medium ${isBest ? "text-pos" : "text-foreground/90"}`}>
                    {stat.get(v)}
                  </p>
                </div>
              );
            }),
          ];
        })}
      </div>
      </div>
    </div>
  );
}

function MobileCards({ variantAgg, schedule, testId, mutate, testStatus }: { variantAgg: any[]; schedule: any[]; testId: number; mutate: () => void; testStatus: string }) {
  const sorted = [...variantAgg].sort((a: any, b: any) => {
    // soft-removed (greyed) variants always sort to the end
    const ra = a.active === 0 ? 1 : 0, rb = b.active === 0 ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ctrA = a.ctr || 0;
    const ctrB = b.ctr || 0;
    return ctrB - ctrA;
  });

  const rankColors = ["#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#06b6d4"];

  const stats = [
    { label: "Views", tip: "Total views during this variant's rotation slots", get: (v: any) => v.totalViews.toLocaleString() },
    { label: "True CTR", tip: "Views per impression - the metric that DECIDES the winner", get: (v: any) => v.vpi.toFixed(2) + "%", highlight: true },
    { label: "Studio CTR", tip: "YouTube Studio's reported CTR (VTR) - display only, the winner is NOT decided on this", get: (v: any) => v.ctr.toFixed(2) + "%" },
    { label: "Impressions", tip: "How many times the thumbnail was shown to viewers", get: (v: any) => v.totalImp.toLocaleString() },
    { label: "Avg View Duration", tip: "How long viewers watched on average", get: (v: any) => fmtDur(v.avgViewDuration) },
    { label: "AVD x CTR", tip: "Avg view duration (seconds) multiplied by CTR - higher means the thumbnail attracts viewers who also watch longer", get: (v: any) => (v.avgViewDuration * v.ctr).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
    { label: "Avg % Watched", tip: "Average percentage of the video watched per view", get: (v: any) => v.avgViewPct.toFixed(1) + "%" },
    { label: "Watch Time", tip: "Total hours of watch time across all views", get: (v: any) => fmtWatchTime(v.totalWatchTime) },
    { label: "Likes", tip: "Likes gained during this variant's rotation slots", get: (v: any) => v.totalLikes.toLocaleString() },
    { label: "Comments", tip: "Comments gained during this variant's rotation slots", get: (v: any) => v.totalComments.toLocaleString() },
    { label: "Subs Gained", tip: "Net subscribers gained during this variant's rotation slots", get: (v: any) => v.totalSubs.toString() },
  ];

  return (
    <div className="md:hidden space-y-3">
      {sorted.map((v: any, rank: number) => {
        const slots = schedule.filter((s: any) => s.variant.id === v.id);
        const isActive = slots.some((s: any) => s.isActive);
        const removed = v.active === 0;
        const borderColor = removed ? "#6b7280" : (rankColors[rank] || rankColors[0]);

        return (
          <div key={v.id} className={`bg-card border rounded-xl overflow-hidden${removed ? " opacity-45 grayscale" : ""}`} style={{ borderColor: rank === 0 && !removed ? borderColor : undefined }}>
            {/* Thumbnail or title + rank */}
            {v.thumbnail_path ? (
              <>
              <div className="relative">
                <img src={`/api/thumb/${v.thumbnail_path.split('/').pop()}`} alt="" className="w-full aspect-video object-cover" />
                <div className="absolute top-2 left-2 flex items-center gap-1.5">
                  <span className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ backgroundColor: borderColor, color: "white" }}>{removed ? "OUT" : `#${rank + 1}`}</span>
                  {isActive && !removed && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-500/90 text-white">LIVE</span>}
                  {removed && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-700/90 text-white">REMOVED</span>}
                </div>
              </div>
              {v.title && <p className="px-3 pt-2 text-xs font-medium leading-tight text-muted-foreground">{v.title}</p>}
              </>
            ) : (
              <div className="px-3 pt-3 pb-1">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-xs font-bold px-2 py-0.5 rounded-md" style={{ backgroundColor: borderColor, color: "white" }}>{removed ? "OUT" : `#${rank + 1}`}</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted">{v.label}</span>
                  {isActive && !removed && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-500/90 text-white">LIVE</span>}
                  {removed && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-700/90 text-white">REMOVED</span>}
                </div>
                <p className="text-sm font-medium leading-tight">{v.title || "No title"}</p>
              </div>
            )}

            {/* Stats */}
            <div className="p-3 space-y-1.5">
              {/* Tags */}
              <div className="mb-2">
                <TagSelector testId={testId} variantId={v.id} initialTags={v.tags || []} compact onTagsChange={() => mutate()} />
              </div>

              {/* Dates */}
              <div className="flex flex-wrap gap-1 mb-2">
                {slots.map((s: any, i: number) => (
                  <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${s.isShown ? "bg-muted text-foreground/80" : "bg-muted/50 text-muted-foreground/60"}`}>
                    {s.slotTime
                      ? (s.isShown
                        ? fmtSlot(s.slotTime)
                        : "Pending")
                      : "Pending"}
                  </span>
                ))}
              </div>

              {/* Stat rows */}
              {stats.map((stat, i) => {
                const val = stat.get(v);
                return (
                  <div key={i} className="flex items-center justify-between py-0.5">
                    <span className="text-[11px] text-muted-foreground" title={(stat as any).tip || ""}>{stat.label}</span>
                    <span className={`text-sm font-medium ${stat.highlight && rank === 0 ? "text-pos" : ""}`}>{val}</span>
                  </div>
                );
              })}

              {/* Make Winner button: ends the test with this variant as the recorded winner */}
              <button
                onClick={async () => {
                  if (!confirm(`Make variant ${v.label} the WINNER and put it live on YouTube? This ends the test with ${v.label} as the recorded winner, and automatic re-checks will not change a manual decision.`)) return;
                  try {
                    await fetch(`/api/tests/${testId}/set-winner`, {
                      method: "POST", credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ variant_id: v.id }),
                    });
                    mutate();
                  } catch {}
                }}
                className="w-full mt-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                Make Winner, Set Live
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getStatValue(v: any, key: string): number {
  if (key === "advCtr") return v.avgViewDuration * v.ctr;
  return v[key] || 0;
}

function fmtWatchTime(hours: number): string {
  if (!hours) return "0:00:00";
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  const s = Math.floor(((hours - h) * 60 - m) * 60);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function fmtDur(seconds: number): string {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CountdownToStart({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const start = new Date(startedAt).getTime();
  const diff = start - now;
  if (diff <= 0) return <span className="text-pos">Starting now</span>;

  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return <span className="text-primary">{h > 0 ? `${h}h ` : ""}{m}m {s}s</span>;
}

function CountdownBar({ scheduledStart, totalSlots, isHourly }: { scheduledStart: string; totalSlots: number; isHourly: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const start = new Date(scheduledStart).getTime();
  const diff = start - now;
  if (diff <= 0) return null;

  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="bg-card border border-border rounded-xl p-3 text-center">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Test Begins In</p>
        <p className="text-lg font-bold text-primary">{d > 0 ? `${d}d` : ""}{h.toString().padStart(2, "0")}h{m.toString().padStart(2, "0")}m{s.toString().padStart(2, "0")}s</p>
        <p className="text-[10px] text-muted-foreground mt-1">{new Date(scheduledStart).toLocaleString()}</p>
      </div>
      <div className="bg-card border border-border rounded-xl p-3 text-center">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Test Length</p>
        <p className="text-lg font-bold">{totalSlots} {isHourly ? "Hours" : "Days"}</p>
      </div>
      <div className="bg-card border border-border rounded-xl p-3 text-center">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Status</p>
        <p className="text-lg font-bold text-warn">Waiting</p>
      </div>
    </div>
  );
}

function RunningTimer({ startedAt, durationHours, slotsRemaining, isHourly }: { startedAt: string; durationHours: number; slotsRemaining: number; isHourly: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Use slots remaining instead of start time -- accounts for stalls
  const hoursPerSlot = isHourly ? 1 : 24;
  const remainingMs = slotsRemaining * hoursPerSlot * 3600000;
  if (slotsRemaining <= 0) return <span className="text-muted-foreground">Completed</span>;

  const h = Math.floor(remainingMs / 3600000);
  const m = Math.floor((remainingMs % 3600000) / 60000);
  return <span>{h}h {m}m</span>;
}
