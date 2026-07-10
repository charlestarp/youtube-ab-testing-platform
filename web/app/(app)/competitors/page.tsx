"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { research } from "@/lib/api";

function fmtSubs(n: number | null): string {
  if (!n) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "k";
  return String(n);
}
function growthColor(p: number | null): string {
  if (p == null) return "text-gray-400";
  if (p >= 50) return "text-green-600 font-semibold";
  if (p >= 15) return "text-green-500";
  if (p <= 2) return "text-red-500";
  return "text-gray-600";
}

type Tab = "core" | "all" | "fastest";

export default function CompetitorsPage() {
  const [tab, setTab] = useState<Tab>("core");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("subs");

  const { data: stats } = useSWR("research-stats", research.stats);
  const { data: core, mutate: mutateCore } = useSWR("research-core", research.core);
  const listKey = tab === "all" ? ["research-all", q, sort] : null;
  const { data: all, mutate: mutateAll } = useSWR(listKey, () =>
    research.channels({ q, sort, limit: 300 })
  );

  const togglePin = async (id: string, current: number) => {
    await research.setCore(id, !current);
    mutateCore();
    mutateAll();
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Competitor Intelligence</h1>
        <p className="text-sm text-gray-500 mt-1">
          {stats?.summary?.channels ?? "…"} podcast channels researched ·{" "}
          {stats?.summary?.with_history ?? "…"} with 3-year growth history ·{" "}
          {stats?.summary?.core ?? "…"} in your core set
        </p>
      </div>

      <div className="flex gap-1 border-b">
        {(
          [
            ["core", "Your Core"],
            ["all", "All Channels"],
            ["fastest", "Fastest Growing"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t
                ? "border-black text-black"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "core" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(core ?? []).map((c: any) => (
            <div
              key={c.channel_id}
              className="flex items-center gap-3 border rounded-lg p-3 hover:shadow-sm"
            >
              {c.avatar && <img src={c.avatar} alt="" className="w-11 h-11 rounded-full" />}
              <div className="flex-1 min-w-0">
                <Link
                  href={`/competitors/${c.channel_id}`}
                  className="font-semibold hover:underline block truncate"
                >
                  {c.name}
                </Link>
                <div className="text-xs text-gray-500">
                  {fmtSubs(c.subs)} subs ·{" "}
                  <span className={growthColor(c.growth_365_pct)}>
                    {c.growth_365_pct != null
                      ? `${c.growth_365_pct > 0 ? "+" : ""}${c.growth_365_pct}% / yr`
                      : "—"}
                  </span>
                </div>
              </div>
              <a
                href={c.youtube_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-500 hover:underline"
              >
                YouTube ↗
              </a>
            </div>
          ))}
          {core?.length === 0 && (
            <p className="text-sm text-gray-400">No core channels pinned yet.</p>
          )}
        </div>
      )}

      {tab === "all" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search 1,020 channels…"
              className="flex-1 border rounded-lg px-3 py-2 text-sm"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              <option value="subs">Sort: Subscribers</option>
              <option value="growth">Sort: Growth %</option>
              <option value="views">Sort: Total views</option>
              <option value="videos">Sort: Video count</option>
            </select>
          </div>
          <ChannelTable rows={all?.channels ?? []} total={all?.total} onPin={togglePin} />
        </div>
      )}

      {tab === "fastest" && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Fastest-growing channels over the last year (real base ≥ 20k subs).
          </p>
          <ol className="space-y-1">
            {(stats?.fastest ?? []).map((c: any, i: number) => (
              <li
                key={i}
                className="flex items-center gap-3 border rounded-lg px-3 py-2 text-sm"
              >
                <span className="w-6 text-gray-400">{i + 1}</span>
                <a
                  href={c.youtube_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 font-medium hover:underline"
                >
                  {c.name}
                </a>
                <span className="text-gray-500">{fmtSubs(c.subs)}</span>
                <span className={`w-24 text-right ${growthColor(c.growth_365_pct)}`}>
                  +{c.growth_365_pct}%
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function ChannelTable({
  rows,
  total,
  onPin,
}: {
  rows: any[];
  total?: number;
  onPin: (id: string, cur: number) => void;
}) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-3 py-2 text-xs text-gray-500 bg-gray-50 border-b">
        {total ?? rows.length} channels
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 border-b">
          <tr>
            <th className="text-left px-3 py-2">Channel</th>
            <th className="text-right px-3 py-2">Subs</th>
            <th className="text-right px-3 py-2">Growth/yr</th>
            <th className="text-right px-3 py-2">Videos</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.channel_id} className="border-b hover:bg-gray-50">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  {c.avatar && <img src={c.avatar} alt="" className="w-7 h-7 rounded-full" />}
                  <Link
                    href={`/competitors/${c.channel_id}`}
                    className="font-medium hover:underline truncate"
                  >
                    {c.name}
                  </Link>
                  {c.is_core ? (
                    <span className="text-[10px] bg-black text-white px-1.5 py-0.5 rounded">
                      CORE
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="text-right px-3 py-2 text-gray-600">{fmtSubs(c.subs)}</td>
              <td className={`text-right px-3 py-2 ${growthColor(c.growth_365_pct)}`}>
                {c.growth_365_pct != null
                  ? `${c.growth_365_pct > 0 ? "+" : ""}${c.growth_365_pct}%`
                  : "—"}
              </td>
              <td className="text-right px-3 py-2 text-gray-500">{c.videos ?? "—"}</td>
              <td className="text-right px-3 py-2 whitespace-nowrap">
                <a
                  href={c.youtube_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-500 hover:underline mr-2"
                >
                  YT ↗
                </a>
                <button
                  onClick={() => onPin(c.channel_id, c.is_core)}
                  className="text-xs text-gray-400 hover:text-black"
                >
                  {c.is_core ? "Unpin" : "Pin"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
