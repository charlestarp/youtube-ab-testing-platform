"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { tests as testsApi, videos as videosApi, score as scoreApi, tags as tagsApi } from "@/lib/api";
import type { Video, ThumbnailScoreResult, ThumbnailTag, TitlePreflightResult } from "@/lib/api";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function NewTestPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [channel, setChannel] = useState<"main" | "clips">("main");

  // Step 1: Video selection
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);

  // Step 2: Test type
  const [testType, setTestType] = useState<"thumbnail" | "title" | "both">("thumbnail");

  // Step 3: Thumbnails/Titles
  const [variants, setVariants] = useState<{ id: string; file?: File; title?: string; preview?: string; tags?: ThumbnailTag[] }[]>([]);
  const [includeOriginal, setIncludeOriginal] = useState(false);

  // Scoring state
  const [thumbnailScores, setThumbnailScores] = useState<Record<number, { loading: boolean; result?: ThumbnailScoreResult; error?: string }>>({});
  const [titleScores, setTitleScores] = useState<Record<number, { loading: boolean; result?: TitlePreflightResult; error?: string }>>({});
  const [compareResult, setCompareResult] = useState<any>(null);
  const [comparing, setComparing] = useState(false);
  const titleDebounceRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  // Step 4: Settings
  const [category, setCategory] = useState<"test" | "retest">("test");
  const [testFormat, setTestFormat] = useState<"classic" | "consecutive">("classic");
  const [testSpeed, setTestSpeed] = useState<"daily" | "hourly">("hourly");
  const [runDays, setRunDays] = useState<string[]>(DAYS);
  const [runDuration, setRunDuration] = useState(8); // days for daily, total hours for hourly
  const [timesEach, setTimesEach] = useState(4); // how many times each thumbnail is shown
  const [autoWinner, setAutoWinner] = useState("ctr");
  const [autoPlaceholder, setAutoPlaceholder] = useState("disabled");
  const [metricTarget, setMetricTarget] = useState<"time" | "metric">("time");
  const [metricTargetValue, setMetricTargetValue] = useState(100000);
  const [delayDays, setDelayDays] = useState(0);
  const [startOption, setStartOption] = useState<"video_publish" | "now" | "custom">("video_publish");
  const [customStartDate, setCustomStartDate] = useState("");

  // Redo: prefill from existing test
  const redoId = searchParams.get("redo");
  const { data: redoTest } = useSWR(
    redoId ? `redo-test-${redoId}` : null,
    () => testsApi.get(parseInt(redoId!)),
  );
  const redoApplied = useRef(false);
  useEffect(() => {
    if (!redoTest || redoApplied.current) return;
    redoApplied.current = true;
    const t = redoTest as any;
    // Select the video
    setSelectedVideo({
      video_id: t.video_id,
      title: t.video_title || t.video_id,
      thumbnail_url: t.video_thumbnail_url || `https://i.ytimg.com/vi/${t.video_id}/hqdefault.jpg`,
      publish_date: '', duration_seconds: 0, view_count: 0, like_count: 0, comment_count: 0, category: '', recent_tests: [],
    });
    if (t.channel) setChannel(t.channel);
    setTestType(t.test_type || 'thumbnail');
    setTestFormat(t.test_format || 'classic');
    setTestSpeed(t.test_speed || 'hourly');
    if (t.run_days) setRunDays(t.run_days.split(','));
    if (t.run_duration_days) setRunDuration(t.run_duration_days);
    if (t.auto_winner) setAutoWinner(t.auto_winner);
    if (t.auto_placeholder) setAutoPlaceholder(t.auto_placeholder);
    setIncludeOriginal(!!t.include_original);
    if (t.metric_target) setMetricTarget(t.metric_target);
    if (t.metric_target_value) setMetricTargetValue(t.metric_target_value);
    if (t.delay_after_publish_days) setDelayDays(t.delay_after_publish_days);
    // Fetch existing thumbnails as File objects so they can be re-uploaded
    if (t.variants?.length) {
      const nonControl = t.variants.filter((v: any) => !v.is_control);
      Promise.all(
        nonControl.map(async (v: any) => {
          if (v.thumbnail_path) {
            const filename = v.thumbnail_path.split('/').pop() || `variant_${v.label}.jpg`;
            const url = `/api/uploads/${filename}`;
            try {
              const res = await fetch(url, { credentials: 'include' });
              const blob = await res.blob();
              const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
              return { id: crypto.randomUUID(), file, title: v.title || undefined, preview: URL.createObjectURL(blob) };
            } catch {
              return { id: crypto.randomUUID(), title: v.title || undefined, preview: url };
            }
          }
          return { id: crypto.randomUUID(), title: v.title || undefined };
        })
      ).then((prefilled) => {
        if (prefilled.length) setVariants(prefilled);
      });
    }
    // Skip to step 4 (settings) since video/type/variants are prefilled
    setStep(4);
  }, [redoTest]);

  // Prefill from a dashboard suggestion: ?video=<id>&type=thumbnail&title=<current>
  const prefillApplied = useRef(false);
  useEffect(() => {
    const videoParam = searchParams.get("video");
    if (!videoParam || prefillApplied.current) return;
    prefillApplied.current = true;
    const titleParam = searchParams.get("title");
    const typeParam = searchParams.get("type");
    setSelectedVideo({
      video_id: videoParam,
      title: titleParam || videoParam,
      thumbnail_url: `https://i.ytimg.com/vi/${videoParam}/hqdefault.jpg`,
      publish_date: '', duration_seconds: 0, view_count: 0, like_count: 0, comment_count: 0, category: '', recent_tests: [],
    });
    if (typeParam === "thumbnail" || typeParam === "title" || typeParam === "both") setTestType(typeParam);
    setStep(2); // jump past video selection to variant setup
  }, [searchParams]);

  // Auto-calculate: 1 hour (hourly) or 1 day (daily) per thumbnail x variants x times each
  const variantCount = variants.length + (includeOriginal ? 1 : 0);
  const totalHours = (variantCount || 2) * timesEach;
  const totalDays = (variantCount || 2) * timesEach;
  const suggestedDays = 8;

  const { data: videoList } = useSWR(
    search.length >= 2 ? `videos-search-${search}-${channel}` : `videos-all-${channel}`,
    () => videosApi.list(search || undefined, undefined, 100, channel === "clips" ? "clips" : undefined),
  );

  // Ref so handleFileUpload can call scoreThumbnail without circular dependency
  const scoreThumbnailRef = useRef<(idx: number, file: File) => void>(() => {});

  const handleFileUpload = useCallback((files: FileList | null) => {
    if (!files) return;
    setCompareResult(null); // Reset comparison when new files added
    setVariants((prev) => {
      const newVariants = [...prev];
      for (const file of Array.from(files)) {
        const preview = URL.createObjectURL(file);
        newVariants.push({ id: crypto.randomUUID(), file, preview });
      }
      return newVariants;
    });
  }, []);

  const removeVariant = (idx: number) => {
    setVariants((prev) => prev.filter((_, i) => i !== idx));
    setThumbnailScores(prev => { const n = { ...prev }; delete n[idx]; return n; });
    setTitleScores(prev => { const n = { ...prev }; delete n[idx]; return n; });
    setCompareResult(null);
  };

  const moveVariant = (idx: number, direction: "up" | "down") => {
    setVariants((prev) => {
      const target = direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setThumbnailScores({});
    setTitleScores({});
    setCompareResult(null);
  };

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const variantIds = useMemo(() => variants.map((v) => v.id), [variants]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = variants.findIndex((v) => v.id === active.id);
    const newIdx = variants.findIndex((v) => v.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    setVariants((prev) => arrayMove(prev, oldIdx, newIdx));
    setThumbnailScores({});
    setTitleScores({});
    setCompareResult(null);
  };

  const toggleDay = (day: string) => {
    setRunDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  };

  // Score a thumbnail by index
  const scoreThumbnail = useCallback(async (idx: number, file: File) => {
    setThumbnailScores(prev => ({ ...prev, [idx]: { loading: true } }));
    try {
      const result = await scoreApi.thumbnail(file);
      setThumbnailScores(prev => ({ ...prev, [idx]: { loading: false, result } }));
    } catch (err: any) {
      setThumbnailScores(prev => ({ ...prev, [idx]: { loading: false, error: err.message || 'Scoring failed' } }));
    }
  }, []);

  // Keep ref in sync so handleFileUpload can call it without circular dep
  useEffect(() => { scoreThumbnailRef.current = scoreThumbnail; }, [scoreThumbnail]);

  // Compare all thumbnails head-to-head
  const compareAll = useCallback(async () => {
    const files = variants.map(v => v.file).filter(Boolean) as File[];
    if (files.length < 2) return;
    setComparing(true);
    setCompareResult(null);
    try {
      const result = await scoreApi.compare(files);
      setCompareResult(result);
    } catch (err: any) {
      console.error("Compare failed:", err);
      setCompareResult({ error: err.message || "Comparison failed" });
    } finally {
      setComparing(false);
    }
  }, [variants]);

  // Score a title (debounced 500ms)
  const scoreTitle = useCallback((idx: number, title: string) => {
    if (titleDebounceRef.current[idx]) clearTimeout(titleDebounceRef.current[idx]);
    if (!title.trim()) {
      setTitleScores(prev => { const n = { ...prev }; delete n[idx]; return n; });
      return;
    }
    setTitleScores(prev => ({ ...prev, [idx]: { loading: true } }));
    titleDebounceRef.current[idx] = setTimeout(async () => {
      try {
        const result = await scoreApi.titlePreflight(title.trim());
        setTitleScores(prev => ({ ...prev, [idx]: { loading: false, result } }));
      } catch (err: any) {
        setTitleScores(prev => ({ ...prev, [idx]: { loading: false, error: err.message || 'Scoring failed' } }));
      }
    }, 500);
  }, []);

  // Badge color based on score
  const scoreBadgeClass = (s: number) =>
    s >= 70 ? "bg-green-500/20 text-pos border-green-500/30" :
    s >= 50 ? "bg-amber-500/20 text-warn border-amber-500/30" :
              "bg-red-500/20 text-neg border-red-500/30";

  const canProceed = () => {
    if (step === 1) return !!selectedVideo;
    if (step === 2) return true;
    if (step === 3) return variants.length >= 2 || (variants.length >= 1 && includeOriginal);
    return true;
  };

  const handleCreate = async () => {
    if (!selectedVideo) return;
    setCreating(true);

    try {
      // Determine scheduled start time
      let scheduledStart: string | null = null;
      if (startOption === "now") {
        scheduledStart = null; // start immediately
      } else if (startOption === "custom" && customStartDate) {
        scheduledStart = new Date(customStartDate).toISOString();
      } else if (startOption === "video_publish" && (selectedVideo as any).scheduled_at) {
        const pubDate = new Date((selectedVideo as any).scheduled_at);
        pubDate.setDate(pubDate.getDate() + delayDays);
        scheduledStart = pubDate.toISOString();
      }

      const { id } = await testsApi.create({
        video_id: selectedVideo.video_id,
        video_title: selectedVideo.title,
        video_thumbnail_url: selectedVideo.thumbnail_url,
        test_type: testType,
        duration_hours_per_variant: timesEach,
        min_impressions: 500,
        test_format: testFormat,
        test_speed: testSpeed,
        run_days: runDays.join(","),
        run_duration_days: metricTarget === "time" ? runDuration : 365,
        auto_winner: autoWinner,
        auto_placeholder: autoPlaceholder,
        include_original: includeOriginal,
        delay_after_publish_days: delayDays,
        scheduled_start: scheduledStart,
        metric_target: metricTarget,
        metric_target_value: metricTarget === "metric" ? metricTargetValue : 0,
        channel,
        category,
      } as any);

      // Add "Original" variant if include_original is checked
      if (includeOriginal && selectedVideo) {
        if (testType === "title") {
          await testsApi.addTitleVariant(id, selectedVideo.title);
        }
        // For thumbnail tests, the original is saved by the start endpoint
      }

      for (const variant of variants) {
        let variantResult: any = null;
        if (variant.file) {
          variantResult = await testsApi.addVariant(id, variant.file, variant.title);
        } else if (variant.title) {
          variantResult = await testsApi.addTitleVariant(id, variant.title);
        }
        // Apply tags if any were selected
        if (variantResult?.id && variant.tags?.length) {
          for (const tag of variant.tags) {
            await tagsApi.addToVariant(id, variantResult.id, tag.name);
          }
        }
      }

      // Auto-start the test (will begin at next hour)
      if (startOption === "now" || startOption === "video_publish") {
        try { await testsApi.start(id); } catch {}
      }

      router.push(`/tests/${id}`);
    } catch (err) {
      console.error(err);
      setCreating(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{redoId ? 'Redo A/B Test' : 'New A/B Test'}</h1>
      </div>

      {/* Step indicator */}
      <div className="flex gap-1">
        {[
          { n: 1, label: "Select Video" },
          { n: 2, label: testType === "thumbnail" ? "Thumbnail Test" : testType === "title" ? "Title Test" : "Thumbnail and Title" },
          { n: 3, label: "Upload Variants" },
          { n: 4, label: "Run Test" },
        ].map(({ n, label }) => (
          <button
            key={n}
            onClick={() => n < step && setStep(n)}
            className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
              step === n ? "bg-primary text-primary-foreground" : step > n ? "bg-primary/20 text-primary cursor-pointer" : "bg-muted text-muted-foreground"
            }`}
          >
            Step {n}: {label}
          </button>
        ))}
      </div>

      {/* Step 1: Select Video */}
      {step === 1 && (
        <div className="space-y-3">
          {/* Channel toggle */}
          <div className="flex gap-1">
            <button
              onClick={() => { setChannel("main"); setSelectedVideo(null); }}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${channel === "main" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
            >
              Toni and Ryan
            </button>
            <button
              onClick={() => { setChannel("clips"); setSelectedVideo(null); }}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${channel === "clips" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
            >
              Clips Channel
            </button>
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <input
                placeholder={`Search or paste YouTube URL...`}
                value={search}
                onChange={(e) => {
                  const val = e.target.value;
                  setSearch(val);
                  // Auto-detect YouTube URL and fetch video details
                  const urlMatch = val.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
                  if (urlMatch) {
                    const videoId = urlMatch[1];
                    fetch(`/api/videos/${videoId}`, { credentials: "include" })
                      .then(r => r.json())
                      .then(data => {
                        if (data.video) {
                          setSelectedVideo({
                            video_id: videoId,
                            title: data.video.title || data.video.video_title || videoId,
                            thumbnail_url: data.video.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                            publish_date: data.video.publish_date || '',
                            duration_seconds: data.video.duration_seconds || 0,
                            view_count: data.video.view_count || 0,
                            like_count: data.video.like_count || 0,
                            comment_count: data.video.comment_count || 0,
                            category: '',
                            recent_tests: [],
                          });
                        }
                      }).catch(() => {
                        // Even if API fails, set with just the ID
                        setSelectedVideo({
                          video_id: videoId,
                          title: videoId,
                          thumbnail_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                          publish_date: '',
                          duration_seconds: 0,
                          view_count: 0,
                          like_count: 0,
                          comment_count: 0,
                          category: '',
                          recent_tests: [],
                        });
                      });
                  }
                }}
                className="w-full h-9 rounded-md border border-input bg-transparent pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow]"
              />
            </div>
          </div>

          <div className="space-y-1 max-h-[60vh] overflow-auto">
            {videoList?.map((v) => {
              const isSelected = selectedVideo?.video_id === v.video_id;
              return (
                <button
                  key={v.video_id}
                  onClick={() => setSelectedVideo(v)}
                  className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${
                    isSelected ? "bg-primary/15 border border-primary/40" : "hover:bg-accent border border-transparent"
                  }`}
                >
                  {v.thumbnail_url && <img src={v.thumbnail_url} alt="" className="w-28 h-16 object-cover rounded" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{v.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {(v as any).is_scheduled ? (
                        <><span className="text-warn font-medium">Scheduled</span> · {(v as any).scheduled_at ? new Date((v as any).scheduled_at).toLocaleDateString() : v.publish_date}</>
                      ) : (
                        <>{v.view_count?.toLocaleString()} views · {v.publish_date}</>
                      )}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 2: Test Type */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">I want to test...</p>
          <div className="grid grid-cols-3 gap-3">
            {([
              { value: "thumbnail", label: "Thumbnail Only", desc: "Test different thumbnail images" },
              { value: "title", label: "Title Only", desc: "Test different video titles" },
              { value: "both", label: "Thumbnail and Title", desc: "Test thumbnail and title together" },
            ] as const).map(({ value, label, desc }) => (
              <button
                key={value}
                onClick={() => setTestType(value)}
                className={`p-4 rounded-xl border text-left transition-colors ${
                  testType === value ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"
                }`}
              >
                <p className="text-sm font-medium">{label}</p>
                <p className="text-[11px] text-muted-foreground mt-1">{desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: Upload Variants */}
      {step === 3 && (
        <div className="space-y-4">
          {/* Selected video reference */}
          {selectedVideo && (
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">This video is being tested</p>
              <div className="flex items-center gap-3">
                {selectedVideo.thumbnail_url && <img src={selectedVideo.thumbnail_url} alt="" className="w-24 h-14 object-cover rounded" />}
                <p className="text-sm font-medium">{selectedVideo.title}</p>
              </div>
            </div>
          )}

          <p className="text-sm font-medium">
            {testType === "title" ? "Enter Title Variants" : "Upload Thumbnails"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {testType === "title"
              ? "Add at least 2 title variants to test against each other."
              : "JPG, JPEG or PNG. Recommended 3840 x 2160 (max 50MB)."}
          </p>

          {/* Compare button */}
          {variants.filter(v => v.file).length >= 2 && (testType === "thumbnail" || testType === "both") && (
            <button
              onClick={compareAll}
              disabled={comparing}
              className="w-full py-2.5 bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
            >
              {comparing ? "Analyzing thumbnails..." : compareResult && !compareResult.error ? "Re-compare Thumbnails" : "Compare Thumbnails with AI"}
            </button>
          )}

          {/* Variant grid */}
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={variantIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-2 gap-3">
                {variants.map((v, i) => (
                  <SortableVariantCard
                    key={v.id}
                    v={v}
                    i={i}
                    total={variants.length}
                    testType={testType}
                    titleScores={titleScores}
                    compareResult={compareResult}
                    scoreBadgeClass={scoreBadgeClass}
                    moveVariant={moveVariant}
                    removeVariant={removeVariant}
                    setVariants={setVariants}
                    scoreTitle={scoreTitle}
                  />
                ))}

                {/* Upload button */}
                {(testType === "thumbnail" || testType === "both") && (
                  <label className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-border rounded-xl cursor-pointer hover:border-primary/40 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground mb-2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                    <p className="text-xs text-muted-foreground">Click to upload or drag and drop</p>
                    <input type="file" accept="image/jpeg,image/png" multiple className="hidden" onChange={(e) => handleFileUpload(e.target.files)} />
                  </label>
                )}

                {testType === "title" && (
                  <button
                    onClick={() => setVariants(prev => [...prev, { id: crypto.randomUUID(), title: "" }])}
                    className="flex items-center justify-center p-6 border-2 border-dashed border-border rounded-xl hover:border-primary/40 transition-colors"
                  >
                    <p className="text-xs text-muted-foreground">+ Add Title Variant</p>
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>

          {/* Original thumbnail */}
          {selectedVideo && (
            <div className="bg-card border border-border rounded-xl p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Original Thumbnail</p>
                  <p className="text-xs mt-0.5">Title: {selectedVideo.title}</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={includeOriginal} onChange={(e) => setIncludeOriginal(e.target.checked)}
                    className="rounded" />
                  <span className="text-xs">Include in test</span>
                </label>
              </div>
              {selectedVideo.thumbnail_url && (
                <img src={selectedVideo.thumbnail_url} alt="" className="w-32 aspect-video object-cover rounded mt-2 opacity-60" />
              )}
            </div>
          )}

          {/* Comparison summary */}
          {compareResult && !compareResult.error && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 space-y-2">
              <p className="text-xs font-semibold">AI Comparison</p>
              {compareResult.predicted_winner && (
                <p className="text-[11px]">
                  Predicted winner: <span className="font-semibold text-pos">
                    {compareResult.predicted_winner.filename}
                  </span>
                  {" "}({compareResult.predicted_winner.score}/100)
                  {compareResult.predicted_winner.reason && (
                    <span className="text-muted-foreground"> - {compareResult.predicted_winner.reason}</span>
                  )}
                </p>
              )}
              {compareResult.key_differences?.length > 0 && (
                <div>
                  {compareResult.key_differences.map((d: string, di: number) => (
                    <p key={di} className="text-[10px] text-muted-foreground">{d}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          {compareResult?.error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3">
              <p className="text-[11px] text-neg">{compareResult.error}</p>
            </div>
          )}
        </div>
      )}

      {/* Step 4: Test Settings */}
      {step === 4 && (
        <div className="space-y-5">
          {/* Category */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Category</p>
            <div className="flex gap-2">
              {([
                { value: "test", label: "Test", desc: "Regular A/B test" },
                { value: "retest", label: "Retest", desc: "Retitle/repackage existing video" },
              ] as const).map(({ value, label, desc }) => (
                <button key={value} onClick={() => setCategory(value)}
                  className={`flex-1 p-3 rounded-xl border text-left transition-colors ${category === value ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Test type */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Test type</p>
            <div className="flex gap-2">
              {([
                { value: "time", label: "Time Based", desc: "Run until a specified date" },
                { value: "metric", label: "Metric Based", desc: "Run until reaching a view count" },
              ] as const).map(({ value, label, desc }) => (
                <button key={value} onClick={() => setMetricTarget(value)}
                  className={`flex-1 p-3 rounded-xl border text-left transition-colors ${metricTarget === value ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Schedule days */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Test schedule</p>
            <div className="flex gap-1">
              {DAYS.map((d, i) => (
                <button key={d} onClick={() => toggleDay(d)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${runDays.includes(d) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {DAY_LABELS[i]}
                </button>
              ))}
            </div>
          </div>

          {/* Format and speed */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Test format</p>
              <div className="flex gap-2">
                {([
                  { value: "classic", label: "Classic", desc: "A,B,C,D repeating" },
                  { value: "consecutive", label: "Consecutive", desc: "A then B then C" },
                ] as const).map(({ value, label, desc }) => (
                  <button key={value} onClick={() => setTestFormat(value)}
                    className={`flex-1 p-2 rounded-lg border text-left transition-colors ${testFormat === value ? "border-primary bg-primary/10" : "border-border"}`}>
                    <p className="text-xs font-medium">{label}</p>
                    <p className="text-[9px] text-muted-foreground">{desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Test speed</p>
              <div className="flex gap-2">
                {(["hourly", "daily"] as const).map((s) => (
                  <button key={s} onClick={() => {
                    if (s === "daily") {
                      const ok = confirm(
                        "Daily rotation is rarely the right choice.\n\n" +
                        "• Each thumbnail shows for 1 full day before rotating.\n" +
                        "• With 4+ variants this becomes a multi-week test.\n\n" +
                        "Hourly rotation gets results in hours, not days.\n\nAre you sure you want daily?"
                      );
                      if (!ok) return;
                    }
                    setTestSpeed(s);
                    setTimesEach(4);
                    setRunDuration(s === "hourly" ? 4 * (variantCount || 2) : suggestedDays);
                  }}
                    className={`flex-1 py-2 rounded-lg border text-xs font-medium capitalize transition-colors ${testSpeed === s ? "border-primary bg-primary/10 border-primary" : "border-border"} ${s === "daily" ? "opacity-60" : ""}`}>
                    {s === "hourly" ? "Hourly (recommended)" : "Daily"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Duration */}
          <div className="grid grid-cols-2 gap-4">
            {metricTarget === "time" ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  {testSpeed === "hourly" ? "Times each thumbnail is shown" : "Days each thumbnail is shown"}
                </p>
                <div className="flex items-center gap-2">
                  <input type="number" value={timesEach} onChange={(e) => {
                    const t = parseInt(e.target.value) || 1;
                    setTimesEach(t);
                    setRunDuration(testSpeed === "hourly" ? t * (variantCount || 2) : t * (variantCount || 2));
                  }}
                    min={1} max={testSpeed === "hourly" ? 48 : 14}
                    className="w-16 h-8 rounded-md border border-input bg-transparent px-2 text-sm text-center" />
                  <span className="text-xs text-muted-foreground">{testSpeed === "hourly" ? "times" : "days"}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {variantCount || 2} variants × {timesEach} {testSpeed === "hourly" ? "times" : "days"} = {testSpeed === "hourly" ? `${totalHours} hours` : `${totalDays} days`} total
                </p>
              </div>
            ) : (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Target views</p>
                <input type="number" value={metricTargetValue} onChange={(e) => setMetricTargetValue(parseInt(e.target.value) || 0)}
                  className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-sm" />
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Rotation</p>
              {testSpeed === "hourly" ? (
                <>
                  <p className="text-sm font-medium">1 hour per thumbnail</p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Cycle: {variants.map((_, i) => String.fromCharCode(65 + i)).join(', ')}
                    {includeOriginal ? ', Orig' : ''}
                    {' '}(repeats {timesEach}x)
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">1 day per thumbnail</p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Cycle: {variants.map((_, i) => String.fromCharCode(65 + i)).join(', ')}
                    {includeOriginal ? ', Orig' : ''}
                    {' '}(repeats {timesEach}x)
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Auto settings */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Auto-set winner based on</p>
              <select value={autoWinner} onChange={(e) => setAutoWinner(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-sm">
                <option value="disabled">Disabled</option>
                <option value="ctr">CTR</option>
                <option value="views">Views</option>
                <option value="watch_time">Watch Time</option>
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">Automatically set the winner when the test ends</p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Auto-set placeholder variation</p>
              <select value={autoPlaceholder} onChange={(e) => setAutoPlaceholder(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-sm">
                <option value="disabled">Disabled</option>
                <option value="first">First Variant</option>
                <option value="best">Best Performing</option>
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">Set live while gathering data</p>
            </div>
          </div>

          {/* Test start time */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">When should the test begin?</p>
            <div className="flex gap-2 mb-3">
              {([
                { value: "video_publish", label: "When video goes live", desc: selectedVideo && (selectedVideo as any).scheduled_at ? `Scheduled: ${new Date((selectedVideo as any).scheduled_at).toLocaleString()}` : "Starts when video is published" },
                { value: "now", label: "Start now", desc: "Begin immediately" },
                { value: "custom", label: "Custom date and time", desc: "Pick a specific time" },
              ] as const).map(({ value, label, desc }) => (
                <button key={value} onClick={() => setStartOption(value)}
                  className={`flex-1 p-2.5 rounded-xl border text-left transition-colors ${startOption === value ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}>
                  <p className="text-xs font-medium">{label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{desc}</p>
                </button>
              ))}
            </div>

            {startOption === "custom" && (
              <input
                type="datetime-local"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="h-8 rounded-md border border-input bg-transparent px-3 text-sm"
              />
            )}

            {startOption === "video_publish" && selectedVideo && (selectedVideo as any).scheduled_at && (
              <div className="bg-muted/30 border border-border rounded-lg px-3 py-2 mt-2">
                <p className="text-xs text-muted-foreground">Video set to publish at:</p>
                <p className="text-sm font-medium">{new Date((selectedVideo as any).scheduled_at).toLocaleString()}</p>
                <div className="flex items-center gap-2 mt-2">
                  <p className="text-[10px] text-muted-foreground">Delay after publish:</p>
                  <input type="number" value={delayDays} onChange={(e) => setDelayDays(parseInt(e.target.value) || 0)}
                    min={0} max={30}
                    className="w-16 h-6 rounded border border-input bg-transparent px-1 text-xs text-center" />
                  <span className="text-[10px] text-muted-foreground">days</span>
                </div>
                {delayDays === 0 && (
                  <p className="text-[10px] text-pos mt-1">Test will begin as soon as the video goes live</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex justify-between pt-4 border-t border-border">
        {step > 1 ? (
          <button onClick={() => setStep(step - 1)} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
            Back
          </button>
        ) : <div />}

        {step < 4 ? (
          <button
            onClick={() => canProceed() && setStep(step + 1)}
            disabled={!canProceed()}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next Step
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-6 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {creating ? "Creating..." : "Run Test"}
          </button>
        )}
      </div>
    </div>
  );
}

function SortableVariantCard({ v, i, total, testType, titleScores, compareResult, scoreBadgeClass, moveVariant, removeVariant, setVariants, scoreTitle }: any) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: v.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const tis = titleScores[i];
  const cmpData = compareResult?.thumbnails?.find((t: any) => t.index === i);
  const isWinner = compareResult?.predicted_winner?.filename === (v.file?.name || `Thumbnail ${i + 1}`);

  return (
    <div ref={setNodeRef} style={style} className={`relative border rounded-xl p-3 bg-card ${isWinner ? "border-green-500/50 ring-1 ring-green-500/20" : "border-border"} ${isDragging ? "z-50" : ""}`}>
      <div className="absolute top-2 right-2 flex items-center gap-1 z-10">
        {/* Drag handle */}
        <button {...attributes} {...listeners} className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing" title="Drag to reorder">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/></svg>
        </button>
        {i > 0 && (
          <button onClick={() => moveVariant(i, "up")} className="text-muted-foreground hover:text-foreground" title="Move left">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        )}
        {i < total - 1 && (
          <button onClick={() => moveVariant(i, "down")} className="text-muted-foreground hover:text-foreground" title="Move right">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        )}
        <button onClick={() => removeVariant(i)} className="text-muted-foreground hover:text-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2 pr-20">
        <p className="text-xs font-medium text-muted-foreground">
          {testType === "title" ? `Title ${i + 1}` : `Thumbnail ${String.fromCharCode(65 + i)}`}
        </p>
        {cmpData && (
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${scoreBadgeClass(cmpData.score)}`}>
            {cmpData.score}/100
          </span>
        )}
        {isWinner && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-500/15 text-pos border border-green-500/30">
            Predicted Winner
          </span>
        )}
        {testType === "title" && (
          tis?.loading ? (
            <span className="text-[10px] text-muted-foreground">Scoring…</span>
          ) : tis?.result ? (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${scoreBadgeClass(tis.result.score)}`}>
              {tis.result.ctr_band} · {tis.result.score}
            </span>
          ) : null
        )}
      </div>

      {v.preview && <img src={v.preview} alt="" className="w-full aspect-video object-cover rounded" />}
      {v.file && <p className="text-[10px] text-muted-foreground mt-1 truncate">{v.file.name}</p>}

      {cmpData && (
        <div className="mt-2 space-y-1.5">
          {cmpData.verdict && <p className="text-[10px] text-foreground/80">{cmpData.verdict}</p>}
          {cmpData.strengths?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {cmpData.strengths.slice(0, 3).map((s: string, si: number) => (
                <span key={si} className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-pos border border-green-500/20">{s}</span>
              ))}
            </div>
          )}
          {cmpData.weaknesses?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {cmpData.weaknesses.slice(0, 2).map((w: string, wi: number) => (
                <span key={wi} className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-neg border border-red-500/20">{w}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {(testType === "thumbnail" || testType === "both") && (
        <VariantTagPicker tags={v.tags || []} onChange={(newTags: ThumbnailTag[]) => setVariants((prev: any[]) => prev.map((item: any, j: number) => j === i ? { ...item, tags: newTags } : item))} />
      )}

      {(testType === "title" || testType === "both") && (
        <div className="mt-2 relative">
          <input
            placeholder="Title variant..."
            value={v.title || ""}
            onChange={(e) => {
              const newTitle = e.target.value;
              setVariants((prev: any[]) => prev.map((item: any, j: number) => j === i ? { ...item, title: newTitle } : item));
              if (testType === "title") scoreTitle(i, newTitle);
            }}
            className="w-full h-8 rounded-md border border-input bg-transparent px-2 pr-16 text-sm"
          />
          {tis?.result && (
            <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-semibold px-1 py-0.5 rounded border ${scoreBadgeClass(tis.result.score)}`}>
              {tis.result.score}
            </span>
          )}
          {tis?.error && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground">err</span>
          )}
          {tis?.loading && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground">...</span>
          )}
        </div>
      )}

      {tis?.result && (
        <div className="mt-1.5 space-y-1">
          {/* Signal chips — top 4 tags with colour by verdict */}
          {tis.result.signals.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tis.result.signals.slice(0, 4).map((s: any) => {
                const pos = s.verdict === 'proven' || s.verdict === 'promising' || s.verdict === 'corpus_positive';
                const neg = s.verdict === 'weak' || s.verdict === 'corpus_negative';
                const cls = pos ? "bg-green-500/10 text-pos border-green-500/20"
                           : neg ? "bg-red-500/10 text-neg border-red-500/20"
                           : "bg-border/50 text-muted-foreground border-border";
                const label = s.uplift_pct !== 0 ? `${s.tag} ${s.uplift_pct >= 0 ? '+' : ''}${s.uplift_pct}%` : s.tag;
                return (
                  <span key={s.tag} className={`text-[9px] px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>
                );
              })}
              <span className="text-[9px] text-muted-foreground self-center">{tis.result.confidence} confidence</span>
            </div>
          )}
          {/* Top reasons */}
          {tis.result.reasons.slice(0, 2).map((r: any, ri: number) => (
            <p key={ri} className="text-[9px] text-muted-foreground leading-snug">{r}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function VariantTagPicker({ tags, onChange }: { tags: ThumbnailTag[]; onChange: (tags: ThumbnailTag[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { data: allTags } = useSWR(open ? "all-tags-picker" : null, () => tagsApi.list());

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const filtered = (allTags || []).filter(t => !search || t.name.includes(search.toLowerCase()));
  const isTagged = (id: number) => tags.some(t => t.id === id);

  const toggle = (tag: ThumbnailTag) => {
    if (isTagged(tag.id)) onChange(tags.filter(t => t.id !== tag.id));
    else onChange([...tags, tag]);
  };

  const createAndAdd = async () => {
    if (!search.trim()) return;
    const created = await tagsApi.create(search.trim());
    if (created) { onChange([...tags, created]); setSearch(""); }
  };

  const exactMatch = filtered.some(t => t.name === search.trim().toLowerCase());

  return (
    <div ref={ref} className="mt-1.5 relative">
      <div className="flex flex-wrap gap-1 items-center">
        {tags.map(t => (
          <span key={t.id} onClick={() => toggle(t)} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium text-white cursor-pointer hover:opacity-80" style={{ backgroundColor: t.color }}>
            {t.name} <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6"/></svg>
          </span>
        ))}
        <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary hover:text-primary">
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2v8M2 6h8"/></svg> tag
        </button>
      </div>
      {open && (
        <div className="absolute z-30 top-full left-0 mt-1 bg-popover border border-border rounded-lg shadow-xl p-2 min-w-[200px]" onClick={e => e.stopPropagation()}>
          <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !exactMatch && search.trim()) createAndAdd(); }} placeholder="Search or create..." className="w-full px-2 py-1 text-xs bg-background border border-border rounded mb-1.5 outline-none focus:border-primary" autoFocus />
          <div className="max-h-[150px] overflow-y-auto space-y-0.5">
            {filtered.map(t => (
              <button key={t.id} onClick={() => toggle(t)} className={`w-full text-left px-2 py-1 text-xs rounded flex items-center gap-2 hover:bg-accent ${isTagged(t.id) ? "bg-accent/50" : ""}`}>
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                <span className="truncate">{t.name}</span>
                {isTagged(t.id) && <svg className="ml-auto" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 6l3 3 5-5"/></svg>}
              </button>
            ))}
          </div>
          {search.trim() && !exactMatch && (
            <button onClick={createAndAdd} className="w-full text-left px-2 py-1.5 text-xs text-primary hover:bg-accent rounded mt-1 border-t border-border pt-1.5">Create "{search.trim()}"</button>
          )}
        </div>
      )}
    </div>
  );
}
