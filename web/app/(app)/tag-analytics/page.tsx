"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  tags as tagsApi, tagCategories as catApi,
  type TagAnalyticsItem, type ThumbnailTag, type PlaybookResponse,
  type LeaderboardTag, type RetestEntry, type RetestCandidate,
  type TagContentType,
} from "@/lib/api";

const CONTENT_TABS: { key: TagContentType; label: string }[] = [
  { key: "podcast", label: "Podcast" },
  { key: "TNTL", label: "Try Not To Laugh" },
];

function fmtDur(s: number) { if (!s) return "-"; const m = Math.floor(s / 60); const sec = Math.round(s % 60); return m > 0 ? `${m}:${sec.toString().padStart(2, "0")}` : `${sec}s`; }
function fmtNum(n: number) { if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"; if (n >= 1000) return (n / 1000).toFixed(1) + "K"; return n.toLocaleString(); }

type Tab = "playbook" | "gallery" | "recipes" | "retest" | "deep-dive";

export default function TagAnalyticsPage() {
  const [tab, setTab] = useState<Tab>("playbook");
  const [contentType, setContentType] = useState<TagContentType>("podcast");
  const [manageTags, setManageTags] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [newCat, setNewCat] = useState("");
  const [autoTagging, setAutoTagging] = useState(false);
  const [autoTagMsg, setAutoTagMsg] = useState<string | null>(null);

  const runAutoTag = async () => {
    setAutoTagging(true);
    setAutoTagMsg("Reading thumbnails and applying tags, this can take a minute...");
    try {
      const r = await tagsApi.autoTag({ all: true });
      setAutoTagMsg(`Tagged ${r.tagged} of ${r.processed} thumbnails with ${r.tags} tags${r.errors ? `, ${r.errors} skipped` : ""}.`);
      mutateTags(); mutate();
    } catch {
      setAutoTagMsg("Auto-tag failed. Check the API logs.");
    } finally {
      setAutoTagging(false);
    }
  };

  // Data fetching - lazy per tab. contentType is in every key so podcast and TNTL
  // are always fetched separately and never pooled.
  const { data: playbook } = useSWR(tab === "playbook" || tab === "gallery" || tab === "recipes" || tab === "retest" ? ["tag-playbook", contentType] : null, () => tagsApi.playbook(contentType));
  const [galleryCategory, setGalleryCategory] = useState<string | null>(null);
  const [galleryTagId, setGalleryTagId] = useState<number | null>(null);
  const { data: galleryData } = useSWR(galleryTagId ? ["tag-gallery", galleryTagId, contentType] : null, () => tagsApi.tagDetail(galleryTagId!, contentType));
  const { data: retestData } = useSWR(tab === "gallery" || tab === "retest" ? "tag-retests" : null, () => tagsApi.retestHistory());
  const { data: retestCandidates } = useSWR(tab === "retest" ? "tag-retest-candidates" : null, () => tagsApi.retestCandidates());
  const { data: comboData } = useSWR(tab === "recipes" ? ["tag-combos", contentType] : null, () => tagsApi.combos(contentType));
  const { data: deepData, isLoading: deepLoading, mutate } = useSWR(tab === "deep-dive" ? ["tag-analytics", contentType] : null, () => tagsApi.analytics({ min_impressions: "0", content_type: contentType }));
  const [expandedTag, setExpandedTag] = useState<number | null>(null);
  const { data: detail } = useSWR(expandedTag ? ["tag-detail", expandedTag, contentType] : null, () => tagsApi.tagDetail(expandedTag!, contentType));
  const { data: allTags, mutate: mutateTags } = useSWR("all-tags-manage", () => tagsApi.list());
  const { data: categories, mutate: mutateCats } = useSWR("tag-cats", () => catApi.list());

  // Deep dive filter state
  const [includeTags, setIncludeTags] = useState<ThumbnailTag[]>([]);
  const [excludeTags, setExcludeTags] = useState<ThumbnailTag[]>([]);
  const [showFilter, setShowFilter] = useState(false);
  const { data: filterData } = useSWR(
    includeTags.length > 0 || excludeTags.length > 0 ? ["tag-filter", includeTags.map(t => t.id).join(','), excludeTags.map(t => t.id).join(','), contentType] : null,
    () => tagsApi.filter(includeTags.map(t => t.id), excludeTags.map(t => t.id), contentType)
  );

  // Deep dive sorting
  const [sortBy, setSortBy] = useState("weighted_ctr");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const toggleSort = (key: string) => { if (sortBy === key) setSortDir(d => d === "desc" ? "asc" : "desc"); else { setSortBy(key); setSortDir("desc"); } };

  const deepSorted = useMemo(() => {
    if (!deepData?.tags) return [];
    return [...deepData.tags].sort((a, b) => {
      const av = (a as any)[sortBy] ?? 0, bv = (b as any)[sortBy] ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });
  }, [deepData, sortBy, sortDir]);

  // Gallery: auto-select first category winner
  const galleryWinners = useMemo(() => {
    if (!playbook) return [];
    return playbook.recipe.tags;
  }, [playbook]);

  // Set default gallery tag when playbook loads
  if (galleryWinners.length > 0 && !galleryTagId && !galleryCategory) {
    const first = galleryWinners[0];
    setGalleryCategory(first.category);
    setGalleryTagId(first.id);
  }

  // Cross-category combos for recipes tab
  const crossCategoryCombos = useMemo(() => {
    if (!comboData?.all) return [];
    return comboData.all.filter((combo: any) => {
      const cats = new Set(combo.tags.map((t: any) => {
        const tag = (allTags || []).find(at => at.id === t.id);
        return tag?.category || "other";
      }));
      return cats.size === combo.tags.length;
    });
  }, [comboData, allTags]);

  const scoreColor = (score: number) => {
    if (score >= 120) return "text-pos";
    if (score >= 90) return "text-foreground";
    if (score >= 60) return "text-warn";
    return "text-neg";
  };

  const availableFilterTags = (allTags || []).filter(t => !includeTags.some(i => i.id === t.id) && !excludeTags.some(e => e.id === t.id));

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold">Tag Analytics</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-muted rounded-lg p-0.5 overflow-x-auto max-w-full">
            {(["playbook", "gallery", "recipes", "retest", "deep-dive"] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 text-xs rounded-md transition-colors shrink-0 whitespace-nowrap ${tab === t ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {t === "playbook" ? "Playbook" : t === "gallery" ? "Gallery" : t === "recipes" ? "Recipes" : t === "retest" ? "Retest" : "Deep Dive"}
              </button>
            ))}
          </div>
          <button onClick={() => setManageTags(!manageTags)} className="px-3 py-1.5 text-xs font-medium bg-card border border-border rounded-lg hover:bg-accent shrink-0">
            {manageTags ? "Done" : "Manage Tags"}
          </button>
        </div>
      </div>

      {/* ===== CONTENT TYPE SWITCH ===== */}
      {tab !== "retest" && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex bg-muted rounded-lg p-0.5">
            {CONTENT_TABS.map(c => (
              <button key={c.key} onClick={() => setContentType(c.key)} className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-colors ${contentType === c.key ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {c.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Podcast and Try Not To Laugh are packaged differently, so their numbers are kept separate and never mixed.
          </p>
        </div>
      )}

      {/* ===== TAG MANAGEMENT MODAL ===== */}
      {manageTags && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          <div className="flex gap-2">
            <input value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && newTag.trim()) tagsApi.create(newTag.trim()).then(() => { mutateTags(); mutate(); setNewTag(""); }); }} placeholder="New tag name..." className="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded-lg outline-none focus:border-primary" />
            <button onClick={() => { if (newTag.trim()) tagsApi.create(newTag.trim()).then(() => { mutateTags(); mutate(); setNewTag(""); }); }} className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg">Add</button>
          </div>
          <div className="flex items-center gap-3 border-t border-border pt-3">
            <button onClick={runAutoTag} disabled={autoTagging} className="px-3 py-1.5 text-sm font-medium bg-brand-blue/15 text-info border border-brand-blue/30 rounded-lg hover:bg-brand-blue/25 disabled:opacity-60">
              {autoTagging ? "Auto-tagging..." : "Auto-tag untagged thumbnails"}
            </button>
            <p className="text-xs text-muted-foreground">{autoTagMsg || "Uses Claude Vision to apply these tags to any thumbnail that has none. Tags with a dashed outline were applied by AI, solid ones by hand."}</p>
          </div>
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-muted-foreground mb-1">Tagging conventions</p>
            <ul className="text-xs text-muted-foreground space-y-0.5">
              <li><span className="font-medium text-foreground">Tweet length:</span> 1 line is a short tweet, 2 to 3 lines is a medium tweet, 4 or more lines is a long tweet.</li>
              <li><span className="font-medium text-foreground">People:</span> Toni is the woman, Ryan is the man. Tag who appears and their side.</li>
            </ul>
          </div>
          {(() => {
            const cats = categories || [];
            const grouped: Record<string, any[]> = {};
            for (const c of cats) grouped[c.name] = [];
            for (const tag of (allTags || [])) {
              const cat = tag.category || "other";
              if (grouped[cat]) grouped[cat].push(tag);
              else if (grouped["other"]) grouped["other"].push(tag);
            }
            return (<>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(140px, 1fr))` }}>
                {cats.map(cat => (
                  <div key={cat.id} className="space-y-2">
                    <div className="flex items-center gap-1.5 group/cat">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                      <input defaultValue={cat.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== cat.name) catApi.update(cat.id, { name: v }).then(() => { mutateCats(); mutateTags(); mutate(); }); }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-transparent border-none outline-none focus:underline min-w-0 flex-1" />
                      {cat.name !== "other" && (<button onClick={() => { if (confirm(`Delete "${cat.name}" category?`)) catApi.delete(cat.id).then(() => { mutateCats(); mutateTags(); mutate(); }); }} className="text-muted-foreground hover:text-neg opacity-0 group-hover/cat:opacity-100 shrink-0"><svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>)}
                    </div>
                    <div className="min-h-[60px] bg-muted/30 rounded-lg p-2 space-y-1 border border-dashed border-border transition-colors"
                      onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
                      onDragLeave={e => e.currentTarget.classList.remove('border-primary')}
                      onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('border-primary'); const tagId = parseInt(e.dataTransfer.getData('tagId')); if (tagId) tagsApi.update(tagId, { category: cat.name }).then(() => { mutateTags(); mutate(); }); }}>
                      {(grouped[cat.name] || []).map((tag: any) => (
                        <div key={tag.id} draggable onDragStart={e => e.dataTransfer.setData('tagId', String(tag.id))} className="flex items-center gap-1.5 px-2 py-1 bg-card rounded text-xs group cursor-grab active:cursor-grabbing hover:bg-accent">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                          <input defaultValue={tag.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== tag.name) tagsApi.update(tag.id, { name: v }).then(() => { mutateTags(); mutate(); }); }} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} onClick={e => e.stopPropagation()} className="bg-transparent border-none outline-none flex-1 min-w-0 text-xs focus:underline" />
                          <button onClick={() => { if (confirm(`Delete "${tag.name}"?`)) tagsApi.delete(tag.id).then(() => { mutateTags(); mutate(); }); }} className="text-muted-foreground hover:text-neg opacity-0 group-hover:opacity-100 shrink-0"><svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>
                        </div>
                      ))}
                      {(grouped[cat.name] || []).length === 0 && <p className="text-[9px] text-muted-foreground/50 text-center py-2">Drag here</p>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <input value={newCat} onChange={e => setNewCat(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && newCat.trim()) catApi.create(newCat.trim()).then(() => { mutateCats(); setNewCat(""); }); }} placeholder="New category..." className="px-2 py-1 text-xs bg-background border border-border rounded outline-none focus:border-primary w-40" />
                <button onClick={() => { if (newCat.trim()) catApi.create(newCat.trim()).then(() => { mutateCats(); setNewCat(""); }); }} className="text-xs text-primary hover:underline">Add Category</button>
                <span className="text-[10px] text-muted-foreground ml-auto">Drag tags between categories</span>
              </div>
            </>);
          })()}
        </div>
      )}

      {/* ===== PLAYBOOK TAB ===== */}
      {tab === "playbook" && (
        <div className="space-y-6">
          {!playbook ? <p className="text-sm text-muted-foreground text-center py-16">Loading playbook...</p> : playbook.recipe.tags.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-16">Not enough tagged data yet. Tag more thumbnails on your test pages.</p>
          ) : (<>
            {/* Recipe Hero */}
            <div className="bg-card border border-border rounded-xl p-6">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-3">Your Winning Formula, {contentType === "TNTL" ? "Try Not To Laugh" : "Podcast"}</p>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                {playbook.recipe.tags.map((tag, i) => (<>
                  {i > 0 && <span key={`plus-${i}`} className="text-muted-foreground font-bold text-lg">+</span>}
                  <div key={tag.id} className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-muted/30">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: tag.color }} />
                    <span className="text-sm font-semibold">{tag.name}</span>
                    <span className="text-[9px] text-muted-foreground uppercase">{tag.category_name}</span>
                  </div>
                </>))}
              </div>
              <div className="flex items-baseline gap-6">
                {playbook.recipe.composite_ctr > 0 ? (
                  <>
                    <div>
                      <span className="text-3xl font-bold text-pos">{playbook.recipe.composite_ctr}%</span>
                      <span className="text-sm text-muted-foreground ml-2">combo CTR</span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      vs <span className="font-semibold text-foreground">{playbook.recipe.channel_avg_ctr}%</span> channel avg
                      {playbook.recipe.uplift_pct > 0 && <span className="text-pos ml-1">(+{playbook.recipe.uplift_pct}%)</span>}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">This exact combo hasn't been tested yet, but each tag is the best in its category.</p>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground mt-3">Based on {playbook.recipe.variant_count} tagged variants across all tests</p>
            </div>

            {/* Category Leaderboards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {playbook.categories.map(cat => {
                const tags = playbook.leaderboards[cat.name];
                if (!tags || tags.length === 0) return null;
                return (
                  <div key={cat.id} className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cat.color }} />
                      <span className="text-xs font-bold uppercase tracking-wider">{cat.name}</span>
                    </div>
                    <div className="divide-y divide-border/30">
                      {tags.map((tag: LeaderboardTag) => (
                        <div key={tag.id} className={`px-4 py-2.5 flex items-center gap-3 ${tag.rank === 1 ? "bg-green-500/5" : ""}`}>
                          <span className={`text-[10px] font-bold w-4 text-center ${tag.rank === 1 ? "text-pos" : "text-muted-foreground"}`}>
                            {tag.rank === 1 ? "#1" : `#${tag.rank}`}
                          </span>
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                          <span className="text-xs font-medium flex-1 min-w-0 truncate">{tag.name}</span>
                          <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
                            <div className="h-full rounded-full transition-all" style={{ width: `${tag.bar_pct}%`, backgroundColor: tag.rank === 1 ? "#18b16d" : tag.color }} />
                          </div>
                          <span className={`text-xs font-semibold tabular-nums w-12 text-right ${tag.rank === 1 ? "text-pos" : ""}`}>{tag.weighted_ctr}%</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded ${tag.win_rate >= 50 ? "bg-green-500/20 text-pos" : "bg-muted text-muted-foreground"}`}>{tag.win_count}/{tag.test_count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Top Insights */}
            {playbook.top_insights.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {playbook.top_insights.map((insight, i) => (
                  <div key={i} className="bg-card border border-border rounded-xl px-4 py-3 flex items-start gap-3">
                    <span className="text-lg font-bold text-pos shrink-0">+{insight.diff_pct}%</span>
                    <p className="text-xs text-muted-foreground leading-relaxed">{insight.text}</p>
                  </div>
                ))}
              </div>
            )}
          </>)}
        </div>
      )}

      {/* ===== GALLERY TAB ===== */}
      {tab === "gallery" && (
        <div className="space-y-6">
          {/* Category filter pills */}
          {galleryWinners.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {galleryWinners.map(winner => (
                <button
                  key={winner.id}
                  onClick={() => { setGalleryCategory(winner.category); setGalleryTagId(winner.id); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${galleryTagId === winner.id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: winner.color }} />
                  {winner.name}
                  <span className="text-[9px] text-muted-foreground">{winner.weighted_ctr}% CTR</span>
                </button>
              ))}
            </div>
          )}

          {/* Thumbnail grid */}
          {galleryData ? (
            <div>
              <p className="text-xs text-muted-foreground mb-3">{galleryData.variants.length} thumbnails tagged "{galleryData.tag.name}"</p>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {galleryData.variants.filter((v: any) => v.thumbnail_path).map((v: any) => (
                  <Link key={v.id} href={`/tests/${v.test_id}`} className={`group bg-card border rounded-xl overflow-hidden hover:border-primary/50 transition-colors ${v.winner_variant_id === v.id ? "border-green-500/50" : "border-border"}`}>
                    <div className="relative">
                      <img src={`/api/thumb/${v.thumbnail_path.split("/").pop()}`} alt="" className="w-full aspect-video object-cover" loading="lazy" />
                      <div className="absolute top-1.5 right-1.5 bg-black/70 backdrop-blur-sm px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums text-white">
                        {v.weighted_ctr}%
                      </div>
                      {v.winner_variant_id === v.id && (
                        <div className="absolute top-1.5 left-1.5 bg-green-500/90 px-1.5 py-0.5 rounded text-[9px] font-bold text-white">WINNER</div>
                      )}
                    </div>
                    <div className="p-2.5 space-y-1.5">
                      <p className="text-[11px] font-medium truncate">{v.video_title}</p>
                      <div className="flex gap-2 text-[10px] text-muted-foreground tabular-nums">
                        <span>{fmtNum(v.total_impressions)} imp</span>
                        <span>AVD {fmtDur(v.avg_view_duration)}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ) : galleryTagId ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading thumbnails...</p>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">Select a tag above to see thumbnails</p>
          )}

          {/* Before/After Retests */}
          {retestData && retestData.retests.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-border">
              <h2 className="text-sm font-semibold">Before and After</h2>
              <p className="text-xs text-muted-foreground">Videos that were retested with different thumbnails</p>
              <div className="space-y-3">
                {retestData.retests.map((r: RetestEntry, i: number) => (
                  <div key={i} className="bg-card border border-border rounded-xl p-4">
                    <p className="text-xs font-medium mb-3 truncate">{r.video_title}</p>
                    <div className="grid grid-cols-2 gap-4">
                      {/* Before */}
                      <div>
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1.5">Before</p>
                        <Link href={`/tests/${r.before.test_id}`} className="block">
                          {r.before.thumbnail_path && <img src={`/api/thumb/${r.before.thumbnail_path.split("/").pop()}`} alt="" className="w-full aspect-video object-cover rounded-lg border border-border mb-2" loading="lazy" />}
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold tabular-nums">{r.before.ctr}% CTR</span>
                            <span className="text-[10px] text-muted-foreground">{fmtNum(r.before.impressions)} imp</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {r.before.tags.map(t => <span key={t.id} className="px-1.5 py-0.5 rounded-full text-[8px] font-medium text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}
                          </div>
                        </Link>
                      </div>
                      {/* After */}
                      <div>
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1.5">After</p>
                        <Link href={`/tests/${r.after.test_id}`} className="block">
                          {r.after.thumbnail_path && <img src={`/api/thumb/${r.after.thumbnail_path.split("/").pop()}`} alt="" className="w-full aspect-video object-cover rounded-lg border border-border mb-2" loading="lazy" />}
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold tabular-nums">{r.after.ctr}% CTR</span>
                            <span className={`text-xs font-bold ${r.ctr_delta >= 0 ? "text-pos" : "text-neg"}`}>
                              {r.ctr_delta >= 0 ? "+" : ""}{r.ctr_delta.toFixed(2)}%
                              {r.ctr_delta_pct !== 0 && <span className="text-[10px] font-normal ml-1">({r.ctr_delta_pct >= 0 ? "+" : ""}{r.ctr_delta_pct}%)</span>}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {r.after.tags.map(t => {
                              const isNew = r.tags_added.some(a => a.id === t.id);
                              return <span key={t.id} className={`px-1.5 py-0.5 rounded-full text-[8px] font-medium text-white ${isNew ? "ring-1 ring-green-400" : ""}`} style={{ backgroundColor: t.color }}>{t.name}</span>;
                            })}
                          </div>
                        </Link>
                      </div>
                    </div>
                    {/* Tag diff */}
                    {(r.tags_added.length > 0 || r.tags_removed.length > 0) && (
                      <div className="mt-3 pt-2 border-t border-border/30 flex flex-wrap gap-2 text-[10px]">
                        {r.tags_added.map(t => <span key={t.id} className="text-pos">+ {t.name}</span>)}
                        {r.tags_removed.map(t => <span key={t.id} className="text-neg">- {t.name}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== RECIPES TAB ===== */}
      {tab === "recipes" && (
        <div className="space-y-6">
          {!comboData ? <p className="text-sm text-muted-foreground text-center py-16">Analyzing recipes...</p> : (<>
            {/* Global average */}
            <div className="bg-muted/30 border border-border rounded-xl px-4 py-3 flex items-center gap-x-6 gap-y-1 text-xs flex-wrap">
              <span className="text-muted-foreground">Channel averages:</span>
              <span>CTR <span className="font-semibold">{comboData.global_avg.ctr}%</span></span>
              <span>AVD <span className="font-semibold">{fmtDur(comboData.global_avg.avd)}</span></span>
              <span className="text-muted-foreground sm:ml-auto">Score 100 = average</span>
            </div>

            {/* Cross-category combos */}
            {crossCategoryCombos.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold">Best Cross-Category Recipes</h2>
                <p className="text-xs text-muted-foreground">Combinations where each tag comes from a different category</p>
                <div className="space-y-2">
                  {crossCategoryCombos.sort((a: any, b: any) => b.composite_score - a.composite_score).slice(0, 15).map((combo: any, i: number) => (
                    <div key={i} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-4 flex-wrap sm:flex-nowrap">
                      <div className="text-2xl font-bold tabular-nums w-12 text-center shrink-0">
                        <span className={scoreColor(combo.composite_score)}>{combo.composite_score}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap gap-1.5 mb-1.5">
                          {combo.tags.map((t: any, j: number) => (
                            <span key={j} className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: t.color }}>{t.name}</span>
                          ))}
                        </div>
                        <div className="flex gap-4 text-[10px] text-muted-foreground flex-wrap">
                          <span>{combo.variant_count} thumbnails, {combo.test_count} tests</span>
                          <span>{fmtNum(combo.total_impressions)} imp</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-4 shrink-0 text-right w-full sm:w-auto">
                        <div>
                          <p className="text-[9px] text-muted-foreground">CTR</p>
                          <p className="text-xs font-semibold tabular-nums">{combo.weighted_ctr}%</p>
                          <p className={`text-[9px] tabular-nums ${combo.ctr_vs_avg >= 0 ? "text-pos" : "text-neg"}`}>{combo.ctr_vs_avg >= 0 ? "+" : ""}{combo.ctr_vs_avg}%</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-muted-foreground">AVD</p>
                          <p className="text-xs font-semibold tabular-nums">{fmtDur(combo.avg_view_duration)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] text-muted-foreground">Wins</p>
                          <p className="text-xs tabular-nums">{combo.win_count}/{combo.test_count}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No cross-category combos found yet. Ensure tags are organized into categories and each variant has one tag per category.</p>
            )}

            {/* All combos fallback if no cross-category */}
            {crossCategoryCombos.length === 0 && comboData.best.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold">Top Performing Combinations</h2>
                <div className="space-y-2">
                  {comboData.best.map((combo: any, i: number) => (
                    <div key={i} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-4">
                      <span className={`text-2xl font-bold tabular-nums w-12 text-center ${scoreColor(combo.composite_score)}`}>{combo.composite_score}</span>
                      <div className="flex flex-wrap gap-1.5 flex-1">{combo.tags.map((t: any, j: number) => <span key={j} className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}</div>
                      <span className="text-xs font-semibold tabular-nums">{combo.weighted_ctr}% CTR</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>)}
        </div>
      )}

      {/* ===== RETEST TAB ===== */}
      {tab === "retest" && (
        <div className="space-y-6">
          {!retestCandidates ? <p className="text-sm text-muted-foreground text-center py-16">Finding retest candidates...</p> : retestCandidates.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-16">No retest candidates found. All videos are performing above average CTR.</p>
          ) : (<>
            <div className="bg-muted/30 border border-border rounded-xl px-4 py-3 flex items-center gap-x-4 gap-y-1.5 text-xs flex-wrap">
              <span className="text-muted-foreground">Channel avg CTR:</span>
              <span className="font-semibold">{retestCandidates.channel_avg_ctr}%</span>
              <span className="text-muted-foreground sm:ml-4">Suggested recipe:</span>
              <div className="flex gap-1.5 flex-wrap">
                {retestCandidates.suggested_tags.map(t => <span key={t.id} className="px-1.5 py-0.5 rounded-full text-[9px] font-medium text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}
              </div>
            </div>

            <div className="space-y-2">
              {retestCandidates.candidates.map((c: RetestCandidate) => (
                <div key={c.video_id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{c.title}</p>
                    <div className="flex gap-3 text-[10px] text-muted-foreground mt-1 flex-wrap">
                      <span>{fmtNum(c.impressions)} impressions</span>
                      <span>{fmtNum(c.views)} views</span>
                      <span>AVD {fmtDur(c.avg_view_duration_sec)}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-neg tabular-nums">{c.current_ctr}% CTR</p>
                    <p className="text-[10px] text-muted-foreground">{c.ctr_gap}% below avg</p>
                  </div>
                  {c.test_id ? (
                    <Link href={`/tests/${c.test_id}`} className="px-3 py-1.5 text-[10px] font-medium bg-muted border border-border rounded-lg hover:bg-accent shrink-0">
                      View Test
                    </Link>
                  ) : (
                    <span className="px-3 py-1.5 text-[10px] font-medium bg-primary/10 text-primary border border-primary/30 rounded-lg shrink-0">
                      Retest
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>)}
        </div>
      )}

      {/* ===== DEEP DIVE TAB ===== */}
      {tab === "deep-dive" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowFilter(!showFilter)} className={`px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors ${showFilter ? "bg-primary/10 border-primary/30 text-primary" : "bg-card border-border hover:bg-accent"}`}>
              {showFilter ? "Hide Filter" : "Build Filter"}
            </button>
          </div>

          {/* Filter builder */}
          {showFilter && (
            <div className="bg-card border border-border rounded-xl p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-pos">MUST have:</p>
                  <div className="flex flex-wrap gap-1.5 min-h-[32px]">
                    {includeTags.map(tag => (
                      <button key={tag.id} onClick={() => setIncludeTags(includeTags.filter(t => t.id !== tag.id))} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium text-white hover:opacity-80" style={{ backgroundColor: tag.color }}>
                        {tag.name} <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6"/></svg>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-neg">MUST NOT have:</p>
                  <div className="flex flex-wrap gap-1.5 min-h-[32px]">
                    {excludeTags.map(tag => (
                      <button key={tag.id} onClick={() => setExcludeTags(excludeTags.filter(t => t.id !== tag.id))} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium bg-red-500/20 text-neg hover:bg-red-500/30">
                        {tag.name} <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6"/></svg>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="border-t border-border pt-3">
                <p className="text-[10px] text-muted-foreground mb-2">Click to include, right-click to exclude:</p>
                <div className="flex flex-wrap gap-1.5">
                  {availableFilterTags.map(tag => (
                    <button key={tag.id} onClick={() => setIncludeTags([...includeTags, tag])} onContextMenu={e => { e.preventDefault(); setExcludeTags([...excludeTags, tag]); }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium border border-border hover:border-primary/50 text-muted-foreground hover:text-foreground">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Filter results */}
              {filterData && filterData.matching.length > 0 && (
                <div className="border-t border-border pt-4 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-muted/30 rounded-lg p-3">
                      <p className="text-[10px] text-muted-foreground">Matching CTR</p>
                      <p className="text-xl font-bold text-pos">{filterData.aggregate.ctr}%</p>
                      {filterData.other && <p className="text-[10px] text-muted-foreground mt-1">vs {filterData.other.ctr}% others</p>}
                    </div>
                    <div className="bg-muted/30 rounded-lg p-3">
                      <p className="text-[10px] text-muted-foreground">Matching AVD</p>
                      <p className="text-xl font-bold">{fmtDur(filterData.aggregate.avd)}</p>
                    </div>
                    <div className="bg-muted/30 rounded-lg p-3">
                      <p className="text-[10px] text-muted-foreground">Wins</p>
                      <p className="text-xl font-bold">{filterData.aggregate.win_count}/{filterData.aggregate.test_count}</p>
                    </div>
                    <div className="bg-muted/30 rounded-lg p-3">
                      <p className="text-[10px] text-muted-foreground">Variants</p>
                      <p className="text-xl font-bold">{filterData.aggregate.variant_count}</p>
                    </div>
                  </div>
                  <div className="divide-y divide-border/30 bg-muted/10 rounded-lg">
                    {filterData.matching.map((v: any) => (
                      <Link key={v.id} href={`/tests/${v.test_id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-accent/30">
                        {v.thumbnail_path ? <img src={`/api/thumb/${v.thumbnail_path.split("/").pop()}`} alt="" className="w-24 aspect-video object-cover rounded-lg shrink-0" loading="lazy" /> : <div className="w-24 aspect-video bg-muted rounded-lg shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate">{v.video_title}</p>
                          <div className="flex flex-wrap gap-1 mt-1">{v.tags?.map((t: any) => <span key={t.id} className="px-1.5 py-0.5 rounded-full text-[8px] font-medium text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}</div>
                        </div>
                        <span className={`text-sm font-bold tabular-nums ${scoreColor(v.composite_score)}`}>{v.composite_score}</span>
                        <span className="text-xs font-semibold tabular-nums">{v.weighted_ctr}%</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tag table */}
          {deepLoading ? <p className="text-sm text-muted-foreground text-center py-16">Loading...</p> : deepSorted.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-16">No tagged variants yet</p>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border bg-muted/30">
                    <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Tag</th>
                    <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Category</th>
                    {[["weighted_ctr","CTR"],["avg_view_duration","AVD"],["win_rate","Wins"],["total_impressions","Impressions"]].map(([k,l]) => (
                      <th key={k} onClick={() => toggleSort(k)} className={`py-2.5 px-3 text-right font-medium cursor-pointer hover:text-foreground select-none whitespace-nowrap ${sortBy === k ? "text-primary" : "text-muted-foreground"}`}>
                        {l}{sortBy === k && (sortDir === "desc" ? " \u2193" : " \u2191")}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>{deepSorted.map((tag: any) => (<>
                    <tr key={tag.id} onClick={() => setExpandedTag(expandedTag === tag.id ? null : tag.id)} className={`border-b border-border/30 hover:bg-accent/30 cursor-pointer ${expandedTag === tag.id ? "bg-accent/20" : ""}`}>
                      <td className="py-3 px-3"><div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="font-semibold">{tag.name}</span>
                        <span className="text-muted-foreground text-[10px]">{tag.variant_count}v / {tag.test_count}t</span>
                      </div></td>
                      <td className="py-3 px-3 text-muted-foreground">{tag.category || "-"}</td>
                      <td className="py-3 px-3 text-right tabular-nums font-semibold">{tag.weighted_ctr}%</td>
                      <td className="py-3 px-3 text-right tabular-nums">{fmtDur(tag.avg_view_duration)}</td>
                      <td className="py-3 px-3 text-right"><span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${tag.win_rate >= 50 ? "bg-green-500/20 text-pos" : "bg-muted text-muted-foreground"}`}>{tag.win_count}/{tag.test_count}</span></td>
                      <td className="py-3 px-3 text-right tabular-nums">{fmtNum(tag.total_impressions)}</td>
                    </tr>
                    {expandedTag === tag.id && detail?.variants && (
                      <tr key={`e-${tag.id}`}><td colSpan={6} className="p-0"><div className="bg-muted/20 border-t border-border/30 px-4 py-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {detail.variants.map((v: any) => (
                          <Link key={v.id} href={`/tests/${v.test_id}`} className={`flex gap-3 bg-card border rounded-xl p-3 hover:border-primary/50 ${v.winner_variant_id === v.id ? "border-green-500/40" : "border-border"}`}>
                            {v.thumbnail_path ? <img src={`/api/thumb/${v.thumbnail_path.split("/").pop()}`} alt="" className="w-24 aspect-video object-cover rounded-lg shrink-0" loading="lazy" /> : <div className="w-24 aspect-video bg-muted rounded-lg shrink-0" />}
                            <div className="min-w-0 flex-1 space-y-1">
                              <p className="text-[11px] font-medium truncate">{v.video_title}</p>
                              <div className="flex items-center gap-2"><span className="text-[10px] text-muted-foreground">Variant {v.label}</span>{v.winner_variant_id === v.id && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/20 text-pos">WINNER</span>}</div>
                              <div className="flex gap-3 text-[10px] tabular-nums"><span>CTR {v.weighted_ctr}%</span><span>{fmtNum(v.total_impressions)} imp</span></div>
                            </div>
                          </Link>
                        ))}
                      </div></td></tr>
                    )}
                  </>))}</tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
