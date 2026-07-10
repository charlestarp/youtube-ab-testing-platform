"use client";

import { use } from "react";
import useSWR from "swr";
import Link from "next/link";
import { research } from "@/lib/api";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

function fmtSubs(n: number | null): string {
  if (!n) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "k";
  return String(n);
}

export default function CompetitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data } = useSWR(["research-channel", id], () => research.channel(id));
  const c = data?.channel;

  if (!data) return <div className="max-w-4xl mx-auto px-6 py-8 text-sm text-gray-400">Loading…</div>;
  if (!c) return <div className="max-w-4xl mx-auto px-6 py-8 text-sm text-red-500">Channel not found.</div>;

  const chart = (data.monthly ?? []).map((m: any) => ({ month: m.month, subs: m.subs, views: m.views }));

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <Link href="/competitors" className="text-sm text-gray-500 hover:underline">← All channels</Link>

      {/* Header */}
      <div className="flex items-center gap-4">
        {c.avatar && <img src={c.avatar} alt="" className="w-16 h-16 rounded-full" />}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{c.name}</h1>
            {c.is_core ? <span className="text-[10px] bg-black text-white px-1.5 py-0.5 rounded">CORE</span> : null}
            {c.grade ? <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">Grade {c.grade}</span> : null}
          </div>
          <p className="text-sm text-gray-500">
            {fmtSubs(c.subs)} subscribers · {fmtSubs(c.views)} views · {c.videos ?? "—"} videos
            {c.country ? ` · ${c.country}` : ""} {c.channel_type ? `· ${c.channel_type}` : ""}
          </p>
          {c.created ? <p className="text-xs text-gray-400">On YouTube since {c.created}</p> : null}
        </div>
        <a href={c.youtube_url} target="_blank" rel="noreferrer" className="text-sm text-blue-500 hover:underline">
          Open on YouTube ↗
        </a>
      </div>

      {c.growth_365_pct != null && (
        <div className="flex gap-6 text-sm">
          <div><span className="text-gray-400">Growth / yr</span><div className="text-lg font-semibold text-green-600">+{c.growth_365_pct}%</div></div>
          {c.subs_start_365 ? <div><span className="text-gray-400">A year ago</span><div className="text-lg font-semibold">{fmtSubs(c.subs_start_365)}</div></div> : null}
        </div>
      )}

      {/* Growth chart */}
      {chart.length > 1 && (
        <div>
          <h2 className="text-sm font-semibold mb-2">Subscriber growth (3-year history)</h2>
          <div className="h-64 border rounded-lg p-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} minTickGap={30} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => fmtSubs(v)} width={40} />
                <Tooltip formatter={(v: any) => fmtSubs(v)} />
                <Line type="monotone" dataKey="subs" stroke="#000" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Biggest sub-jump months */}
      {data.top_jumps?.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-2">Biggest subscriber-jump months</h2>
          <div className="flex flex-wrap gap-2">
            {data.top_jumps.map((j: any) => (
              <div key={j.month} className="border rounded-lg px-3 py-2 text-sm">
                <div className="font-medium">{j.month}</div>
                <div className="text-green-600 text-xs">+{fmtSubs(j.subs_gained)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {c.description && (
        <div>
          <h2 className="text-sm font-semibold mb-1">About</h2>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">{c.description}</p>
        </div>
      )}
    </div>
  );
}
