"use client";

import { useState } from "react";
import useSWR from "swr";
import { comments as commentsApi } from "@/lib/api";

const OUR_CHANNEL_ID = "UCkhy7g4GvHuzhbzTVjc8izQ";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<a[^>]*>([^<]*)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function renderCommentContent(html: string, videoId: string) {
  let text = html
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  const timestamps: { ph: string; secs: number; display: string }[] = [];
  let idx = 0;
  text = text.replace(/<a[^>]*href="[^"]*[?&]t=(\d+)[^"]*"[^>]*>(\d+:\d+(?::\d+)?)<\/a>/gi, (_m, s, d) => {
    const ph = `__TS${idx++}__`;
    timestamps.push({ ph, secs: parseInt(s), display: d });
    return ph;
  });

  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/  +/g, ' ').trim();

  const parts: (string | { secs: number; display: string })[] = [];
  let rem = text;
  for (const ts of timestamps) {
    const i = rem.indexOf(ts.ph);
    if (i >= 0) {
      if (i > 0) parts.push(rem.slice(0, i));
      parts.push({ secs: ts.secs, display: ts.display });
      rem = rem.slice(i + ts.ph.length);
    }
  }
  if (rem) parts.push(rem);

  // Also detect bare timestamps
  const finalParts: (string | { secs: number; display: string })[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') { finalParts.push(p); continue; }
    const segs = p.split(/(\d{1,2}:\d{2}(?::\d{2})?)/g);
    for (const seg of segs) {
      const m = seg.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (m) {
        finalParts.push({ secs: parseInt(m[1]) * 60 + parseInt(m[2]) + (m[3] ? parseInt(m[3]) * 3600 : 0), display: seg });
      } else {
        finalParts.push(seg);
      }
    }
  }

  return (
    <>
      {finalParts.map((p, i) =>
        typeof p === 'string' ? <span key={i}>{p}</span> : (
          <a key={i} href={`https://www.youtube.com/watch?v=${videoId}&t=${p.secs}`} target="_blank" rel="noopener noreferrer"
            className="text-primary hover:underline font-medium">{p.display}</a>
        )
      )}
    </>
  );
}

export default function ListeningPage() {
  const [tab, setTab] = useState<"feed" | "mentions">("feed");
  const [sentiment, setSentiment] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const { data: commentList } = useSWR(
    `comments-${tab}-${sentiment}-${search}-${page}`,
    () => {
      if (tab === "mentions") return commentsApi.mentions();
      const params: Record<string, string> = {
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        channel_id: OUR_CHANNEL_ID,
      };
      if (sentiment) params.sentiment = sentiment;
      if (search) params.search = search;
      return commentsApi.list(params);
    },
    { refreshInterval: 60000 },
  );

  const { data: stats } = useSWR("comment-stats", commentsApi.stats);

  const [scraping, setScraping] = useState(false);
  const handleScrape = async () => {
    setScraping(true);
    try { await commentsApi.scrape(); } catch {}
    setScraping(false);
  };

  const handleTabChange = (t: typeof tab) => {
    setTab(t);
    setPage(0);
    setSentiment("");
    setSearch("");
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Comments</h1>
        <button onClick={handleScrape} disabled={scraping}
          className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors disabled:opacity-50">
          {scraping ? "Scraping..." : "Scrape Now"}
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-xl p-3">
            <p className="text-xl font-bold">{stats.total.toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">Total Comments</p>
          </div>
          {stats.by_sentiment?.map((s: any) => (
            <div key={s.sentiment} className="bg-card border border-border rounded-xl p-3">
              <p className={`text-xl font-bold ${s.sentiment === 'positive' ? 'text-pos' : s.sentiment === 'negative' ? 'text-neg' : 'text-muted-foreground'}`}>
                {s.count.toLocaleString()}
              </p>
              <p className="text-[11px] text-muted-foreground capitalize">{s.sentiment}</p>
            </div>
          ))}
          <div className="bg-card border border-border rounded-xl p-3">
            <p className="text-xl font-bold text-primary">{stats.recent_mentions}</p>
            <p className="text-[11px] text-muted-foreground">Mentions (7d)</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 items-center flex-wrap">
        {([
          { id: "feed" as const, label: "Comments" },
          { id: "mentions" as const, label: "Mentions" },
        ]).map((t) => (
          <button key={t.id} onClick={() => handleTabChange(t.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}>
            {t.label}
          </button>
        ))}

        {/* Sentiment filter */}
        {tab !== "mentions" && (
          <div className="ml-3 flex gap-1">
            {["", "positive", "negative", "neutral"].map((s) => (
              <button key={s} onClick={() => { setSentiment(s); setPage(0); }}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                  sentiment === s ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"
                }`}>
                {s || "All"}
              </button>
            ))}
          </div>
        )}

        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          placeholder="Search..."
          className="ml-auto h-7 w-40 rounded-md border border-input bg-transparent px-2 text-xs placeholder:text-muted-foreground"
        />
      </div>

      {/* Comment list */}
      <div className="space-y-1">
        {commentList?.map((c: any) => (
          <div key={c.id} className="bg-card border border-border rounded-lg px-3 py-2 flex items-start gap-3">
            <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
              c.sentiment === 'positive' ? 'bg-green-400' : c.sentiment === 'negative' ? 'bg-red-400' : 'bg-muted-foreground/40'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {c.author_channel_url ? (
                  <a href={c.author_channel_url} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:text-primary transition-colors">
                    {c.author}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{c.author}</span>
                )}
                {c.mentions_us ? <span className="text-primary text-[10px] font-medium">mention</span> : null}
                <span>{c.published_at ? new Date(c.published_at).toLocaleDateString() : ""}</span>
                {c.like_count > 0 && <span>{c.like_count} likes</span>}
              </div>
              <p className="text-xs mt-0.5 text-foreground/80 line-clamp-3">
                {renderCommentContent(c.content, c.video_id)}
              </p>
            </div>
            {c.video_title && (
              <a href={`https://www.youtube.com/watch?v=${c.video_id}`} target="_blank" rel="noopener noreferrer"
                className="shrink-0 group text-right" title={c.video_title}>
                <p className="text-[9px] text-muted-foreground mb-0.5 line-clamp-2 w-24 group-hover:text-primary transition-colors">{c.video_title}</p>
                {c.video_thumbnail && (
                  <img src={c.video_thumbnail} alt="" className="w-24 h-14 object-cover rounded border border-border group-hover:border-primary/40 transition-colors" />
                )}
              </a>
            )}
          </div>
        ))}
        {(!commentList || commentList.length === 0) && (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
            {tab === "mentions" ? "No mentions found yet." : "No comments found. Click 'Scrape Now' to fetch."}
          </div>
        )}
        {commentList && commentList.length > 0 && (
          <div className="flex items-center justify-center gap-3 pt-3">
            {page > 0 && (
              <button onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent">Previous</button>
            )}
            <span className="text-xs text-muted-foreground">Page {page + 1}</span>
            {commentList.length >= PAGE_SIZE && (
              <button onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent">Next</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
