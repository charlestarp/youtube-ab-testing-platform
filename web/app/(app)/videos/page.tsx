"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { videos as videosApi } from "@/lib/api";

export default function VideosPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");

  const { data: videoList } = useSWR(
    `videos-${search}-${category}`,
    () => videosApi.list(search || undefined, category || undefined, 200),
    { keepPreviousData: true }
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      <h1 className="text-2xl font-bold">Videos</h1>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            placeholder="Search videos..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 rounded-md border border-input bg-transparent pl-8 pr-3 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow]"
          />
        </div>
        <div className="flex gap-1">
          {[
            { value: "", label: "All" },
            { value: "podcast", label: "Podcast" },
            { value: "reaction", label: "Reactions" },
          ].map((c) => (
            <button
              key={c.value}
              onClick={() => setCategory(c.value)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                category === c.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground ml-auto">
          {videoList?.length ?? 0} videos
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
        {videoList?.map((v) => (
          <div key={v.video_id} className="group bg-card border border-border rounded-lg overflow-hidden hover:border-primary/40 transition-colors">
            <div className="relative">
              {v.thumbnail_url && (
                <img src={v.thumbnail_url} alt="" className="w-full aspect-video object-cover" />
              )}
              {(v as any).is_scheduled && (
                <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/90 text-black font-medium">
                  Scheduled
                </span>
              )}
            </div>
            <div className="p-2.5">
              <p className="text-xs font-medium line-clamp-2 leading-snug mb-1.5">{v.title}</p>
              <div className="flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
                {(v as any).is_scheduled ? (
                  <span>{(v as any).scheduled_at ? new Date((v as any).scheduled_at).toLocaleString() : "Scheduled"}</span>
                ) : (
                  <span>{v.view_count?.toLocaleString()} views</span>
                )}
                <span>{v.publish_date}</span>
              </div>
              {v.recent_tests?.length > 0 && (
                <div className="flex gap-1 mt-1.5">
                  {v.recent_tests.slice(0, 2).map((t) => (
                    <span key={t.id} className="text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                      {t.status}
                    </span>
                  ))}
                </div>
              )}
              <Link
                href={`/tests/new?video=${v.video_id}`}
                className="block mt-2 text-[11px] text-primary hover:underline opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
              >
                Start Test
              </Link>
            </div>
          </div>
        ))}
      </div>

      {videoList?.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          No videos found
        </div>
      )}
    </div>
  );
}
