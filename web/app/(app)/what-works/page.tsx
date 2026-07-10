"use client";

import { useState } from "react";
import useSWR from "swr";
import { whatWorks, preflight, type WwSection, type WwTag } from "@/lib/api";

const WINDOWS: { key: "7" | "30" | "all"; label: string }[] = [
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "all", label: "All time" },
];

export default function WhatWorksPage() {
  const [since, setSince] = useState<"7" | "30" | "all">("30");
  const { data, isLoading } = useSWR(["what-works", since], () => whatWorks.get(since), { refreshInterval: 60000 });
  const { data: calibration } = useSWR("preflight-calibration", () => preflight.calibration(), { refreshInterval: 3_600_000 });

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">What works</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            What actually wins and loses head-to-head, from real A/B tests — titles and thumbnails, kept separate for Podcast and Try Not To Laugh. It recomputes live, so it keeps learning as tests finish and new videos go out.
          </p>
        </div>
        <div className="flex gap-1 bg-muted rounded-lg p-0.5 shrink-0">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setSince(w.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${since === w.key ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {calibration && calibration.resolved > 0 && (
        <p className="text-xs text-muted-foreground border border-border rounded-lg px-3 py-2">{calibration.health_note}</p>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Reading the tests…</p>}

      {data && (() => {
        const all = [data.titles.podcast, data.titles.TNTL, data.thumbnails.podcast, data.thumbnails.TNTL];
        const win = all.flatMap((s) => s.winners).sort((a, b) => b.avg_uplift_pct - a.avg_uplift_pct)[0];
        const lose = all.flatMap((s) => s.losers).sort((a, b) => a.avg_uplift_pct - b.avg_uplift_pct)[0];
        if (!win && !lose) return null;
        return (
          <div className="rounded-xl bg-muted/50 border border-border p-3 text-sm leading-relaxed">
            <span className="font-semibold">So what: </span>
            {win && <>lean into <span className="font-semibold text-pos capitalize">{win.name}</span> ({win.avg_uplift_pct >= 0 ? "+" : ""}{win.avg_uplift_pct}% CTR) — it's the strongest thing we've proven. </>}
            {lose && <>Steer clear of <span className="font-semibold text-neg capitalize">{lose.name}</span> ({lose.avg_uplift_pct}% CTR), it keeps losing.</>}
          </div>
        );
      })()}

      {data && (
        <>
          <div className="grid md:grid-cols-2 gap-4">
            <Card title="Titles" subtitle="Podcast" section={data.titles.podcast} />
            <Card title="Titles" subtitle="Try Not To Laugh" section={data.titles.TNTL} />
            <Card title="Thumbnails" subtitle="Podcast" section={data.thumbnails.podcast} />
            <Card title="Thumbnails" subtitle="Try Not To Laugh" section={data.thumbnails.TNTL} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            "Won %" is how often a variant with that attribute beat its own test. Uplift is impression-weighted CTR vs each test's average. {data.since ? `Showing tests completed in the last ${data.since} days.` : "Showing all tests."}
          </p>
        </>
      )}
    </div>
  );
}

function Card({ title, subtitle, section }: { title: string; subtitle: string; section: WwSection }) {
  const empty = section.winners.length === 0 && section.losers.length === 0;
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-semibold">{title} <span className="text-muted-foreground font-normal">· {subtitle}</span></h2>
        <span className="text-[11px] text-muted-foreground">{section.total} attributes tested</span>
      </div>
      {empty ? (
        <p className="text-xs text-muted-foreground italic py-3">Not enough tests in this window yet. Widen the time range or run more {title.toLowerCase()} tests.</p>
      ) : (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1.5">Works</p>
          <ul className="divide-y divide-border/60">
            {section.winners.map((t) => <Row key={t.name} t={t} />)}
            {section.winners.length === 0 && <li className="py-1.5 text-xs text-muted-foreground italic">Nothing clearly winning yet.</li>}
          </ul>
          {section.losers.length > 0 && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-3 mb-1.5">Doesn&apos;t</p>
              <ul className="divide-y divide-border/60">
                {section.losers.map((t) => <Row key={t.name} t={t} />)}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Row({ t }: { t: WwTag }) {
  const up = t.avg_uplift_pct;
  return (
    <li className="flex items-center gap-3 py-1.5">
      <span className="text-sm flex-1 truncate capitalize">{t.name}{t.category ? <span className="text-[10px] text-muted-foreground ml-1">[{t.category}]</span> : null}</span>
      <span className="text-[11px] text-muted-foreground shrink-0">won {Math.round(t.win_rate * 100)}% of {t.tests}</span>
      <span className={`text-sm font-semibold tabular-nums shrink-0 w-14 text-right ${up > 0 ? "text-pos" : up < 0 ? "text-neg" : "text-muted-foreground"}`}>
        {up >= 0 ? "+" : ""}{up}%
      </span>
    </li>
  );
}
