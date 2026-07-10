"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { tests as testsApi } from "@/lib/api";
import type { TestSummary } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

const filters = ["all", "running", "pending", "completed", "paused", "failed"];

export function TestList({ category }: { category: "test" | "retest" }) {
  const [filter, setFilter] = useState("all");
  const { data: allTests, mutate } = useSWR(`tests-${category}`, () => testsApi.list(undefined, category), { refreshInterval: 10000 });

  const filtered = filter === "all" ? allTests : allTests?.filter((t) => t.status === filter);
  const isRetests = category === "retest";

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{isRetests ? "Retests" : "Tests"}</h1>
        <Link
          href="/tests/new"
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          New Test
        </Link>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-border pb-2">
        <Link
          href="/tests"
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            !isRetests ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
          }`}
        >
          Tests
        </Link>
        <Link
          href="/retests"
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            isRetests ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
          }`}
        >
          Retests
        </Link>
      </div>

      <div className="flex flex-wrap gap-1">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
              filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filtered?.map((test) => {
          const activeVariant = test.variants?.find((v: any) => v.active_since);
          const winnerVariant = (test as any).winner_variant_id ? test.variants?.find((v: any) => v.id === (test as any).winner_variant_id) : null;
          const firstVariant = test.variants?.[0];
          const thumbPath = activeVariant?.thumbnail_path || winnerVariant?.thumbnail_path || firstVariant?.thumbnail_path;
          const thumbUrl = thumbPath
            ? `/api/thumb/${thumbPath.split('/').pop()}`
            : (test as any).video_thumbnail_url;
          const isScheduled = test.started_at && new Date(test.started_at) > new Date();

          return (
          <div key={test.id} className="bg-card border border-border rounded-xl px-4 py-3 hover:border-primary/40 transition-colors flex items-center gap-3">
            <Link href={`${isRetests ? "/retests" : "/tests"}/${test.id}`} className="flex items-center gap-3 flex-1 min-w-0">
              {thumbUrl && <img src={thumbUrl} alt="" className="w-24 h-14 object-cover rounded shrink-0" />}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <StatusBadge status={isScheduled ? "scheduled" : test.status} className="shrink-0" />
                {test.error_msg?.startsWith("upload_fail") && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full border font-medium shrink-0 bg-brand-red/15 text-[#c23214] dark:text-[#f7876a] border-brand-red/30" title={test.error_msg}>Upload failed</span>
                )}
                <span className="text-sm font-medium truncate">{test.video_title || test.video_id}</span>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 border ${test.test_type === "title" ? "bg-blue-500/15 text-info border-blue-500/30" : test.test_type === "both" ? "bg-primary/15 text-primary border-primary/30" : "bg-purple-500/15 text-purple-500 border-purple-500/30"}`}>{test.test_type === "title" ? "Title" : test.test_type === "both" ? "Title+Thumb" : "Thumbnail"}</span>
                <span className="hidden sm:inline-block text-[11px] text-muted-foreground shrink-0">{test.variants?.length || 0} variants</span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {new Date(test.created_at).toLocaleDateString()}
              </span>
            </Link>
            <div className="relative shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const menu = e.currentTarget.nextElementSibling as HTMLElement;
                  menu.classList.toggle("hidden");
                }}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
              </button>
              <div className="hidden absolute right-0 top-8 bg-popover border border-border rounded-lg shadow-lg py-1 z-10 min-w-[140px]">
                <Link href={`${isRetests ? "/retests" : "/tests"}/${test.id}`} className="block px-3 py-1.5 text-xs hover:bg-accent">View Results</Link>
                <Link href={`/tests/new?redo=${test.id}`} className="block px-3 py-1.5 text-xs hover:bg-accent">Redo Test</Link>
                <button
                  onClick={async () => {
                    await testsApi.setCategory(test.id, isRetests ? "test" : "retest");
                    mutate();
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent"
                >
                  {isRetests ? "Move to Tests" : "Move to Retests"}
                </button>
                <button
                  onClick={async () => {
                    if (!confirm("Delete this test?")) return;
                    await testsApi.delete(test.id);
                    mutate();
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-neg hover:bg-accent"
                >
                  Delete Test
                </button>
              </div>
            </div>
          </div>
          );
        })}
        {(!filtered || filtered.length === 0) && (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
            {filter === "all" ? `No ${isRetests ? "retests" : "tests"} yet` : `No ${filter} ${isRetests ? "retests" : "tests"}`}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TestsPage() {
  return <TestList category="test" />;
}
