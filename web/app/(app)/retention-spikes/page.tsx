"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { retentionSpikes, type RetentionSpikeVideo, type RetentionAnalysis } from "@/lib/api";
import { Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Scatter, ComposedChart } from "recharts";

type WeekOption = "this" | "last" | "two" | "three" | "custom";

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function weekRangeDays(option: WeekOption): number {
  // How many days back to include. We then filter further in JS if needed.
  switch (option) {
    case "this": return 7;
    case "last": return 14;
    case "two": return 21;
    case "three": return 28;
    case "custom": return 60;
  }
}

function inRange(publishedAt: string, option: WeekOption, customStart?: string, customEnd?: string): boolean {
  if (!publishedAt) return false;
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  if (option === "custom") {
    if (!customStart || !customEnd) return true;
    const start = new Date(customStart).getTime();
    const end = new Date(customEnd).getTime() + day; // inclusive end
    return t >= start && t < end;
  }

  // Rolling week windows
  const windowDays = 7;
  let offsetDays = 0;
  if (option === "this") offsetDays = 0;
  if (option === "last") offsetDays = 7;
  if (option === "two") offsetDays = 14;
  if (option === "three") offsetDays = 21;

  const end = now - offsetDays * day;
  const start = end - windowDays * day;
  return t >= start && t < end;
}

