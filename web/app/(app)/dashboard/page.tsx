"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { tests as testsApi, learnings, channelStats, competitorIntel, proposals as proposalsApi, retentionMoments } from "@/lib/api";
import type { CompetitorGrowthFinding, ProposalPack, ChannelForecast, RetentionMomentsResponse } from "@/lib/api";
import type { TestSummary } from "@/lib/api";
import { TestReviewModal, type ReviewState } from "@/components/test-review-modal";

const apiFetch = (url: string) => fetch(url, { credentials: "include" }).then(r => r.json());

function useCountdown(expiresAt: string | null | undefined) {
  const [timeLeft, setTimeLeft] = useState("");
  const [urgency, setUrgency] = useState<"ok" | "warn" | "danger">("ok");

  useEffect(() => {
    if (!expiresAt) return;
    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("Expired");
        setUrgency("danger");
        return;
      }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (days > 0) setTimeLeft(`${days}d ${hours}h`);
      else if (hours > 0) setTimeLeft(`${hours}h ${mins}m`);
      else setTimeLeft(`${mins}m`);

      if (days < 1) setUrgency("danger");
      else if (days < 3) setUrgency("warn");
      else setUrgency("ok");
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return { timeLeft, urgency };
}

const statusColors: Record<string, string> = {
  running: "bg-green-500/20 text-pos border-green-500/30",
  pending: "bg-yellow-500/20 text-warn border-yellow-500/30",
  completed: "bg-blue-500/20 text-info border-blue-500/30",
  paused: "bg-orange-500/20 text-warn border-orange-500/30",
  failed: "bg-red-500/20 text-neg border-red-500/30",
};

export default function DashboardPage() {
  const { data: allTests } = useSWR("all-tests", () => testsApi.list(undefined, "all"), { refreshInterval: 30000 });
  const { data: ytAuthStatus } = useSWR("yt-auth-status", () => apiFetch("/api/youtube-auth/status"), { refreshInterval: 60000 });
  const { data: portfolio } = useSWR("learnings-portfolio", () => learnings.portfolio());
  const { data: suggestions, mutate: mutateSuggestions } = useSWR("title-suggestions", () => testsApi.titleSuggestions());
  const { data: revive } = useSWR("revive-candidates", () => testsApi.reviveCandidates());
  const { data: chanStats } = useSWR("channel-stats", () => channelStats.get(), { refreshInterval: 3_600_000 });
  const { data: liveSubs } = useSWR("live-subs", () => channelStats.liveSubs(), { refreshInterval: 45000 });
  const { data: growthFindings } = useSWR("competitor-growth-findings", () => competitorIntel.findings(8), { refreshInterval: 3_600_000 });
  const { data: pendingProposals, mutate: mutateProposals } = useSWR("proposals-pending", () => proposalsApi.list('pending'), { refreshInterval: 300_000 });
  const { data: retentionData } = useSWR("retention-moments", () => retentionMoments.get(), { refreshInterval: 3_600_000 });
  const { data: forecast } = useSWR("channel-forecast", () => channelStats.forecast(), { refreshInterval: 600_000 });
  const [testingVid, setTestingVid] = useState<string | null>(null);
  const [expandedVid, setExpandedVid] = useState<string | null>(null);
  const [retestingVid, setRetestingVid] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState>(null);
  const [pitching, setPitching] = useState(false);
  const router = useRouter();
  const { timeLeft, urgency } = useCountdown(ytAuthStatus?.expiresAt);

  const testSuggestion = async (videoId: string, suggested: string) => {
    if (!confirm(`Start a live A/B title test?\n\nControl: the current title\nChallenger: "${suggested}"\n\nThe title will start rotating on YouTube on the next hour.`)) return;
    setTestingVid(videoId);
    try {
      const r = await testsApi.testSuggestedTitle(videoId);
      await mutateSuggestions();
      if (r.test_id) router.push(`/tests/${r.test_id}`);
    } catch { alert("Could not start the test. Try again."); } finally { setTestingVid(null); }
  };

  const retestThumb = async (videoId: string, chain: boolean) => {
    if (!confirm(`Re-run this video's thumbnail A/B test${chain ? ", then auto-start a title test when it finishes" : ""}?\n\nIt reuses the thumbnails you already made and starts rotating on YouTube on the next hour.`)) return;
    setRetestingVid(videoId);
    try {
      const r = await testsApi.retestThumbnail(videoId, chain);
      if (r.test_id) router.push(`/tests/${r.test_id}`);
      else alert(r.detail || "Could not start the re-test.");
    } catch (e: any) { alert(e?.message || "Could not start the re-test."); } finally { setRetestingVid(null); }
  };

  const pitchPrerelease = async () => {
    setPitching(true);
    try {
      const r = await testsApi.prereleaseBrief();
      if (r.pitched > 0) { router.push("/ai-chat"); }
      else alert("No new pre-release episodes ready yet. They need to finish transcribing first, then hit this again.");
    } catch { alert("Could not check pre-release."); } finally { setPitching(false); }
  };

  const running = allTests?.filter((t) => t.status === "running") || [];
  const completed = allTests?.filter((t) => t.status === "completed") || [];
  const total = allTests?.length || 0;

  // Retests done in the last 7 days vs the 7 days before that.
  const DAY = 86400000;
  const nowMs = Date.now();
  const retests = allTests?.filter((t) => (t as any).category === "retest") || [];
  const retestsIn = (from: number, to: number) =>
    retests.filter((t) => { const age = nowMs - new Date(t.created_at).getTime(); return age >= from && age < to; }).length;
  const retestLast7 = retestsIn(0, 7 * DAY);
  const retestPrev7 = retestsIn(7 * DAY, 14 * DAY);
  const retestDelta = retestLast7 - retestPrev7;
  const retestSub =
    retestDelta === 0
      ? "no change vs prev 7d"
      : `${retestDelta > 0 ? "▲ +" : "▼ "}${retestDelta} vs prev 7d`;
  const retestSubColor = retestDelta > 0 ? "text-pos" : retestDelta < 0 ? "text-neg" : "text-muted-foreground";

  // Tests that need you: upload failures, paused, or errored — surfaced so they
  // don't sit broken in /tests unnoticed.
  const attention = (allTests || []).filter((t) =>
    (t as any).error_msg?.startsWith("upload_fail") || t.status === "paused" || t.status === "failed"
  ).slice(0, 5);

  // Completed tests with a winner — the results, surfaced so you don't hunt for them.
  const results = (allTests || [])
    .filter((t) => t.status === "completed" && (t as any).winner_variant_id)
    .sort((a, b) => new Date((b as any).completed_at || b.created_at).getTime() - new Date((a as any).completed_at || a.created_at).getTime())
    .slice(0, 6);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-2">
          {ytAuthStatus && !ytAuthStatus.valid && (
            <a
              href="/api/youtube-auth/connect"
              className="px-3 py-1.5 text-xs border border-red-500/30 text-neg rounded-lg hover:bg-red-500/10 transition-colors"
            >
              Reconnect YouTube
            </a>
          )}
          {ytAuthStatus?.valid && (
            <a
              href="/api/youtube-auth/connect"
              className={`inline-flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${
                urgency === "danger"
                  ? "bg-red-500/15 text-neg border-red-500/30 hover:bg-red-500/25"
                  : urgency === "warn"
                  ? "bg-yellow-500/15 text-warn border-yellow-500/30 hover:bg-yellow-500/25"
                  : "bg-green-500/15 text-pos border-green-500/30 hover:bg-green-500/25"
              }`}
              title="Click to reconnect YouTube OAuth"
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                urgency === "danger" ? "bg-red-400 animate-pulse" : urgency === "warn" ? "bg-yellow-400" : "bg-green-400"
              }`} />
              YT {timeLeft ? `expires ${timeLeft}` : "Connected"}
            </a>
          )}
          <button onClick={pitchPrerelease} disabled={pitching} className="px-3 py-2 border border-border rounded-lg text-sm font-medium hover:bg-accent disabled:opacity-50">{pitching ? "Checking…" : "Pitch pre-release"}</button>
          <Link
            href="/tests/new"
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            New Test
          </Link>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: "Total Tests", value: total, color: "text-primary", sub: null as React.ReactNode },
          { label: "Active Tests", value: running.length, color: "text-pos", sub: null },
          { label: "Completed", value: completed.length, color: "text-info", sub: null },
          { label: "Avg CTR Lift", value: portfolio ? `+${portfolio.avg_confident_lift}%` : "--", color: "text-pos", sub: null },
          { label: "Retests (7d)", value: retestLast7, color: "text-primary", sub: <span className={retestSubColor}>{retestSub}</span> },
        ].map((s) => (
          <div key={s.label} className="bg-card border border-border rounded-xl p-4">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            {s.sub && <p className="text-[11px] mt-0.5 font-medium">{s.sub}</p>}
          </div>
        ))}
      </div>

      {/* 2026 Goals */}
      {chanStats && (
        <GoalTracker goals={chanStats.goals} liveSubs={liveSubs?.subscribers_exact} subsPerSec={liveSubs?.subs_per_second} forecast={forecast} />
      )}

      {/* Episode Proposals */}
      {pendingProposals && pendingProposals.length > 0 && (
        <ProposalsSection proposals={pendingProposals} onMutate={mutateProposals} />
      )}

      {/* Retention intelligence */}
      {retentionData && (retentionData.videos.length > 0 || retentionData.segment_scorecard.length > 0) && (
        <RetentionSection data={retentionData} />
      )}

      {/* Two columns: act-on-it (left) and what's-happening (right), so it all fits without a long scroll */}
      <div className="grid lg:grid-cols-2 gap-6 items-start">
      <div className="space-y-6">

      {/* Needs attention — broken/stuck tests surfaced first */}
      {attention.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-neg uppercase tracking-wide mb-3">Needs attention</h2>
          <div className="space-y-2">
            {attention.map((t) => {
              const why = (t as any).error_msg?.startsWith("upload_fail") ? "Thumbnail upload failed" : t.status === "paused" ? "Paused" : "Failed";
              return (
                <Link key={t.id} href={`/tests/${t.id}`} className="bg-card border border-red-500/30 rounded-xl px-4 py-3 hover:border-red-500/50 transition-colors flex items-center gap-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                  <span className="text-sm font-medium truncate flex-1">{t.video_title || t.video_id}</span>
                  <span className="text-[11px] text-neg shrink-0">{why}</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Proactive title suggestions for recently published videos */}
      {suggestions && suggestions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Titles worth testing</h2>
          <p className="text-xs text-muted-foreground mb-3">Fresh alternatives for recent videos, researched from our A/B winners, competitors, the thumbnail and the transcript. Only shown when it looks genuinely better than the current title.</p>
          <div className="space-y-2">
            {suggestions.slice(0, 6).map((s) => {
              const open = expandedVid === s.video_id;
              return (
                <div key={s.video_id} className="bg-card border border-border rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    {s.thumbnail_url && <img src={s.thumbnail_url} alt="" className="w-20 h-11 object-cover rounded shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-muted-foreground line-through truncate">{s.current_title}</p>
                      <p className="text-sm font-semibold text-foreground leading-snug">{s.suggested_title}</p>
                      <button onClick={() => setExpandedVid(open ? null : s.video_id)} className="text-[11px] text-info hover:underline mt-1">{open ? "Hide details" : "Why + thumbnail idea"}</button>
                      {open && (
                        <div className="mt-1.5 space-y-1.5">
                          <p className="text-[11px] text-muted-foreground leading-relaxed">{s.reasoning}</p>
                          {s.thumbnail_concept && <p className="text-[11px] leading-relaxed"><span className="font-semibold text-foreground/70">Thumbnail:</span> <span className="text-muted-foreground">{s.thumbnail_concept}</span></p>}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button onClick={() => setReview({ mode: "title", videoId: s.video_id, control: s.current_title, challenger: s.suggested_title })} disabled={testingVid === s.video_id} className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap">{testingVid === s.video_id ? "Starting…" : "Test title"}</button>
                      <Link href={`/tests/new?video=${s.video_id}&type=thumbnail&title=${encodeURIComponent(s.current_title)}`} className="text-xs px-3 py-1.5 border border-border rounded-lg font-medium hover:bg-accent text-center whitespace-nowrap">Test thumbnail</Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Worth reviving — older videos the algorithm is pushing but the packaging loses the click */}
      {revive && revive.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">Worth reviving</h2>
          <p className="text-xs text-muted-foreground mb-3">Older videos the algorithm is <span className="font-medium text-foreground/80">already showing</span> (high impressions) but the packaging is losing the click. Repackage these to win back views weeks after publishing.</p>
          <div className="space-y-2">
            {revive.slice(0, 5).map((r) => (
              <div key={r.video_id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
                {r.thumbnail_url && <img src={r.thumbnail_url} alt="" className="w-20 h-11 object-cover rounded shrink-0" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{r.title}</p>
                  <p className="text-[11px] text-muted-foreground">{(r.impressions / 1000000).toFixed(1)}M impressions · {r.ctr}% CTR · {Math.round(r.avg_pct_watched * 100)}% watched</p>
                </div>
                {r.has_prior_thumb ? (
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button onClick={() => setReview({ mode: "thumb", videoId: r.video_id, title: r.title, chain: false })} disabled={retestingVid === r.video_id} className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap">{retestingVid === r.video_id ? "Starting…" : "Re-test thumbnail"}</button>
                    <button onClick={() => setReview({ mode: "thumb", videoId: r.video_id, title: r.title, chain: true })} disabled={retestingVid === r.video_id} title="Runs the thumbnail test, then auto-starts a title test when it finishes" className="text-xs px-3 py-1.5 border border-border rounded-lg font-medium hover:bg-accent disabled:opacity-50 whitespace-nowrap">then title →</button>
                  </div>
                ) : (
                  <Link href={`/tests/new?video=${r.video_id}&type=both&title=${encodeURIComponent(r.title)}`} className="shrink-0 text-xs px-3 py-1.5 border border-border rounded-lg font-medium hover:bg-accent whitespace-nowrap">Repackage</Link>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      </div>{/* end left column */}
      <div className="space-y-6">

      {/* What Grew Them — competitor growth signals ranked by uplift */}
      {growthFindings && growthFindings.length > 0 && (
        <WhatGrewThem findings={growthFindings} />
      )}

      {/* Latest results — surfaced so you act on them instead of hunting in /tests */}
      {results.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Latest results</h2>
          <div className="space-y-2">
            {results.map((t) => {
              const w = t.variants?.find((v: any) => v.id === (t as any).winner_variant_id);
              const thumb = w?.thumbnail_path ? `/api/thumb/${w.thumbnail_path.split("/").pop()}` : (t as any).video_thumbnail_url;
              const whatWon = t.test_type === "title" ? `"${w?.title}"` : t.test_type === "both" ? `${w?.label} — "${w?.title}"` : `variant ${w?.label} (thumbnail)`;
              return (
                <Link key={t.id} href={`/tests/${t.id}`} className="bg-card border border-border rounded-xl px-4 py-3 hover:border-primary/40 transition-colors flex items-center gap-3">
                  {thumb && <img src={thumb} alt="" className="w-20 h-11 object-cover rounded shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{t.video_title || t.video_id}</p>
                    <p className="text-[11px] text-muted-foreground truncate">Winner: {whatWon}</p>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-green/15 text-pos border border-brand-green/30 shrink-0">Won</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Active tests */}
      {running.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Running</h2>
          <div className="space-y-2">
            {running.map((t) => <TestRow key={t.id} test={t} />)}
          </div>
        </section>
      )}

      {/* Recent tests */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Recent</h2>
        {allTests && allTests.length > 0 ? (
          <div className="space-y-2">
            {allTests.slice(0, 8).map((t) => <TestRow key={t.id} test={t} />)}
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
            No tests yet. Create your first test to get started.
          </div>
        )}
      </section>

      </div>{/* end right column */}
      </div>{/* end two-column grid */}
      <TestReviewModal state={review} onClose={() => setReview(null)} onStarted={mutateSuggestions} />
    </div>
  );
}

const bandColor: Record<string, string> = {
  'top quartile': 'text-pos',
  'above median': 'text-green-400',
  'around median': 'text-warn',
  'below median': 'text-neg',
};

function ProposalCard({ pack, onDismiss, onTestCreated }: { pack: ProposalPack; onDismiss: () => void; onTestCreated: () => void }) {
  const [videoId, setVideoId] = useState(pack.video_id || '');
  const [creating, setCreating] = useState<number | null>(null);
  const isVideoProposal = pack.source === 'video';

  const createTest = async (titleIndex: number) => {
    const vid = videoId.trim();
    if (!vid) { alert('Enter a YouTube video ID first.'); return; }
    if (!confirm(`Create a title test for:\n"${pack.titles[titleIndex]?.title}"\non video ${vid}?`)) return;
    setCreating(titleIndex);
    try {
      await proposalsApi.createTest(pack.id, { title_index: titleIndex, video_id: vid });
      onTestCreated();
    } catch (e: any) { alert(e?.message || 'Could not create test'); } finally { setCreating(null); }
  };

  return (
    <div className={`bg-card border rounded-xl p-4 space-y-3 ${isVideoProposal ? 'border-primary/30' : 'border-border'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm">{pack.episode_title}</p>
            {isVideoProposal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">upcoming</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{new Date(pack.created_at).toLocaleDateString()}</p>
        </div>
        <button onClick={onDismiss} className="text-xs text-muted-foreground hover:text-neg transition-colors shrink-0">Dismiss</button>
      </div>

      <div className="space-y-2">
        {pack.titles.map((t, i) => (
          <div key={i} className="bg-background border border-border rounded-lg px-3 py-2 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium leading-snug">{t.title}</p>
              <span className={`text-xs font-bold shrink-0 ${bandColor[t.preflight?.ctr_band] || 'text-muted-foreground'}`}>
                {t.preflight?.score ?? '–'}/100
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t.pattern}</p>
            <button
              onClick={() => createTest(i)}
              disabled={creating !== null}
              className="mt-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded px-2 py-0.5 transition-colors disabled:opacity-40"
            >
              {creating === i ? 'Creating…' : 'Create test'}
            </button>
          </div>
        ))}
      </div>

      {pack.thumbnails.length > 0 && (
        <div className="border-t border-border pt-2 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Thumbnail concepts</p>
          {pack.thumbnails.map((th, i) => (
            <p key={i} className="text-xs text-foreground/80">{i + 1}. {th.concept}</p>
          ))}
        </div>
      )}

      <div className="border-t border-border pt-2">
        <p className="text-xs text-muted-foreground mb-1">Test plan: <span className="text-foreground">{pack.test_plan?.first} first</span> — {pack.test_plan?.rationale}</p>
        {!isVideoProposal && (
          <div className="flex items-center gap-2 mt-1">
            <input
              type="text"
              value={videoId}
              onChange={e => setVideoId(e.target.value)}
              placeholder="YouTube video ID (e.g. dQw4w9WgXcQ)"
              className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-none focus:border-primary/50"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ProposalsSection({ proposals, onMutate }: { proposals: ProposalPack[]; onMutate: () => void }) {
  const dismiss = async (id: number) => {
    await proposalsApi.dismiss(id);
    onMutate();
  };

  const upcomingCount = proposals.filter(p => p.source === 'video').length;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-primary uppercase tracking-wide">Episode Proposals</h2>
        {upcomingCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">{upcomingCount} upcoming</span>}
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-2 gap-4">
        {proposals.map(p => (
          <ProposalCard
            key={p.id}
            pack={p}
            onDismiss={() => dismiss(p.id)}
            onTestCreated={onMutate}
          />
        ))}
      </div>
    </section>
  );
}

const findingTypeIcon: Record<string, string> = {
  title_pattern:   "T",
  video_length:    "⏱",
  cadence:         "📈",
  thumbnail_style: "🖼",
};

function FindingExamples({ ev }: { ev?: string | null }) {
  let examples: { title: string; views_k: number }[] = [];
  try { examples = JSON.parse(ev || "{}").examples || []; } catch { /* no examples */ }
  if (!examples.length) return null;
  const views = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(1)}M` : `${k}k`);
  return (
    <div className="mt-1.5 pl-2 border-l border-border/60 space-y-0.5">
      {examples.map((e, i) => (
        <p key={i} className="text-[11px] text-foreground/70 leading-snug truncate">
          <span className="text-muted-foreground">“</span>{e.title}<span className="text-muted-foreground">”</span>
          <span className="text-muted-foreground/60 tabular-nums"> · {views(e.views_k)}</span>
        </p>
      ))}
    </div>
  );
}

const verdictStyle: Record<string, string> = {
  holds: "text-pos",
  sheds: "text-neg",
  neutral: "text-muted-foreground",
};

function RetentionSection({ data }: { data: RetentionMomentsResponse }) {
  const { videos, segment_scorecard } = data;
  const hasVideos = videos.length > 0;
  const hasScorecard = segment_scorecard.length > 0;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Retention</h2>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {hasVideos && videos.slice(0, 3).map(v => (
          <div key={v.video_id} className="bg-card border border-border rounded-xl p-4 space-y-2.5">
            <div className="flex items-center gap-2 min-w-0">
              {v.thumbnail_url && <img src={v.thumbnail_url} alt="" className="w-16 h-9 rounded object-cover shrink-0" />}
              <p className="text-xs font-medium truncate leading-tight">{v.title}</p>
            </div>
            {v.drop_moments.map((m, i) => (
              <div key={i} className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-neg">drop</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{m.timecode}</span>
                  <span className="text-[10px] text-neg tabular-nums">{m.delta_pct}%/bucket</span>
                  {m.segment_type !== 'discussion' && <span className="text-[9px] px-1 rounded bg-muted text-muted-foreground">{m.segment_type}</span>}
                </div>
                {m.transcript_quote && <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2 italic">"{m.transcript_quote.slice(0, 120)}"</p>}
              </div>
            ))}
            {v.hold_moments.map((m, i) => (
              <div key={i} className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-pos">hold</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{m.timecode}</span>
                  <span className="text-[10px] text-pos tabular-nums">+{m.delta_pct}%</span>
                  {m.segment_type !== 'discussion' && <span className="text-[9px] px-1 rounded bg-muted text-muted-foreground">{m.segment_type}</span>}
                </div>
                {m.transcript_quote && <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2 italic">"{m.transcript_quote.slice(0, 120)}"</p>}
              </div>
            ))}
            {v.drop_moments.length === 0 && v.hold_moments.length === 0 && (
              <p className="text-[10px] text-muted-foreground italic">No significant moments detected.</p>
            )}
          </div>
        ))}

        {hasScorecard && (
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Segment types</p>
            <div className="space-y-1.5">
              {segment_scorecard.map(s => (
                <div key={s.segment_type} className="flex items-center gap-2">
                  <span className="text-xs capitalize flex-1">{s.segment_type}</span>
                  <span className={`text-[11px] font-medium tabular-nums ${verdictStyle[s.verdict]}`}>
                    {s.verdict === 'holds' && s.avg_hold_delta != null ? `+${s.avg_hold_delta}%` :
                     s.verdict === 'sheds' && s.avg_drop_delta != null ? `${s.avg_drop_delta}%/bucket` : '—'}
                  </span>
                  <span className={`text-[10px] ${verdictStyle[s.verdict]}`}>{s.verdict}</span>
                  <span className="text-[9px] text-muted-foreground">{s.video_count}v</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function WhatGrewThem({ findings }: { findings: CompetitorGrowthFinding[] }) {
  return (
    <section className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">What Grew Them</h2>
        <a href="/competitors" className="text-[11px] text-info hover:underline">All competitors →</a>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">Patterns that correlate with higher views across tracked competitors — ranked by signal strength.</p>
      <div className="space-y-2">
        {findings.map((f) => (
          <div key={f.id} className="flex items-start gap-2.5">
            <span className="shrink-0 w-6 h-6 rounded bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center mt-0.5">
              {findingTypeIcon[f.finding_type] ?? "·"}
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-medium leading-snug">{f.headline}</p>
              {f.detail && <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{f.detail}</p>}
              <FindingExamples ev={f.evidence_json} />
            </div>
            <span className="shrink-0 text-[10px] text-pos font-semibold mt-0.5 tabular-nums">
              {f.uplift >= 1.25 ? `${f.uplift.toFixed(1)}×` : ""}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function useAnimatedNumber(target: number, duration = 1200) {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current, to = target, start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    prev.current = target;
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// Live subscriber ticker: start from YouTube's (rounded) count and add the real
// per-second growth rate every frame, so the number visibly climbs between
// YouTube's updates — exactly how public live sub counters and TARP Command work.
function useLiveTicker(base: number, perSecond: number) {
  const [val, setVal] = useState(base);
  const anchor = useRef({ base, t: 0 });
  useEffect(() => {
    anchor.current = { base, t: performance.now() };
    setVal(base);
    if (!perSecond || perSecond <= 0) return;
    let raf = 0;
    const tick = () => {
      const elapsed = (performance.now() - anchor.current.t) / 1000;
      setVal(anchor.current.base + perSecond * elapsed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [base, perSecond]);
  return Math.floor(val);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
}

function GoalTracker({ goals, liveSubs, subsPerSec, forecast }: {
  goals: import("@/lib/api").ChannelStatsGoals;
  liveSubs?: number;
  subsPerSec?: number;
  forecast?: ChannelForecast;
}) {
  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
  const pct = (cur: number, goal: number) => Math.min(100, goal > 0 ? (cur / goal) * 100 : 0);
  const growthLabel = (r: number | null) =>
    r === null ? "n/a" : r === 0 ? "already there" : `+${(r * 100).toFixed(1)}%/mo needed`;

  const subs = liveSubs && liveSubs > 0 ? liveSubs : goals.current_subs;
  const animatedSubs = useLiveTicker(subs, subsPerSec || 0);
  const subsPct  = pct(subs, goals.subs_goal);
  const viewsPct = pct(goals.podcast_avg_views_30ep, goals.views_goal);

  const Bar = ({ value, color }: { value: number; color: string }) => (
    <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${value}%` }} />
    </div>
  );

  // Classify projected date vs deadline
  const deadline = new Date('2026-12-31');
  const dateColor = (iso: string | null | undefined) => {
    if (!iso) return 'text-muted-foreground';
    const d = new Date(iso);
    if (d <= deadline) return 'text-pos';
    const overMs = d.getTime() - deadline.getTime();
    return overMs > 90 * 86400000 ? 'text-neg' : 'text-warn';
  };

  const sf = forecast?.subs_forecast;
  const vf = forecast?.views_forecast;
  const bestLever = forecast?.best_lever;

  return (
    <section className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">2026 Goals</h2>
        <span className="text-[11px] text-muted-foreground">{goals.days_left}d left — Dec 31 2026</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium flex items-center gap-1.5">
              Subscribers
              {liveSubs ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" title="Live from YouTube Studio" /> : null}
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">{animatedSubs.toLocaleString()} / {fmt(goals.subs_goal)}</span>
          </div>
          <Bar value={subsPct} color={subsPct >= 90 ? "bg-green-500" : subsPct >= 60 ? "bg-yellow-500" : "bg-primary"} />
          <p className="text-[11px] text-muted-foreground">{growthLabel(goals.subs_monthly_growth_needed)}</p>
          {sf && (
            <p className="text-[11px] tabular-nums">
              <span className="text-muted-foreground">At pace: </span>
              <span className={dateColor(sf.baseline_date)}>{fmtDate(sf.baseline_date)}</span>
              <span className="text-muted-foreground"> · pessimistic {fmtDate(sf.pessimistic_date)}</span>
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium">Avg podcast views <span className="font-normal text-muted-foreground">(last 30 eps)</span></span>
            <span className="text-[11px] text-muted-foreground">{fmt(goals.podcast_avg_views_30ep)} / {fmt(goals.views_goal)}</span>
          </div>
          <Bar value={viewsPct} color={viewsPct >= 90 ? "bg-green-500" : viewsPct >= 60 ? "bg-yellow-500" : "bg-primary"} />
          <p className="text-[11px] text-muted-foreground">{growthLabel(goals.views_monthly_growth_needed)}</p>
          {vf && (
            <p className="text-[11px]">
              <span className="text-muted-foreground">At pace: </span>
              <span className={dateColor(vf.baseline_date)}>{fmtDate(vf.baseline_date)}</span>
            </p>
          )}
        </div>
      </div>
      {bestLever && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-[11px] text-muted-foreground">
            <span className="text-foreground font-medium">Best lever:</span>{" "}
            {bestLever.label}
            {bestLever.views_boost_days > 0 && <span className="text-pos"> · saves ~{bestLever.views_boost_days}d on views goal</span>}
            {bestLever.subs_boost_days > 0 && <span className="text-pos"> · ~{bestLever.subs_boost_days}d on subs</span>}
            {forecast?.confidence === 'low' && <span className="text-muted-foreground"> ({forecast.data_days}d data — wide bands)</span>}
          </p>
        </div>
      )}
    </section>
  );
}

function TestRow({ test }: { test: TestSummary }) {
  const activeVariant = test.variants?.find((v: any) => v.active_since);
  const winnerVariant = (test as any).winner_variant_id ? test.variants?.find((v: any) => v.id === (test as any).winner_variant_id) : null;
  const thumbPath = activeVariant?.thumbnail_path || winnerVariant?.thumbnail_path;
  const thumbUrl = thumbPath
    ? `/api/thumb/${thumbPath.split('/').pop()}`
    : (test as any).video_thumbnail_url;

  return (
    <Link href={`/tests/${test.id}`} className="block">
      <div className="bg-card border border-border rounded-xl px-4 py-3 hover:border-primary/40 transition-colors flex items-center gap-3">
        {thumbUrl && <img src={thumbUrl} alt="" className="w-24 h-14 object-cover rounded shrink-0" />}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${statusColors[test.status] || ""}`}>
            {test.status}
          </span>
          <span className="text-sm font-medium truncate">{test.video_title || test.video_id}</span>
          <span className="hidden sm:inline-block text-[11px] text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">{test.test_type}</span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {test.started_at ? new Date(test.started_at).toLocaleDateString() : new Date(test.created_at).toLocaleDateString()}
        </span>
      </div>
    </Link>
  );
}
