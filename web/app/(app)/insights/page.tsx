"use client";

import { useState } from "react";
import useSWR from "swr";
import { analytics, thumbnails } from "@/lib/api";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

const statusColors: Record<string, string> = {
  fatigued: "text-neg bg-red-500/15",
  declining: "text-warn bg-yellow-500/15",
  growing: "text-pos bg-green-500/15",
  stable: "text-muted-foreground bg-muted",
};

const opportunityColors: Record<string, string> = {
  high: "text-pos bg-green-500/15 border-green-500/30",
  medium: "text-warn bg-yellow-500/15 border-yellow-500/30",
  low: "text-muted-foreground bg-muted border-border",
};

export default function InsightsPage() {
  const [tab, setTab] = useState<"benchmarks" | "fatigue" | "seo" | "growth" | "viral" | "thumbnails">("benchmarks");
  const [titleInput, setTitleInput] = useState("");
  const [benchContent, setBenchContent] = useState<"podcast" | "TNTL">("podcast");
  const [fatigueContent, setFatigueContent] = useState<"podcast" | "TNTL">("podcast");

  const { data: benchmarks } = useSWR("benchmarks", analytics.benchmarks);
  const { data: fatigueData } = useSWR(tab === "fatigue" ? "fatigue" : null, analytics.fatigue);
  const { data: seoGaps } = useSWR(tab === "seo" ? "seo-gaps" : null, analytics.seoGaps);
  const { data: growth } = useSWR(tab === "growth" ? "growth" : null, analytics.growth);
  const [thumbFilter, setThumbFilter] = useState<"podcast" | "reaction" | "competitors">("podcast");
  const { data: thumbInsights, mutate: mutateThumb } = useSWR(
    tab === "thumbnails" && thumbFilter !== "competitors" ? `thumb-insights-${thumbFilter}` : null,
    () => thumbnails.insights(thumbFilter)
  );
  const { data: compInsights, mutate: mutateComp } = useSWR(
    tab === "thumbnails" && thumbFilter === "competitors" ? "thumb-comp-insights" : null,
    () => thumbnails.competitorInsights()
  );
  const { data: thumbStats } = useSWR(tab === "thumbnails" ? "thumb-stats" : null, thumbnails.stats);
  const [analyzing, setAnalyzing] = useState(false);
  const [viralResult, setViralResult] = useState<any>(null);
  const [scoring, setScoring] = useState(false);

  const handleScore = async () => {
    if (!titleInput.trim()) return;
    setScoring(true);
    try {
      const result = await analytics.viralScore(titleInput.trim());
      setViralResult(result);
    } catch {}
    setScoring(false);
  };

  const handleAnalyze = async (type: "ours" | "competitors") => {
    setAnalyzing(true);
    try {
      if (type === "competitors") {
        await thumbnails.analyzeCompetitors(50);
        mutateComp();
      } else {
        await thumbnails.analyze(50);
        mutateThumb();
      }
    } catch {}
    setAnalyzing(false);
  };

  const tabs = [
    { id: "benchmarks", label: "Benchmarks" },
    { id: "fatigue", label: "Fatigue Tracker" },
    { id: "seo", label: "SEO Gaps" },
    { id: "growth", label: "Growth" },
    { id: "viral", label: "Viral Score" },
    { id: "thumbnails", label: "Thumbnails" },
  ] as const;

  const contentToggle = (value: "podcast" | "TNTL", setValue: (v: "podcast" | "TNTL") => void) => (
    <div className="flex gap-1">
      {(["podcast", "TNTL"] as const).map((c) => (
        <button
          key={c}
          onClick={() => setValue(c)}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            value === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
          }`}
        >
          {c === "podcast" ? "Podcast" : "Try Not To Laugh"}
        </button>
      ))}
    </div>
  );

  const fatigueCard = (p: any, i: number) => (
    <div key={i} className="bg-card border border-border rounded-xl px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${statusColors[p.status] || ""}`}>
          {p.status}
        </span>
        <span className="text-sm font-medium truncate">
          {p.attribute ? <span className="text-muted-foreground font-normal">{p.attribute}: </span> : null}"{p.pattern}"
        </span>
        <span className={`text-xs ml-auto shrink-0 ${p.changePercent > 0 ? "text-pos" : p.changePercent < -10 ? "text-neg" : "text-muted-foreground"}`}>
          {p.changePercent > 0 ? "+" : ""}{p.changePercent}%
        </span>
      </div>
      <div className="flex gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground flex-wrap">
        <span>Now: {p.recentAvgViews?.toLocaleString()} avg views</span>
        <span>Before: {p.historicalAvgViews?.toLocaleString()} avg views</span>
        {p.recentAvgCtr > 0 && p.historicalAvgCtr > 0 && (
          <span>CTR {p.historicalAvgCtr}% to {p.recentAvgCtr}%</span>
        )}
        <span>{p.recentCount}/{p.recentTotal} recent</span>
      </div>
      <p className="text-xs mt-1.5 text-foreground/80">{p.reason}</p>
      <p className="text-[11px] mt-1 text-muted-foreground">{p.recommendation}</p>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-5">
      <h1 className="text-2xl font-bold">Insights</h1>

      <div className="flex gap-1 overflow-x-auto -mx-6 px-6 pb-1 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors shrink-0 ${
              tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Benchmarks */}
      {tab === "benchmarks" && benchmarks && (() => {
        const b = benchmarks[benchContent];
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              {contentToggle(benchContent, setBenchContent)}
              <span className="text-[11px] text-muted-foreground">{b?.videoCount ?? 0} {b?.label} videos, scored on their own</span>
            </div>
            {!b?.enoughData ? (
              <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
                Not enough {b?.label} videos yet for a benchmark.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-card border border-border rounded-xl p-3">
                    <p className="text-xl font-bold">{b.avgViews?.toLocaleString()}</p>
                    <p className="text-[11px] text-muted-foreground">Avg Views</p>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-3">
                    <p className="text-xl font-bold">{b.medianViews?.toLocaleString()}</p>
                    <p className="text-[11px] text-muted-foreground">Median Views</p>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-3">
                    <p className="text-xl font-bold">{b.avgLikes?.toLocaleString()}</p>
                    <p className="text-[11px] text-muted-foreground">Avg Likes</p>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-3">
                    <p className={`text-xl font-bold ${b.recentTrend === 'improving' ? 'text-pos' : b.recentTrend === 'declining' ? 'text-neg' : 'text-muted-foreground'}`}>
                      {b.recentTrend}
                    </p>
                    <p className="text-[11px] text-muted-foreground">Recent Trend</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-card border border-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold mb-3">Top Performers</h3>
                    <div className="space-y-1.5">
                      {b.topPerformers?.slice(0, 8).map((v: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="truncate flex-1 mr-2">{v.title}</span>
                          <span className="text-pos shrink-0">+{v.viewsVsAvg}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="bg-card border border-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold mb-3">Underperformers</h3>
                    <div className="space-y-1.5">
                      {b.underperformers?.slice(0, 8).map((v: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="truncate flex-1 mr-2">{v.title}</span>
                          <span className="text-neg shrink-0">{v.viewsVsAvg}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Fatigue */}
      {tab === "fatigue" && (() => {
        const items = ((fatigueData as any[]) || []).filter((p) => p.contentType === fatigueContent);
        const titleItems = items.filter((p) => p.kind === "title");
        const thumbItems = items.filter((p) => p.kind === "thumbnail");
        const label = fatigueContent === "podcast" ? "Podcast" : "Try Not To Laugh";
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              {contentToggle(fatigueContent, setFatigueContent)}
              <span className="text-[11px] text-muted-foreground">Podcast and TNTL scored separately, titles and thumbnails split</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Title Fatigue</h3>
                {titleItems.length > 0 ? titleItems.map((p, i) => fatigueCard(p, i)) : (
                  <div className="bg-card border border-border rounded-xl p-6 text-center text-xs text-muted-foreground">
                    No title fatigue signals for {label} yet.
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Thumbnail Fatigue</h3>
                {thumbItems.length > 0 ? thumbItems.map((p, i) => fatigueCard(p, i)) : (
                  <div className="bg-card border border-border rounded-xl p-6 text-center text-xs text-muted-foreground">
                    No thumbnail fatigue signals for {label} yet. Analyse more thumbnails to power this.
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* SEO Gaps */}
      {tab === "seo" && (
        <div className="space-y-2">
          {seoGaps && seoGaps.length > 0 ? seoGaps.map((g: any, i: number) => (
            <div key={i} className="bg-card border border-border rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${opportunityColors[g.opportunity] || ""}`}>
                  {g.opportunity}
                </span>
                <span className="text-sm font-medium">"{g.keyword}"</span>
                <span className="text-xs text-muted-foreground ml-auto">~{g.estimatedViews?.toLocaleString()} views</span>
              </div>
              <div className="space-y-0.5">
                {g.competitorVideos?.map((v: any, j: number) => (
                  <p key={j} className="text-[11px] text-muted-foreground">
                    {v.channel}: "{v.title}" ({v.views?.toLocaleString()} views)
                  </p>
                ))}
              </div>
            </div>
          )) : (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
              Add competitor channels first to find SEO gaps.
            </div>
          )}
        </div>
      )}

      {/* Growth */}
      {tab === "growth" && growth && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-xl font-bold">{Math.round(growth.avgSubsPerWeek)}</p>
              <p className="text-[11px] text-muted-foreground">Subs/Week</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-xl font-bold">{Math.round(growth.avgViewsPerDay)?.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground">Views/Day</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-xl font-bold">{Math.round(growth.avgViewsPerVideo)?.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground">Views/Video</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-xl font-bold">{growth.postsPerWeek?.toFixed(1)}</p>
              <p className="text-[11px] text-muted-foreground">Videos/Week</p>
            </div>
          </div>

          {growth.milestones?.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Subscriber Milestones</h3>
              <div className="space-y-2">
                {growth.milestones.map((m: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="font-medium">{m.target?.toLocaleString()} subscribers</span>
                    <span className="text-muted-foreground">{m.estimatedDate} (~{m.daysAway} days)</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {growth.weeklyTrend?.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3">Weekly Views</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={growth.weeklyTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="week" tick={{ fill: "#888", fontSize: 10 }} tickFormatter={(w: string) => w.slice(5)} />
                  <YAxis tick={{ fill: "#888", fontSize: 10 }} />
                  <Tooltip contentStyle={{ backgroundColor: "#1a1612", border: "1px solid #2d2519", fontSize: 12 }} />
                  <Bar dataKey="views" fill="#7c63ff" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="bg-card border border-border rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-2">Growth Insights</h3>
            <div className="space-y-1">
              {growth.insights?.map((i: string, idx: number) => (
                <p key={idx} className="text-xs text-muted-foreground">{i}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Thumbnails */}
      {tab === "thumbnails" && (
        <div className="space-y-4">
          {/* Sub-filters */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-1 overflow-x-auto max-w-full">
              {(["podcast", "reaction", "competitors"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setThumbFilter(f)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors shrink-0 ${
                    thumbFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  {f === "podcast" ? "Podcast" : f === "reaction" ? "Try Not To Laugh" : "Competitors"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {thumbStats && (
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                  <span>{thumbStats.total_analyzed} ours</span>
                  <span>{thumbStats.competitor_analyzed || 0} competitors</span>
                </div>
              )}
              <button
                onClick={() => handleAnalyze(thumbFilter === "competitors" ? "competitors" : "ours")}
                disabled={analyzing}
                className="px-3 py-1 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {analyzing ? "Analyzing..." : thumbFilter === "competitors" ? "Analyze Competitors" : "Analyze Ours"}
              </button>
            </div>
          </div>

          {/* Render insights */}
          {(() => {
            const data = thumbFilter === "competitors" ? compInsights : thumbInsights;
            if (!data?.insights?.length) {
              return (
                <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
                  {data?.message || "No thumbnail data yet. Click the analyze button to start."}
                </div>
              );
            }
            return (
              <div className="space-y-3">
                {/* Summary + advice */}
                <div className="bg-card border border-border rounded-xl px-4 py-3">
                  <div className="flex items-center gap-x-6 gap-y-1 text-xs mb-2 flex-wrap">
                    <span><strong>{data.total}</strong> thumbnails analyzed</span>
                    <span>Avg views: <strong>{data.avgViews?.toLocaleString()}</strong></span>
                    {data.contentType && <span className="text-primary capitalize">{data.contentType} only</span>}
                  </div>
                  {data.advice?.length > 0 && (
                    <div className="space-y-1 mt-2 pt-2 border-t border-border">
                      <p className="text-[11px] font-semibold text-primary">Recommendations</p>
                      {data.advice.map((a: string, i: number) => (
                        <p key={i} className="text-xs text-foreground/80">{a}</p>
                      ))}
                    </div>
                  )}
                </div>

                {/* Best combos */}
                {data.combos?.length > 0 && (
                  <div className="bg-card border border-border rounded-xl px-4 py-3">
                    <h3 className="text-sm font-semibold mb-2">Best Combos (Expression + Color)</h3>
                    <div className="space-y-1.5">
                      {data.combos.slice(0, 8).map((c: any, i: number) => (
                        <div key={i} className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded capitalize truncate ${i === 0 ? "bg-green-500/15 text-pos" : ""}`}>
                              {c.expression} + {c.primary_color}
                            </span>
                            <span className="text-[10px] text-muted-foreground shrink-0">{c.count} videos</span>
                            <span className="text-xs font-medium ml-auto">{c.avg_views?.toLocaleString()} avg</span>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            {c.examples?.slice(0, 2).map((ex: any, k: number) => (
                              <img key={k} src={ex.thumbnail_url} alt="" className="w-14 h-8 object-cover rounded" />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Face pair combos */}
                {data.faceComboInsights?.length > 0 && (
                  <div className="bg-card border border-border rounded-xl px-4 py-3">
                    <h3 className="text-sm font-semibold mb-2">Best Face Pairs (Left + Right Expression)</h3>
                    <div className="space-y-1.5">
                      {data.faceComboInsights.slice(0, 6).map((f: any, i: number) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className={`text-xs font-medium flex-1 min-w-0 truncate ${i === 0 ? "text-pos" : ""}`}>
                            {f.combo}
                          </span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{f.count} videos</span>
                          <span className="text-xs font-medium shrink-0">{f.avg_views?.toLocaleString()} avg</span>
                          <div className="flex gap-1 shrink-0">
                            {f.examples?.slice(0, 2).map((ex: any, k: number) => (
                              <img key={k} src={ex.thumbnail_url} alt="" className="w-14 h-8 object-cover rounded" />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Per-attribute insights */}
                {data.insights.map((insight: any, i: number) => (
                  <div key={i} className="bg-card border border-border rounded-xl px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold">{insight.attribute}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        insight.liftPercent >= 50 ? "bg-green-500/15 text-pos" :
                        insight.liftPercent >= 20 ? "bg-yellow-500/15 text-warn" :
                        "bg-muted text-muted-foreground"
                      }`}>
                        +{insight.liftPercent}% lift
                      </span>
                    </div>

                    <div className="space-y-2">
                      {insight.values.map((v: any, j: number) => (
                        <div key={j} className={`rounded-lg px-3 py-2 ${j === 0 ? "bg-green-500/5 border border-green-500/20" : j === insight.values.length - 1 ? "bg-red-500/5 border border-red-500/20" : "bg-background/50"}`}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold capitalize">{v.value}</span>
                              <span className="text-[10px] text-muted-foreground">{v.count} videos</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                              <span>{v.avg_views?.toLocaleString()} avg views</span>
                              {v.avg_ctr > 0 && <span className="text-primary">{v.avg_ctr}% CTR</span>}
                            </div>
                          </div>
                          {v.examples?.length > 0 && (
                            <div className="flex gap-2 mt-1.5 flex-wrap">
                              {v.examples.map((ex: any, k: number) => (
                                <div key={k} className="flex items-center gap-1.5">
                                  <img src={ex.thumbnail_url} alt="" className="w-20 h-11 object-cover rounded" />
                                  <div className="min-w-0">
                                    <p className="text-[10px] truncate max-w-[120px]">{ex.title}</p>
                                    <p className="text-[10px] text-muted-foreground">{ex.views?.toLocaleString()}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Viral Score */}
      {tab === "viral" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleScore(); }}
              placeholder="Enter a proposed video title to score..."
              className="flex-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow]"
            />
            <button
              onClick={handleScore}
              disabled={scoring || !titleInput.trim()}
              className="px-4 h-9 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {scoring ? "Scoring..." : "Score"}
            </button>
          </div>

          {viralResult && (
            <div className="space-y-3">
              <div className="bg-card border border-border rounded-xl p-4 text-center">
                <p className="text-4xl font-bold text-primary">{viralResult.score}</p>
                <p className="text-xs text-muted-foreground mt-1">Viral Potential Score</p>
                <p className="text-sm mt-2">{viralResult.prediction}</p>
              </div>

              <div className="space-y-2">
                {viralResult.factors?.map((f: any, i: number) => (
                  <div key={i} className="bg-card border border-border rounded-xl px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{f.name}</span>
                      <span className={`text-sm font-bold ${f.score >= 70 ? 'text-pos' : f.score >= 50 ? 'text-warn' : 'text-neg'}`}>
                        {f.score}/100
                      </span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-1.5 mb-1.5">
                      <div
                        className={`h-1.5 rounded-full ${f.score >= 70 ? 'bg-green-500' : f.score >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${f.score}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">{f.insight}</p>
                  </div>
                ))}
              </div>

              {viralResult.similarTopVideos?.length > 0 && (
                <div className="bg-card border border-border rounded-xl p-4">
                  <h3 className="text-sm font-semibold mb-2">Similar Top Videos</h3>
                  {viralResult.similarTopVideos.map((v: any, i: number) => (
                    <p key={i} className="text-xs text-muted-foreground">"{v.title}" · {v.views?.toLocaleString()} views</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