export default function RetentionSpikesPage() {
  const [week, setWeek] = useState<WeekOption>("this");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scrapingIds, setScrapingIds] = useState<Set<string>>(new Set());
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [podcastsOnly, setPodcastsOnly] = useState(false);

  const daysParam = weekRangeDays(week);
  const { data: videos, isLoading, mutate } = useSWR(
    `retention-videos-${daysParam}`,
    () => retentionSpikes.videos(daysParam),
    { revalidateOnFocus: false }
  );

  const filtered = useMemo(() => {
    const list = videos || [];
    return list.filter(v => {
      if (!inRange(v.published_at, week, customStart, customEnd)) return false;
      if (podcastsOnly && v.duration_seconds < 1200) return false; // 20 min minimum for podcasts
      return true;
    });
  }, [videos, week, customStart, customEnd, podcastsOnly]);

  const handleScrape = async (videoId: string) => {
    setScrapingIds(prev => {
      const next = new Set(prev);
      next.add(videoId);
      return next;
    });
    try {
      await retentionSpikes.scrape(videoId);
      await mutate();
    } catch (err) {
      console.error("scrape failed", err);
    } finally {
      setScrapingIds(prev => {
        const next = new Set(prev);
        next.delete(videoId);
        return next;
      });
    }
  };

  const handleRefreshAll = async () => {
    if (!filtered.length) return;
    setRefreshingAll(true);
    try {
      for (const v of filtered) {
        setScrapingIds(prev => {
          const next = new Set(prev);
          next.add(v.video_id);
          return next;
        });
        try {
          await retentionSpikes.scrape(v.video_id);
        } catch (err) {
          console.error(`scrape failed for ${v.video_id}`, err);
        }
        setScrapingIds(prev => {
          const next = new Set(prev);
          next.delete(v.video_id);
          return next;
        });
      }
      await mutate();
    } finally {
      setRefreshingAll(false);
    }
  };

  const weekTabs: { id: WeekOption; label: string }[] = [
    { id: "this", label: "This Week" },
    { id: "last", label: "Last Week" },
    { id: "two", label: "2 Weeks Ago" },
    { id: "three", label: "3 Weeks Ago" },
    { id: "custom", label: "Custom" },
  ];

  const withData = filtered.filter(v => v.has_retention_data).length;
  const withoutData = filtered.length - withData;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Retention Spikes</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Find clippable moments. Values above 100 are above typical retention.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPodcastsOnly(v => !v)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              podcastsOnly
                ? 'bg-primary/20 text-primary border border-primary/40'
                : 'bg-transparent text-muted-foreground border border-border hover:text-foreground'
            }`}
            title="Only show videos 20 min or longer"
          >
            {podcastsOnly ? 'Podcasts Only' : 'All Videos'}
          </button>
          <button
            onClick={handleRefreshAll}
            disabled={refreshingAll || filtered.length === 0}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {refreshingAll ? `Scraping ${scrapingIds.size}/${filtered.length}...` : `Scrape All (${filtered.length})`}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {weekTabs.map(t => (
            <button
              key={t.id}
              onClick={() => setWeek(t.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                week === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {week === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            />
          </div>
        )}

        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} videos | {withData} with data | {withoutData} pending
        </span>
      </div>

      {isLoading && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Loading videos...
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          No videos in this date range.
        </div>
      )}

      <div className="space-y-2">
        {filtered.map(v => (
          <VideoRow
            key={v.video_id}
            video={v}
            expanded={expandedId === v.video_id}
            onToggle={() => setExpandedId(expandedId === v.video_id ? null : v.video_id)}
            onScrape={() => handleScrape(v.video_id)}
            isScraping={scrapingIds.has(v.video_id)}
          />
        ))}
      </div>
    </div>
  );
}

function VideoRow({
  video,
  expanded,
  onToggle,
  onScrape,
  isScraping,
}: {
  video: RetentionSpikeVideo;
  expanded: boolean;
  onToggle: () => void;
  onScrape: () => void;
  isScraping: boolean;
}) {
  const { data: analysis, isLoading: analysisLoading } = useSWR(
    expanded && video.has_retention_data ? `retention-analysis-${video.video_id}` : null,
    () => retentionSpikes.analysis(video.video_id),
    { revalidateOnFocus: false }
  );

  // Also fetch top-3 spikes inline when a video has retention data (collapsed view)
  const { data: inlineAnalysis } = useSWR(
    video.has_retention_data ? `retention-analysis-inline-${video.video_id}` : null,
    () => retentionSpikes.analysis(video.video_id),
    { revalidateOnFocus: false }
  );

  const topThree = inlineAnalysis?.spikes?.slice(0, 3) || [];

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
        <button onClick={onToggle} className="shrink-0">
          {video.thumbnail_url ? (
            <img src={video.thumbnail_url} alt="" className="w-24 sm:w-28 aspect-video object-cover rounded-md" />
          ) : (
            <div className="w-24 sm:w-28 aspect-video bg-muted rounded-md" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <button onClick={onToggle} className="block text-left w-full">
            <p className="text-sm font-medium line-clamp-2 leading-snug">{video.title}</p>
          </button>
          <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-muted-foreground flex-wrap">
            <span>{formatDuration(video.duration_seconds)}</span>
            <span>{video.views?.toLocaleString() || 0} views</span>
            {video.ctr > 0 && <span>{video.ctr.toFixed(2)}% CTR</span>}
            {video.avg_view_pct > 0 && <span>{video.avg_view_pct.toFixed(1)}% avg watched</span>}
            <span>{video.published_at?.slice(0, 10)}</span>
          </div>

          {video.has_retention_data && topThree.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-[10px] text-muted-foreground">Top spikes:</span>
              {topThree.map((s, i) => (
                <a
                  key={i}
                  href={`https://youtu.be/${video.video_id}?t=${timecodeToSeconds(s.timecode)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono hover:bg-primary/20"
                  title={`${s.retention_value.toFixed(1)}% retention (${s.above_typical_pct > 0 ? "+" : ""}${s.above_typical_pct.toFixed(1)}% above baseline). Click to open in YouTube`}
                >
                  {s.timecode} +{s.above_typical_pct.toFixed(1)}%
                </a>
              ))}
            </div>
          )}
        </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {video.has_retention_data ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-pos font-medium">
              Available
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
              Not scraped
            </span>
          )}
          <button
            onClick={onScrape}
            disabled={isScraping}
            className="px-2.5 py-1 border border-border rounded-md text-[11px] hover:bg-accent disabled:opacity-50"
          >
            {isScraping ? "Scraping..." : video.has_retention_data ? "Re-scrape" : "Scrape"}
          </button>
          <button
            onClick={onToggle}
            className="px-2.5 py-1 border border-border rounded-md text-[11px] hover:bg-accent"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border p-4 space-y-3 bg-background/40">
          {!video.has_retention_data && (
            <div className="text-xs text-muted-foreground">
              No retention data yet. Click Scrape to pull it from YouTube Studio.
            </div>
          )}
          {video.has_retention_data && analysisLoading && (
            <div className="text-xs text-muted-foreground">Loading analysis...</div>
          )}
          {analysis && <AnalysisDetail analysis={analysis} />}
        </div>
      )}
    </div>
  );
}

