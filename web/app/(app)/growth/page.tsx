"use client";

import useSWR from "swr";
import { growth } from "@/lib/api";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

export default function GrowthPage() {
  const { data } = useSWR("growth", () => growth.get(), { refreshInterval: 120000 });

  const biggest = data?.formats
    ?.filter((f) => f.ratio && f.ratio > 1)
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0))[0];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Growth</h1>
        <p className="text-sm text-muted-foreground mt-1">Where we trail the best in our space, by format — and the proven moves to close it. Growth = more views and subs, so the biggest gap is where to spend effort.</p>
      </div>

      {biggest && (
        <div className="rounded-2xl bg-primary/10 border border-primary/20 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-1">Biggest opportunity</p>
          <p className="text-lg font-bold leading-snug">Our {biggest.format.toLowerCase()} average {fmt(biggest.ours)} views vs the benchmark {fmt(biggest.benchmark)} — {biggest.ratio}× behind.</p>
          <p className="text-sm text-muted-foreground mt-1">Closing this is the single highest-leverage thing we can do. The winning moves for it are below.</p>
        </div>
      )}

      {/* Format gaps */}
      <div className="grid sm:grid-cols-2 gap-4">
        {data?.formats.map((f) => (
          <div key={f.format} className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-semibold mb-3">{f.format}</h2>
            <div className="flex items-end gap-4">
              <div>
                <p className="text-2xl font-bold">{fmt(f.ours)}</p>
                <p className="text-[11px] text-muted-foreground">our average</p>
              </div>
              <div className="text-muted-foreground pb-1">vs</div>
              <div>
                <p className="text-2xl font-bold text-muted-foreground">{fmt(f.benchmark)}</p>
                <p className="text-[11px] text-muted-foreground">benchmark</p>
              </div>
              {f.ratio && f.ratio > 1 && (
                <div className="ml-auto text-right">
                  <p className="text-lg font-bold text-neg">{f.ratio}×</p>
                  <p className="text-[10px] text-muted-foreground">behind</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* The proven levers */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Proven levers to pull</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <LeverCard title="Podcast titles" items={data?.levers.titlePodcast} />
          <LeverCard title="Podcast thumbnails" items={data?.levers.thumbPodcast} />
          <LeverCard title="TNTL titles" items={data?.levers.titleTNTL} />
          <LeverCard title="TNTL thumbnails" items={data?.levers.thumbTNTL} />
        </div>
      </div>
    </div>
  );
}

function LeverCard({ title, items }: { title: string; items?: { name: string; uplift: number }[] }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      {items && items.length > 0 ? (
        <ul className="space-y-1">
          {items.map((i) => (
            <li key={i.name} className="flex items-center justify-between text-sm">
              <span className="capitalize truncate">{i.name}</span>
              <span className={`font-semibold tabular-nums ${i.uplift > 0 ? "text-pos" : "text-muted-foreground"}`}>{i.uplift >= 0 ? "+" : ""}{i.uplift}%</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground italic">Not enough tests yet.</p>
      )}
    </div>
  );
}
