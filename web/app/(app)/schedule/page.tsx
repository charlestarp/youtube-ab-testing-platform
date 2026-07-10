"use client";

import useSWR from "swr";
import Link from "next/link";
import { schedules as schedulesApi } from "@/lib/api";

export default function SchedulePage() {
  const { data: scheduleList, mutate } = useSWR("schedules", schedulesApi.list);

  const handleRun = async (id: number) => {
    await schedulesApi.run(id);
    mutate();
  };

  const handleDelete = async (id: number) => {
    await schedulesApi.delete(id);
    mutate();
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Bulk Schedules</h1>
        <Link
          href="/schedule/new"
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          New Schedule
        </Link>
      </div>

      {scheduleList?.map((s) => {
        const videoIds = JSON.parse(s.video_ids_json || "[]");
        return (
          <div key={s.id} className="bg-card border border-border rounded-xl px-4 py-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{s.name}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
                  <span>{videoIds.length} videos</span>
                  <span>Cron: {s.cron}</span>
                  <span>{s.duration_hours}h per variant</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${s.is_active ? "bg-green-500/20 text-pos border-green-500/30" : "border-border text-muted-foreground"}`}>
                    {s.is_active ? "Active" : "Paused"}
                  </span>
                </div>
                {s.last_run_at && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Last run: {new Date(s.last_run_at).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => handleRun(s.id)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90">
                  Run Now
                </button>
                <button onClick={() => handleDelete(s.id)} className="px-3 py-1.5 text-xs text-neg border border-red-500/30 rounded-md hover:bg-red-500/10">
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {(!scheduleList || scheduleList.length === 0) && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          No schedules yet. Create one to automate your testing.
        </div>
      )}
    </div>
  );
}