function AnalysisDetail({ analysis }: { analysis: RetentionAnalysis }) {
  const chartData = useMemo(() => {
    const curve = analysis.retention_curve || [];
    const duration = analysis.duration_seconds || 0;
    return curve.map((value, i) => ({
      idx: i,
      value,
      timecode: duration > 0 ? timeAt((i / curve.length) * duration) : String(i),
    }));
  }, [analysis]);

  const spikePoints = useMemo(() => {
    return (analysis.spikes || []).map(s => ({ idx: s.position, value: s.retention_value }));
  }, [analysis.spikes]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <Stat label="Retention points" value={String(analysis.retention_points)} />
        <Stat label="Avg retention" value={analysis.avg_retention.toFixed(1)} />
        <Stat label="Duration" value={formatDuration(analysis.duration_seconds)} />
        <Stat label="Scraped" value={new Date(analysis.scraped_at).toLocaleString()} />
      </div>

      {chartData.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-3">
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="idx"
                tick={{ fill: "#888", fontSize: 10 }}
                tickFormatter={(i: number) => chartData[i]?.timecode ?? ""}
                interval={Math.max(0, Math.floor(chartData.length / 8))}
              />
              <YAxis tick={{ fill: "#888", fontSize: 10 }} domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1a1612", border: "1px solid #2d2519", fontSize: 12 }}
                formatter={(val) => [Number(val).toFixed(2), "Retention"]}
                labelFormatter={(i) => `@ ${chartData[Number(i)]?.timecode ?? i}`}
              />
              <ReferenceLine y={100} stroke="#888" strokeDasharray="4 4" label={{ value: "typical", fill: "#888", fontSize: 10, position: "right" }} />
              <Line type="monotone" dataKey="value" stroke="#7c63ff" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Scatter data={spikePoints} dataKey="value" fill="#ef4444" shape="circle" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-card border border-border rounded-lg p-3">
        <h3 className="text-sm font-semibold mb-2">Top spikes</h3>
        {analysis.spikes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No spikes above baseline found.</p>
        ) : (
          <div className="space-y-1">
            {analysis.spikes.map((s, i) => (
              <div key={i} className="flex items-center gap-x-3 gap-y-0.5 text-xs flex-wrap">
                <a
                  href={`https://youtu.be/${analysis.video_id}?t=${timecodeToSeconds(s.timecode)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary w-16 hover:underline shrink-0"
                  title="Open in YouTube"
                >
                  {s.timecode}
                </a>
                <span className="text-foreground/80 shrink-0">{s.retention_value.toFixed(1)}%</span>
                <span className="text-pos">
                  {s.above_typical_pct > 0 ? "+" : ""}{s.above_typical_pct.toFixed(2)}% above baseline
                </span>
                <span className="text-muted-foreground text-[10px] ml-auto">
                  pos {s.position}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {analysis.absolute_max && (
        <div className="bg-card border border-border rounded-lg p-3">
          <h3 className="text-sm font-semibold mb-1">Highest point</h3>
          <div className="flex items-center gap-3 text-xs">
            <a
              href={`https://youtu.be/${analysis.video_id}?t=${timecodeToSeconds(analysis.absolute_max.timecode)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-primary w-16 hover:underline"
              title="Open in YouTube"
            >
              {analysis.absolute_max.timecode}
            </a>
            <span>{analysis.absolute_max.retention_value.toFixed(1)}% retention</span>
          </div>
        </div>
      )}
    </div>
  );
}

function timecodeToSeconds(tc: string): number {
  const parts = tc.split(":").map(p => parseInt(p, 10));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-2">
      <p className="text-sm font-semibold">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function timeAt(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
