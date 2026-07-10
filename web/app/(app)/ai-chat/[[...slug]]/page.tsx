"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";

// Explicit renderers so formatting never depends on the typography plugin.
// Thick top borders on H2 and thick <hr> give clear breaks between sections.
const mdComponents: Record<string, (p: any) => React.ReactElement> = {
  h1: ({ node, ...p }) => <h1 className="text-lg font-extrabold text-foreground mt-5 mb-2 first:mt-0" {...p} />,
  h2: ({ node, ...p }) => <h2 className="text-[15px] font-bold text-foreground mt-6 mb-3 pt-4 border-t-2 border-border first:mt-0 first:border-t-0 first:pt-0" {...p} />,
  h3: ({ node, ...p }) => <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mt-4 mb-1.5" {...p} />,
  p: ({ node, ...p }) => <p className="my-2 leading-relaxed text-foreground/90" {...p} />,
  ul: ({ node, ...p }) => <ul className="my-2.5 pl-5 list-disc marker:text-primary space-y-1.5" {...p} />,
  ol: ({ node, ...p }) => <ol className="my-2.5 pl-5 list-decimal marker:text-muted-foreground space-y-1.5" {...p} />,
  li: ({ node, ...p }) => <li className="leading-relaxed pl-1" {...p} />,
  strong: ({ node, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
  em: ({ node, ...p }) => <em className="italic" {...p} />,
  a: ({ node, ...p }) => <a className="text-info hover:underline" {...p} />,
  hr: () => <hr className="my-6 border-0 border-t-2 border-border" />,
  code: ({ node, ...p }) => <code className="bg-muted px-1 py-0.5 rounded text-[0.85em]" {...p} />,
  blockquote: ({ node, ...p }) => <blockquote className="border-l border-border pl-3 italic text-muted-foreground my-2" {...p} />,
};
import { producer, streamProducer, videos as videosApi, type ProducerMessage, type ProducerSuggestion, type Video } from "@/lib/api";
import { useUser } from "@/lib/auth";

const OWNER_EMAIL = "team@example.com";
const defaultModelFor = (email?: string | null) => (email?.toLowerCase() === OWNER_EMAIL ? "claude-opus-4-8" : "claude-sonnet-4-6");

const TOOL_LABELS: Record<string, string> = {
  check_title: "checking the title",
  get_recent_performance: "reading recent performance",
  get_learnings: "reviewing what works",
  search_videos: "searching past videos",
  get_video_analytics: "pulling video analytics",
  get_top_performing: "finding top performers",
  get_channel_trends: "reading channel trends",
  score_title: "scoring the title",
  search_competitor_videos: "checking competitors",
  get_competitor_stats: "checking competitors",
  get_test_results: "reading A/B tests",
  analyze_title_patterns: "analysing title patterns",
  search_transcripts: "searching transcripts",
  get_episode_transcript: "reading a transcript",
  get_prerelease_transcript: "reading the transcript",
  list_prerelease_transcripts: "listing transcripts",
  search_comments: "reading comments",
  get_benchmarks: "pulling benchmarks",
  get_growth_projections: "checking growth",
  find_seo_gaps: "finding SEO gaps",
  detect_fatigue: "checking for fatigue",
  get_thumbnail_insights: "reviewing thumbnails",
  lock_title: "locking the decision",
  get_recent_decisions: "recalling recent decisions",
  remember_rule: "saving the rule",
};
const toolLabel = (n: string) => TOOL_LABELS[n] || n.replace(/_/g, " ");

interface ThreadMsg extends Partial<ProducerMessage> {
  role: "user" | "assistant";
  content: string;
  suggestions?: ProducerSuggestion[];
  tools?: string[];
}

export default function ProducerPage() {
  const router = useRouter();
  const params = useParams();
  const urlId = Array.isArray(params?.slug) ? Number(params.slug[0]) : undefined;
  const { data: conversations, mutate: mutateConvos } = useSWR("producer-convos", producer.conversations);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [thread, setThread] = useState<ThreadMsg[]>([]);
  const [activeTranscript, setActiveTranscript] = useState<any>(null);
  const [activeVideo, setActiveVideo] = useState<any>(null);
  const [attachedVideos, setAttachedVideos] = useState<{ video_id: string; video_title: string | null; day_label?: string | null }[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [showProcess, setShowProcess] = useState(false);
  const [showEpisode, setShowEpisode] = useState(false);
  const [episodeInfo, setEpisodeInfo] = useState<{ transcript: boolean; tests: number; reach?: string } | null>(null);
  const { user } = useUser();
  const [model, setModelState] = useState("claude-sonnet-4-6");
  // On a fresh chat, show the user's default model (Charles = Opus, others = Sonnet).
  useEffect(() => { if (activeId === null) setModelState(defaultModelFor(user?.email)); }, [user?.email, activeId]);
  const [wireUp, setWireUp] = useState<ProducerSuggestion[] | null>(null);
  const [pendingImages, setPendingImages] = useState<{ media_type: string; data: string; name: string }[]>([]);
  const [pendingTxt, setPendingTxt] = useState<{ name: string; text: string }[]>([]);
  const [pendingDocs, setPendingDocs] = useState<{ media_type: string; data: string; name: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      const isImg = f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name);
      const isTxt = f.type.startsWith("text/") || /\.(txt|text|md|srt|vtt)$/i.test(f.name);
      if (isPdf) {
        const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
        setPendingDocs((p) => [...p, { media_type: "application/pdf", data, name: f.name }]);
      } else if (isImg) {
        const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
        const media_type = f.type || (/\.png$/i.test(f.name) ? "image/png" : "image/jpeg");
        setPendingImages((p) => [...p, { media_type, data, name: f.name }]);
      } else if (isTxt) {
        const text = await f.text();
        setPendingTxt((p) => [...p, { name: f.name, text }]);
      }
    }
  }, []);

  // Only auto-scroll if the user is already near the bottom, so a long answer
  // doesn't yank them away from what they're reading.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread, liveTools]);

  const loadConversation = useCallback(async (id: number) => {
    setActiveId(id);
    const data = await producer.get(id);
    const conv = data.conversation as any;
    setActiveTranscript(data.transcript);
    // Published episodes have a video object; pre-release ones carry only a
    // video_title (no video), so fall back to that to keep the header showing.
    const isPre = !conv?.video_id && !!conv?.video_title;
    setActiveVideo(data.video || (conv?.video_title ? { video_id: conv.video_id || "", title: conv.video_title } : null));
    setEpisodeInfo(data.transcript ? { transcript: true, tests: 0, reach: isPre ? "pre-release — transcript only" : undefined } : null);
    producer.conversationVideos(id).then((r) => setAttachedVideos(r.videos)).catch(() => setAttachedVideos([]));
    setModelState(conv?.model || "claude-sonnet-4-6");
    const byMsg: Record<number, ProducerSuggestion[]> = {};
    for (const s of data.suggestions) (byMsg[s.message_id] ||= []).push(s);
    setThread(data.messages.map((m) => ({ ...m, role: m.role, suggestions: m.role === "assistant" ? byMsg[m.id] : undefined })));
  }, []);

  // Load whichever conversation the URL points at (/ai-chat/<id>). Skips when
  // we're already on it (e.g. we just created it and are mid-stream).
  // On the bare /ai-chat URL (no id) reset to a fresh new chat, so clicking the
  // "AI Chat" nav always starts new rather than reopening a past chat.
  useEffect(() => {
    if (!urlId || Number.isNaN(urlId)) {
      if (activeId !== null) { setActiveId(null); setThread([]); setActiveVideo(null); setActiveTranscript(null); setEpisodeInfo(null); }
      return;
    }
    if (urlId === activeId) return;
    loadConversation(urlId);
  }, [urlId, activeId, loadConversation]);

  // Attach first, set the header, THEN navigate. Navigating before the attach
  // finishes reloads the still-empty conversation and wipes the header (the
  // "had to click twice" bug).
  const selectEpisode = async (v: Video) => {
    let convId = activeId, created = false;
    if (!convId) { const { id } = await producer.create({}); convId = id; setActiveId(id); created = true; }
    const r = await producer.attachEpisode(convId!, v.video_id);
    setActiveVideo(r.video || v);
    if (r.videos) setAttachedVideos(r.videos);
    const ps = r.podcast_stats;
    const reach = ps ? `${(ps.listens / 1000).toFixed(0)}k listens · ${(ps.video_views / 1000).toFixed(1)}k video views${ps.perf_index != null ? ` · ${ps.perf_index.toFixed(2)}x norm` : ""}` : undefined;
    setEpisodeInfo({ transcript: r.transcript_loaded, tests: r.tests?.length || 0, reach });
    // Keep the picker open so several episodes can be added in one go.
    if (created) router.push(`/ai-chat/${convId}`);
    await mutateConvos();
  };

  const removeVideo = async (videoId: string) => {
    if (activeId == null) return;
    const r = await producer.removeConversationVideo(activeId, videoId);
    setAttachedVideos(r.videos);
    if (!r.videos.length) { setActiveVideo(null); setEpisodeInfo(null); }
    else if (activeVideo?.video_id === videoId) {
      const next = r.videos[r.videos.length - 1];
      setActiveVideo({ video_id: next.video_id, title: next.video_title });
    }
  };

  const selectPrerelease = async (pr: { id: number; title: string }) => {
    let convId = activeId, created = false;
    if (!convId) { const { id } = await producer.create({}); convId = id; setActiveId(id); created = true; }
    const r = await producer.attachPrerelease(convId!, pr.id);
    setActiveVideo({ video_id: "", title: `${r.episode_title} (pre-release)` } as any);
    if (r.videos) setAttachedVideos(r.videos);
    setEpisodeInfo({ transcript: r.transcript_loaded, tests: 0, reach: "pre-release — transcript only" });
    // Keep the picker open so several pre-release episodes can be added at once.
    if (created) router.push(`/ai-chat/${convId}`);
    await mutateConvos();
  };

  const [chatListOpen, setChatListOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const renameChat = async (id: number) => {
    const t = renameVal.trim();
    setRenamingId(null);
    if (!t) return;
    await producer.rename(id, t);
    await mutateConvos();
  };

  const deleteChat = async (id: number) => {
    await producer.remove(id);
    const remaining = (conversations || []).filter((c) => c.id !== id);
    await mutateConvos();
    if (activeId === id) {
      if (remaining.length > 0) router.push(`/ai-chat/${remaining[0].id}`);
      else { setActiveId(null); setThread([]); router.push("/ai-chat"); }
    }
  };

  const changeModel = async (m: string) => {
    setModelState(m);
    if (activeId) { try { await producer.setModel(activeId, m); } catch {} }
  };

  const newChat = async (transcript_id?: number) => {
    const { id } = await producer.create(transcript_id ? { transcript_id } : {});
    await mutateConvos();
    setThread([]);
    setActiveVideo(null);
    setActiveTranscript(null);
    setEpisodeInfo(null);
    setActiveId(id);
    router.push(`/ai-chat/${id}`);
  };


  const send = async (text: string) => {
    if ((!text.trim() && pendingImages.length === 0 && pendingTxt.length === 0 && pendingDocs.length === 0) || streaming) return;
    let convId = activeId;
    if (!convId) {
      const { id } = await producer.create({}); convId = id; setActiveId(id); router.push(`/ai-chat/${id}`); await mutateConvos();
      if (model !== "claude-sonnet-4-6") { try { await producer.setModel(id, model); } catch {} }
    }
    const imgs = pendingImages.map(({ media_type, data }) => ({ media_type, data }));
    const docs = pendingDocs.map(({ media_type, data, name }) => ({ media_type, data, name }));
    const attach_transcript = pendingTxt.length ? pendingTxt.map((t) => `--- ${t.name} ---\n${t.text}`).join("\n\n") : undefined;
    const attachNote = [pendingTxt.length ? `${pendingTxt.length} transcript${pendingTxt.length > 1 ? "s" : ""}` : "", pendingImages.length ? `${pendingImages.length} image${pendingImages.length > 1 ? "s" : ""}` : "", pendingDocs.length ? `${pendingDocs.length} PDF${pendingDocs.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    const shown = text.trim() || (attachNote ? `Shared ${attachNote}.` : "");
    setThread((t) => [...t, { role: "user", content: shown }, { role: "assistant", content: "" }]);
    setInput("");
    setPendingImages([]); setPendingTxt([]); setPendingDocs([]);
    setStreaming(true);
    setLiveTools([]);
    streamProducer(
      convId!,
      text.trim(),
      (ev) => {
        if (ev.type === "text") {
          setThread((t) => { const c = [...t]; const last = c[c.length - 1]; if (last?.role === "assistant") last.content += ev.delta; return c; });
        } else if (ev.type === "reset") {
          // Model finished narrating and is calling tools; clear the pre-tool text.
          setThread((t) => { const c = [...t]; const last = c[c.length - 1]; if (last?.role === "assistant") last.content = ""; return c; });
        } else if (ev.type === "tools") {
          setLiveTools((prev) => [...prev, ...ev.names]);
          setThread((t) => { const c = [...t]; const last = c[c.length - 1]; if (last?.role === "assistant") last.tools = [...(last.tools || []), ...ev.names]; return c; });
        } else if (ev.type === "suggestions") {
          setThread((t) => { const c = [...t]; const last = c[c.length - 1]; if (last?.role === "assistant") last.suggestions = ev.suggestions; return c; });
        } else if (ev.type === "error") {
          setThread((t) => { const c = [...t]; const last = c[c.length - 1]; if (last?.role === "assistant") last.content += `\n\n_Error: ${ev.message}_`; return c; });
        }
      },
      () => { setStreaming(false); setLiveTools([]); mutateConvos(); },
      { images: imgs.length ? imgs : undefined, documents: docs.length ? docs : undefined, attach_transcript }
    );
  };

  return (
    <div className="flex h-full relative">
      {/* Backdrop when the chat list drawer is open on mobile */}
      {chatListOpen && <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={() => setChatListOpen(false)} />}
      {/* Conversation sidebar (static on desktop, slide-over drawer on mobile) */}
      <aside className={`fixed md:static inset-y-0 left-0 z-30 w-64 md:w-60 border-r border-border flex flex-col shrink-0 bg-sidebar md:bg-sidebar/40 transition-transform ${chatListOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>
        <div className="p-3">
          <button onClick={() => { setChatListOpen(false); newChat(); }} className="w-full px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
            New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {conversations?.map((c) => (
            <div key={c.id} className={`group relative rounded-lg transition-colors ${activeId === c.id ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"}`}>
              {renamingId === c.id ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => renameChat(c.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") renameChat(c.id); if (e.key === "Escape") setRenamingId(null); }}
                  className="w-full bg-background border border-primary rounded-lg px-2.5 py-2 text-[13px] outline-none"
                />
              ) : (
                <>
                  <Link
                    href={`/ai-chat/${c.id}`}
                    onClick={() => setChatListOpen(false)}
                    onDoubleClick={(e) => { e.preventDefault(); setRenamingId(c.id); setRenameVal(c.title); }}
                    className={`block w-full text-left pl-2.5 pr-12 py-2 text-[13px] ${activeId === c.id ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}
                  >
                    <div className="truncate">{c.title}</div>
                    {c.day_slot && <div className="text-[10px] text-muted-foreground/70">{c.day_slot} transcript</div>}
                  </Link>
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRenamingId(c.id); setRenameVal(c.title); }}
                      title="Rename chat"
                      className="size-5 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-background/50"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteChat(c.id); }}
                      title="Delete chat"
                      className="size-5 grid place-items-center rounded text-muted-foreground hover:text-neg hover:bg-background/50"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!conversations?.length && <p className="text-xs text-muted-foreground px-2 py-4 text-center">No chats yet.</p>}
        </div>
        <div className="p-3 border-t border-border">
          <button onClick={() => setShowProcess(true)} className="w-full text-left text-xs text-muted-foreground hover:text-foreground flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            Process doc
          </button>
        </div>
      </aside>

      {/* Main thread */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b border-border">
          <button onClick={() => setChatListOpen(true)} className="md:hidden -ml-1 p-1.5 text-muted-foreground hover:text-foreground" title="Chats" aria-label="Open chat list">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
          <span className="text-[11px] text-muted-foreground ml-auto">Model</span>
          <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
            {[
              { v: "claude-sonnet-4-6", label: "Sonnet", note: "fast · cheap" },
              { v: "claude-opus-4-8", label: "Opus", note: "deep" },
            ].map((m) => (
              <button
                key={m.v}
                onClick={() => changeModel(m.v)}
                title={m.note}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${model === m.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {attachedVideos.length > 1 ? (
          <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-card/60 text-xs flex-wrap">
            <span className="text-muted-foreground shrink-0">Working on {attachedVideos.length}:</span>
            {attachedVideos.map((v) => (
              <span key={v.video_id} className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-full bg-accent border border-border max-w-[260px]">
                {v.day_label && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary bg-primary/10 rounded-full px-1.5 py-0.5">{v.day_label.slice(0, 3)}</span>}
                <span className="truncate">{v.video_title || v.video_id}</span>
                <button onClick={() => removeVideo(v.video_id)} title="Remove from chat" className="shrink-0 text-muted-foreground hover:text-neg rounded-full w-4 h-4 flex items-center justify-center">×</button>
              </span>
            ))}
            <button onClick={() => setShowEpisode(true)} className="shrink-0 text-info hover:underline">+ add</button>
          </div>
        ) : activeVideo && (
          <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-card/60 text-xs">
            <span className="text-muted-foreground">Working on:</span>
            <span className="font-medium truncate">{activeVideo.title || activeVideo.video_id}</span>
            {activeVideo.view_count != null && <span className="text-muted-foreground shrink-0">{Number(activeVideo.view_count).toLocaleString()} views</span>}
            {episodeInfo?.transcript && <span className="text-brand-green shrink-0">· transcript loaded</span>}
            {episodeInfo?.reach && <span className="text-muted-foreground shrink-0">· {episodeInfo.reach}</span>}
            {episodeInfo && episodeInfo.tests > 0 && <span className="text-muted-foreground shrink-0">· {episodeInfo.tests} past test{episodeInfo.tests > 1 ? "s" : ""}</span>}
            <button onClick={() => setShowEpisode(true)} className="ml-auto shrink-0 text-info hover:underline">add / change</button>
          </div>
        )}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
            {thread.length === 0 && (
              <div className="pt-16 text-center">
                <h1 className="font-display text-3xl font-extrabold tracking-tight">Ask AI</h1>
                <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                  Knows the channel inside out. Drop in a transcript or thumbnails for titles, or ask strategy: how last week went, ideas to boost views, what to lean into.
                </p>
                {activeTranscript && <p className="text-xs text-info mt-3">Transcript attached{activeTranscript.day_slot ? ` (${activeTranscript.day_slot})` : ""}.</p>}
                <div className="mt-6 flex justify-center">
                  <button onClick={() => setShowEpisode(true)} className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m10 15 5-3-5-3z"/><path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/></svg>
                    Select an episode to work on
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-3">It pulls the full transcript and any past tests, then you ask what you want.</p>
                <div className="mt-5 flex flex-wrap gap-2 justify-center">
                  {["How did the last week go?", "What should we lean into next?", "Ideas to boost views through packaging"].map((q) => (
                    <button key={q} onClick={() => send(q)} className="px-3 py-1.5 text-xs border border-border rounded-full hover:bg-accent text-muted-foreground hover:text-foreground">{q}</button>
                  ))}
                </div>
              </div>
            )}
            {thread.map((m, i) => {
              const isStreamingThis = streaming && i === thread.length - 1 && m.role === "assistant";
              const tools = m.tools ? Array.from(new Set(m.tools)) : [];
              return (
                <div key={i} className={`animate-in fade-in slide-in-from-bottom-1 duration-300 ${m.role === "user" ? "flex justify-end" : ""}`}>
                  {m.role === "user" ? (
                    <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 bg-primary text-primary-foreground text-sm whitespace-pre-wrap">{m.content}</div>
                  ) : (
                    <div className="w-full">
                      {tools.length > 0 && (m.content || !isStreamingThis) && (
                        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-green"><path d="M20 6 9 17l-5-5" /></svg>
                            Looked at {tools.length} source{tools.length > 1 ? "s" : ""}
                          </span>
                          <span className="text-muted-foreground/60 truncate">{tools.map(toolLabel).join(" · ")}</span>
                        </div>
                      )}
                      {m.content ? (
                        <div className="rounded-2xl rounded-tl-md bg-card border border-border px-4 py-3">
                          <div className="text-sm text-foreground/90">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.content}</ReactMarkdown>
                            {isStreamingThis && <span className="inline-block w-1.5 h-4 -mb-0.5 ml-0.5 bg-foreground/60 animate-pulse" />}
                          </div>
                        </div>
                      ) : isStreamingThis ? (
                        <div className="rounded-2xl rounded-tl-md bg-card border border-border px-4 py-3 inline-block">
                          <ThinkingDots label={tools.length ? toolLabel(tools[tools.length - 1]) : undefined} />
                        </div>
                      ) : null}
                      {m.suggestions && m.suggestions.length > 0 && (
                        <SuggestionSection suggestions={m.suggestions} onWireUp={(items) => setWireUp(items)} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-border p-4">
          <div
            className={`max-w-3xl mx-auto rounded-xl border transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-border bg-background"}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
          >
            {(pendingTxt.length > 0 || pendingImages.length > 0 || pendingDocs.length > 0) && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                {pendingDocs.map((d, i) => (
                  <span key={"d" + i} className="inline-flex items-center gap-1 text-[11px] bg-muted rounded-full pl-2 pr-1 py-0.5">
                    📕 {d.name}
                    <button onClick={() => setPendingDocs((p) => p.filter((_, j) => j !== i))} className="hover:text-neg">×</button>
                  </span>
                ))}
                {pendingTxt.map((t, i) => (
                  <span key={"t" + i} className="inline-flex items-center gap-1 text-[11px] bg-muted rounded-full pl-2 pr-1 py-0.5">
                    📄 {t.name}
                    <button onClick={() => setPendingTxt((p) => p.filter((_, j) => j !== i))} className="hover:text-neg">×</button>
                  </span>
                ))}
                {pendingImages.map((im, i) => (
                  <span key={"i" + i} className="inline-flex items-center gap-1 text-[11px] bg-muted rounded-full pl-1 pr-1 py-0.5">
                    <img src={`data:${im.media_type};base64,${im.data}`} alt="" className="w-5 h-5 object-cover rounded" />
                    <button onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))} className="hover:text-neg">×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-end p-2">
              <button onClick={() => fileRef.current?.click()} title="Attach transcripts or thumbnails" className="p-2 text-muted-foreground hover:text-foreground shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              <input ref={fileRef} type="file" multiple accept=".txt,.text,.md,.srt,.vtt,image/png,image/jpeg,image/webp,application/pdf,.pdf" className="hidden" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
                placeholder="Ask for titles, or how the channel is doing…"
                rows={1}
                className="flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none max-h-40"
              />
              <button onClick={() => send(input)} disabled={streaming || (!input.trim() && !pendingTxt.length && !pendingImages.length && !pendingDocs.length)} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-primary/90 shrink-0">
                {streaming ? "…" : "Send"}
              </button>
            </div>
          </div>
          <p className="max-w-3xl mx-auto text-[11px] text-muted-foreground mt-1.5 px-1">Drag in .txt transcripts (multiple ok) or .png/.jpg thumbnails for it to read.</p>
        </div>
      </main>

      {showProcess && <ProcessDocModal onClose={() => setShowProcess(false)} />}
      {showEpisode && <EpisodePickerModal onClose={() => setShowEpisode(false)} onPick={selectEpisode} onPickPrerelease={selectPrerelease} />}
      {wireUp && (
        <WireUpModal
          suggestions={wireUp}
          convId={activeId}
          presetVideo={activeVideo}
          onClose={() => setWireUp(null)}
          onVideoChosen={(v) => setActiveVideo(v)}
        />
      )}
    </div>
  );
}

/** Guided in-chat flow: pick a video, tick/edit the titles, start the test. */
function WireUpModal({ suggestions, convId, presetVideo, onClose, onVideoChosen }: {
  suggestions: ProducerSuggestion[]; convId: number | null; presetVideo: any;
  onClose: () => void; onVideoChosen: (v: any) => void;
}) {
  const [video, setVideo] = useState<any>(presetVideo || null);
  const [q, setQ] = useState("");
  const { data: results } = useSWR(video ? null : ["wireup-videos", q], () => videosApi.list(q || undefined, undefined, 20));
  // Editable title rows, pre-ticked.
  const [rows, setRows] = useState(suggestions.map((s) => ({ title: s.title, on: true })));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ test_id: number; started: boolean } | null>(null);
  const chosen = rows.filter((r) => r.on && r.title.trim()).map((r) => r.title.trim());

  const go = async (start: boolean) => {
    if (!convId || chosen.length < 1 || !video) return;
    setBusy(true);
    try {
      const r = await producer.createTest(convId, { titles: chosen, video_id: video.video_id, video_title: video.title, start });
      setResult({ test_id: r.test_id, started: r.started });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] flex flex-col bg-card border border-border rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">{suggestions[0]?.slot ? `Wire up ${suggestions[0].slot}'s A/B test` : "Wire up an A/B test"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">Close</button>
        </div>

        {result ? (
          <div className="py-6 text-center space-y-2">
            <p className="text-sm">{result.started ? "Test created and started." : "Test created as a draft."}</p>
            <Link href={`/tests/${result.test_id}`} className="inline-block text-info hover:underline text-sm">Open test #{result.test_id}</Link>
            <p className="text-xs text-muted-foreground">{result.started ? "It will rotate the titles hourly and pick the CTR winner." : "Open it to add a thumbnail or start it."}</p>
          </div>
        ) : !video ? (
          <>
            <p className="text-xs text-muted-foreground mb-2">Which video are these titles for?</p>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recent videos…" className="px-3 py-2 bg-background border border-border rounded-lg text-sm outline-none focus:border-primary mb-2" />
            <div className="flex-1 overflow-y-auto -mx-1">
              {results?.map((v) => (
                <button key={v.video_id} onClick={() => { setVideo(v); onVideoChosen(v); }} className="w-full text-left flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent">
                  {v.thumbnail_url && <img src={v.thumbnail_url} alt="" className="w-16 h-9 object-cover rounded shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{v.title}</div>
                    <div className="text-[11px] text-muted-foreground">{v.view_count?.toLocaleString()} views · {v.category} · {v.publish_date}</div>
                  </div>
                </button>
              ))}
              {results && results.length === 0 && <p className="text-xs text-muted-foreground px-2 py-3">No videos found.</p>}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs mb-3 pb-3 border-b border-border">
              <span className="text-muted-foreground">Video:</span>
              <span className="font-medium truncate flex-1">{video.title || video.video_id}</span>
              <button onClick={() => setVideo(null)} className="text-info hover:underline shrink-0">change</button>
            </div>
            <p className="text-xs text-muted-foreground mb-2">Tick the new titles to test. Your current title is added automatically as the control (variant A). Edit any if you want.</p>
            <div className="flex-1 overflow-y-auto space-y-1.5">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={r.on} onChange={() => setRows((rs) => rs.map((x, j) => j === i ? { ...x, on: !x.on } : x))} className="shrink-0 accent-[color:var(--primary)]" />
                  <input value={r.title} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} className="flex-1 px-2.5 py-1.5 bg-background border border-border rounded-lg text-sm outline-none focus:border-primary" />
                </div>
              ))}
              <button onClick={() => setRows((rs) => [...rs, { title: "", on: true }])} className="text-[11px] text-info hover:underline">+ add another title</button>
            </div>
            <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-border">
              <span className="text-xs text-muted-foreground">{chosen.length} new + current title as control</span>
              <div className="flex gap-2">
                <button onClick={() => go(false)} disabled={chosen.length < 1 || busy} className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg disabled:opacity-50 hover:bg-accent">Save as draft</button>
                <button onClick={() => go(true)} disabled={chosen.length < 1 || busy} className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{busy ? "Starting…" : "Start now"}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const THINKING_PHRASES = ["Thinking", "Working it out", "Digging through the data", "Reading the numbers", "Checking what's worked"];

// Groups suggestions by day/slot (Monday, Tuesday, ...) with a divider and its
// own "wire up" button, so a whole-week batch is worked one day at a time.
function SuggestionSection({ suggestions, onWireUp }: { suggestions: ProducerSuggestion[]; onWireUp: (items: ProducerSuggestion[]) => void }) {
  const groups: { slot: string | null; items: ProducerSuggestion[] }[] = [];
  for (const s of suggestions) {
    const last = groups[groups.length - 1];
    if (last && last.slot === (s.slot ?? null)) last.items.push(s);
    else groups.push({ slot: s.slot ?? null, items: [s] });
  }
  const multiDay = groups.filter((g) => g.slot).length > 1;

  return (
    <div className="mt-3 space-y-4">
      {groups.map((g, gi) => (
        <div key={gi} className="space-y-1.5">
          {multiDay && g.slot && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{g.slot}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {g.items.map((s) => <SuggestionCard key={s.id} s={s} />)}
          <button onClick={() => onWireUp(g.items)} className="mt-0.5 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5v14"/></svg>
            Wire up {g.slot ? `${g.slot}'s` : "these"} as an A/B test
          </button>
        </div>
      ))}
    </div>
  );
}

function ThinkingDots({ label }: { label?: string }) {
  // If no explicit activity label, cycle a friendly phrase so it feels alive.
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (label) return;
    const iv = setInterval(() => setIdx((i) => (i + 1) % THINKING_PHRASES.length), 2200);
    return () => clearInterval(iv);
  }, [label]);
  const text = label || THINKING_PHRASES[idx];
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground" aria-label={text}>
      <span className="capitalize">{text}</span>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s`, animationDuration: "1s" }} />
        ))}
      </span>
    </div>
  );
}

function SuggestionCard({ s, selectable, selected, onToggle }: { s: ProducerSuggestion; selectable?: boolean; selected?: boolean; onToggle?: () => void }) {
  const [fb, setFb] = useState(s.feedback);
  const set = async (v: 1 | -1) => { const nv = fb === v ? 0 : v; setFb(nv); await producer.feedback(s.id, nv); };
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${selected ? "border-primary bg-primary/5" : fb === 1 ? "border-brand-green/50 bg-brand-green/10" : fb === -1 ? "border-brand-red/40 bg-brand-red/5 opacity-60" : "border-border bg-card"}`}>
      {selectable && (
        <input type="checkbox" checked={!!selected} onChange={onToggle} className="mt-1 shrink-0 accent-[color:var(--primary)]" aria-label="Select for A/B test" />
      )}
      <div className="flex-1 min-w-0">
        <button className="text-sm font-semibold text-left hover:text-primary" title="Copy" onClick={() => navigator.clipboard.writeText(s.title)}>{s.title}</button>
        {s.rationale && <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{s.rationale}</div>}
      </div>
      <div className="flex gap-1 shrink-0">
        <button onClick={() => set(1)} className={`size-7 rounded-md grid place-items-center text-sm ${fb === 1 ? "bg-brand-green text-white" : "hover:bg-accent text-muted-foreground"}`} title="More like this">+</button>
        <button onClick={() => set(-1)} className={`size-7 rounded-md grid place-items-center text-sm ${fb === -1 ? "bg-brand-red text-white" : "hover:bg-accent text-muted-foreground"}`} title="Not this">−</button>
      </div>
    </div>
  );
}

function EpisodePickerModal({ onClose, onPick, onPickPrerelease }: { onClose: () => void; onPick: (v: Video) => Promise<void>; onPickPrerelease: (pr: { id: number; title: string }) => Promise<void> }) {
  const [tab, setTab] = useState<"published" | "prerelease">("published");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const { data: results } = useSWR(tab === "published" ? ["episode-videos", q] : null, () => videosApi.list(q || undefined, undefined, 25));
  const { data: prereleases, isLoading: prLoading } = useSWR(tab === "prerelease" ? "producer-prerelease" : null, () => producer.prerelease());
  const pick = async (v: Video) => { setLoading(v.video_id); try { await onPick(v); } finally { setLoading(null); } };
  const pickPr = async (pr: { id: number; title: string }) => { setLoading("pr-" + pr.id); try { await onPickPrerelease(pr); } finally { setLoading(null); } };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[80vh] flex flex-col bg-card border border-border rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Select an episode</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">Close</button>
        </div>
        <div className="flex gap-1 mb-3 bg-muted rounded-lg p-0.5">
          <button onClick={() => setTab("published")} className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === "published" ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>Published</button>
          <button onClick={() => setTab("prerelease")} className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === "prerelease" ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>Pre-release</button>
        </div>
        {tab === "published" ? (
          <>
            <p className="text-xs text-muted-foreground mb-2">Pulls the full published transcript and any past thumbnail or title tests for that episode.</p>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search episodes…" className="px-3 py-2 bg-background border border-border rounded-lg text-sm outline-none focus:border-primary mb-2" />
            <div className="flex-1 overflow-y-auto -mx-1">
              {results?.map((v) => (
                <button key={v.video_id} disabled={!!loading} onClick={() => pick(v)} className="w-full text-left flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent disabled:opacity-50">
                  {v.thumbnail_url && <img src={v.thumbnail_url} alt="" className="w-16 h-9 object-cover rounded shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{v.title}</div>
                    <div className="text-[11px] text-muted-foreground">{v.view_count?.toLocaleString()} views · {v.category} · {v.publish_date}</div>
                  </div>
                  {loading === v.video_id && <span className="text-[11px] text-muted-foreground shrink-0">loading…</span>}
                </button>
              ))}
              {results && results.length === 0 && <p className="text-xs text-muted-foreground px-2 py-3">No episodes found.</p>}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">Pulls the pre-release transcript from TARPGPT. No video or past tests yet, so the chat works off the transcript only.</p>
            <div className="flex-1 overflow-y-auto -mx-1">
              {prereleases?.map((pr) => (
                <button key={pr.id} disabled={!!loading} onClick={() => pickPr(pr)} className="w-full text-left flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-accent disabled:opacity-50">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-primary/15 text-primary shrink-0">PRE</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{pr.title}</div>
                    <div className="text-[11px] text-muted-foreground">{pr.date}</div>
                  </div>
                  {loading === "pr-" + pr.id && <span className="text-[11px] text-muted-foreground shrink-0">loading…</span>}
                </button>
              ))}
              {prLoading && <p className="text-xs text-muted-foreground px-2 py-3">Loading pre-release episodes…</p>}
              {prereleases && prereleases.length === 0 && <p className="text-xs text-muted-foreground px-2 py-3">No pre-release episodes ready.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ProcessDocModal({ onClose }: { onClose: () => void }) {
  const { data } = useSWR("process-doc", producer.processDoc);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setContent(data.content); }, [data]);
  const save = async () => { await producer.saveProcessDoc(content); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-card border border-border rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold">Process doc</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">Close</button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">The Producer&apos;s working rules. Edit here and every future chat uses it immediately.</p>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} className="flex-1 min-h-[50vh] resize-none px-3 py-2 bg-background border border-border rounded-lg text-xs font-mono outline-none focus:border-primary" />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={save} className="px-4 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium">{saved ? "Saved" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

