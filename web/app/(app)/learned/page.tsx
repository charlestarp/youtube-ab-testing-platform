"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { learnings, titleInsights, type LearnTagUplift, type LearnTest, type ContentType, type CorpusTag, type AbTitleTag } from "@/lib/api";

function fmtNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toLocaleString();
}

// YouTube comment bodies arrive as HTML (entities + <br> + <a> tags). Turn them
// back into plain readable text for display.
function cleanComment(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TYPE_TABS: { value: ContentType | "all"; label: string }[] = [
  { value: "all", label: "All content" },
  { value: "podcast", label: "Podcast" },
  { value: "TNTL", label: "Try Not To Laugh" },
];

export default function LearnedPage() {
  const [ctype, setCtype] = useState<ContentType | "all">("all");
  const { data, isLoading } = useSWR(["learnings", ctype], () => learnings.get(ctype === "all" ? undefined : ctype));
  const { data: titles } = useSWR("title-insights", () => titleInsights.get());

  if (isLoading || !data) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="h-8 w-64 rounded-lg bg-muted animate-pulse" />
        <div className="h-40 rounded-2xl bg-muted animate-pulse" />
        <div className="grid md:grid-cols-2 gap-4">
          <div className="h-64 rounded-2xl bg-muted animate-pulse" />
          <div className="h-64 rounded-2xl bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  const { portfolio: p, proven, promising, busted, inconclusive, topWins, mentions } = data;
  const provenMoves = [...proven, ...promising];
  const total = Math.max(1, p.total_tests);
  const seg = (n: number) => `${(n / total) * 100}%`;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">What we've learned</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every completed test re-scored for real confidence, not just a declared winner.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {TYPE_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setCtype(t.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                ctype === t.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* The reframe: how many "wins" were actually real */}
      <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
        <p className="font-display text-2xl md:text-[1.75rem] leading-snug font-bold max-w-3xl">
          Of <span className="text-primary">{p.total_tests}</span> completed tests,{" "}
          <span className="text-pos">{p.confident}</span> were confident wins and{" "}
          <span className="text-muted-foreground">{p.coinflip}</span> were really coin flips.
        </p>

        {/* Confidence bar */}
        <div className="mt-6">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
            <div className="bg-brand-green" style={{ width: seg(p.confident) }} title={`${p.confident} confident`} />
            <div className="bg-brand-yellow" style={{ width: seg(p.lean) }} title={`${p.lean} leaning`} />
            <div className="bg-muted-foreground/30" style={{ width: seg(p.coinflip) }} title={`${p.coinflip} coin flips`} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <Legend color="bg-brand-green" label="Confident" value={p.confident} note="90%+ sure" />
            <Legend color="bg-brand-yellow" label="Leaning" value={p.lean} note="75 to 90%" />
            <Legend color="bg-muted-foreground/30" label="Coin flip" value={p.coinflip} note="under 75%" />
          </div>
        </div>

        {/* Headline stats */}
        <div className="mt-7 grid grid-cols-2 sm:grid-cols-3 gap-6">
          <Stat value={"+" + fmtNum(p.extra_views_total)} label="Extra views earned" note="confident wins, during testing" tone="pos" />
          <Stat value={p.avg_confident_lift + "%"} label="Average CTR lift" note="when a win was real" />
          <Stat value={Math.round(p.decisive_rate * 100) + "%"} label="Tests that were decisive" note="confident or leaning" />
        </div>
      </section>

      {/* Proven moves vs busted myths */}
      <section className="grid md:grid-cols-2 gap-4">
        <Panel title="Proven moves" subtitle="Beat their own test's average, across enough tests">
          {provenMoves.length === 0 ? (
            <Empty>
              Still gathering signal. Most tags do not yet clear the bar. Tag more variants (or let the
              thumbnail analysis auto-tag them) to unlock proven moves.
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {provenMoves.map((t) => <TagRow key={t.tag_id} t={t} positive />)}
            </ul>
          )}
        </Panel>

        <Panel title="Genuinely worse" subtitle="These actually underperformed in testing, not just unproven">
          {busted.length === 0 ? (
            <Empty>Nothing has conclusively hurt performance yet.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {busted.slice(0, 8).map((t) => <TagRow key={t.tag_id} t={t} />)}
            </ul>
          )}
        </Panel>
      </section>

      {inconclusive && inconclusive.length > 0 && (
        <section>
          <Panel title="Not proven yet, needs more data" subtitle="Coin flips so far. This does NOT mean they failed, just that we have not gathered enough impressions to be sure. A small CTR gain here can still be real.">
            <ul className="divide-y divide-border">
              {inconclusive.slice(0, 10).map((t) => <TagRow key={t.tag_id} t={t} />)}
            </ul>
          </Panel>
        </section>
      )}

      {/* Biggest wins */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Biggest confident wins</h2>
        <div className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {topWins.map((w) => <WinRow key={w.test_id} w={w} />)}
          {topWins.length === 0 && <Empty>No confident wins yet.</Empty>}
        </div>
      </section>

      {/* Title patterns, split by content type */}
      {titles && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">Title patterns</h2>
          <p className="text-xs text-muted-foreground mb-3">
            <span className="font-medium text-foreground/80">Won/Lost head-to-head</span> is the strongest signal: real A/B tests where only the title changed. Below it, the correlation across <span className="font-medium text-foreground/80">all published titles</span> (view-based, weaker). Podcast and Try Not To Laugh want different things.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            {(ctype === "all" ? (["podcast", "TNTL"] as ContentType[]) : [ctype]).map((ct) => {
              const c = titles.corpus[ct];
              if (!c) return null;
              const ranked = [...c.tags].filter((t) => t.videos >= 4);
              const top = ranked.slice(0, 5);
              const bottom = ranked.slice(-3).reverse().filter((t) => t.lift_vs_median < 1);
              const abAll = [...(titles.ab[ct] || [])].filter((a) => a.tests >= 2).sort((a, b) => b.avg_uplift_pct - a.avg_uplift_pct);
              const abWon = abAll.filter((a) => a.avg_uplift_pct > 0 || a.win_rate >= 0.5).slice(0, 5);
              const abLost = abAll.filter((a) => a.avg_uplift_pct < 0 && a.win_rate < 0.5).slice(0, 4);
              return (
                <div key={ct} className="rounded-2xl border border-border bg-card p-5">
                  <div className="flex items-baseline justify-between mb-3">
                    <h3 className="font-semibold">{ct === "TNTL" ? "Try Not To Laugh" : "Podcast"}</h3>
                    <span className="text-xs text-muted-foreground">{c.total_videos} videos · {fmtNum(c.median_views)} median</span>
                  </div>
                  {/* Strongest signal: head-to-head A/B test wins (same video and thumbnail, only the title changed) */}
                  {abAll.length > 0 ? (
                    <div className="mb-4 rounded-xl bg-muted/40 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70 mb-1.5">Won head-to-head <span className="text-muted-foreground/70 font-medium normal-case">· tested A/B</span></p>
                      <ul className="divide-y divide-border/60">
                        {abWon.map((a) => <AbRow key={a.name} a={a} />)}
                      </ul>
                      {abLost.length > 0 && (
                        <>
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70 mt-3 mb-1.5">Lost head-to-head</p>
                          <ul className="divide-y divide-border/60">
                            {abLost.map((a) => <AbRow key={a.name} a={a} />)}
                          </ul>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="mb-4 text-xs text-muted-foreground italic">No A/B title tests with enough data yet — the correlation below is the best signal for now.</p>
                  )}
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">Helps <span className="normal-case font-normal text-muted-foreground/60">· all titles, view-based</span></p>
                  <ul className="divide-y divide-border">
                    {top.map((t) => <CorpusRow key={t.name} t={t} />)}
                  </ul>
                  {bottom.length > 0 && (
                    <>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mt-3 mb-1.5">Hurts</p>
                      <ul className="divide-y divide-border">
                        {bottom.map((t) => <CorpusRow key={t.name} t={t} />)}
                      </ul>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Brand mentions in the wild */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Toni and Ryan in the wild
        </h2>
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground mb-4">
            <span className="font-display text-2xl font-bold text-foreground">{mentions.total}</span>{" "}
            comments mention Toni and Ryan, including on other channels' videos.
          </p>
          {mentions.recent.length === 0 ? (
            <Empty>No mentions captured yet.</Empty>
          ) : (
            <ul className="space-y-1">
              {mentions.recent.map((m, i) => {
                const href = m.video_id
                  ? `https://www.youtube.com/watch?v=${m.video_id}${m.comment_id ? `&lc=${m.comment_id}` : ""}`
                  : null;
                const Row = (
                  <>
                    <p className="text-foreground">{cleanComment(m.text)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {m.author || "someone"}
                      {m.video_title ? <> on <span className="text-foreground/80">{m.video_title}</span></> : null}
                      {m.is_competitor ? <span className="ml-1.5 inline-flex items-center rounded-full bg-brand-pink/15 text-[#b02e82] dark:text-[#fb9dd8] px-1.5 py-0.5 text-[10px] font-medium">another channel</span> : null}
                    </p>
                  </>
                );
                return (
                  <li key={i} className="text-sm">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="block -mx-2 rounded-lg px-2 py-2 hover:bg-accent transition-colors">
                        {Row}
                      </a>
                    ) : (
                      <div className="py-2">{Row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Legend({ color, label, value, note }: { color: string; label: string; value: number; note: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-full ${color}`} />
      <span className="text-foreground font-medium">{value}</span> {label}
      <span className="text-muted-foreground/70">({note})</span>
    </span>
  );
}

function Stat({ value, label, note, tone }: { value: string; label: string; note?: string; tone?: "pos" }) {
  return (
    <div>
      <div className={`font-display text-3xl font-extrabold tracking-tight ${tone === "pos" ? "text-pos" : "text-foreground"}`}>{value}</div>
      <div className="text-sm font-medium mt-0.5">{label}</div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground mb-3">{subtitle}</p>
      {children}
    </div>
  );
}

function TagRow({ t, positive }: { t: LearnTagUplift; positive?: boolean }) {
  const sign = t.avg_uplift_pct > 0 ? "+" : "";
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color || "#6b7280" }} />
      <span className="text-sm font-medium flex-1 truncate">{t.name}</span>
      <span className="text-xs text-muted-foreground shrink-0">{t.tests} tests · {Math.round(t.win_rate * 100)}% win</span>
      <span className={`text-sm font-semibold tabular-nums shrink-0 w-16 text-right ${positive ? "text-pos" : t.avg_uplift_pct < 0 ? "text-neg" : "text-muted-foreground"}`}>
        {sign}{t.avg_uplift_pct}%
      </span>
    </li>
  );
}

function WinRow({ w }: { w: LearnTest }) {
  return (
    <Link href={`/tests/${w.test_id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors">
      <span className="text-sm font-medium flex-1 truncate">{w.video_title || w.video_id}</span>
      <span className="text-[11px] text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0 capitalize">{w.test_type}</span>
      <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">+{fmtNum(w.extra_views)} views</span>
      <span className="text-sm font-semibold text-pos tabular-nums shrink-0 w-20 text-right">+{w.lift_pct}%</span>
    </Link>
  );
}

function AbRow({ a }: { a: AbTitleTag }) {
  const up = a.avg_uplift_pct;
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span className="text-sm flex-1 truncate capitalize">{a.name}</span>
      <span className="text-[11px] text-muted-foreground shrink-0">won {Math.round(a.win_rate * 100)}% of {a.tests}</span>
      <span className={`text-sm font-semibold tabular-nums shrink-0 w-14 text-right ${up > 0 ? "text-pos" : up < 0 ? "text-neg" : "text-muted-foreground"}`}>
        {up >= 0 ? "+" : ""}{up}%
      </span>
    </li>
  );
}

function CorpusRow({ t }: { t: CorpusTag }) {
  const pct = Math.round((t.lift_vs_median - 1) * 100);
  const up = pct >= 0;
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="text-sm flex-1 truncate capitalize">{t.name}</span>
      <span className="text-xs text-muted-foreground shrink-0">{t.videos} vids</span>
      <span className={`text-sm font-semibold tabular-nums shrink-0 w-14 text-right ${up ? "text-pos" : "text-neg"}`}>
        {up ? "+" : ""}{pct}%
      </span>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground py-6 text-center">{children}</p>;
}
