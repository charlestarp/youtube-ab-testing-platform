/**
 * Competitor growth analysis — computes per-competitor findings from existing
 * DB data (no API calls) and writes them to competitor_growth_findings for the
 * dashboard "What Grew Them" card. Run weekly.
 */
import { getDb } from '../db/client.js';
import { ruleTags } from './title-tagger.js';

export function ensureGrowthSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS competitor_growth_findings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id   INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
      competitor_name TEXT NOT NULL,
      finding_type    TEXT NOT NULL,
      headline        TEXT NOT NULL,
      detail          TEXT,
      evidence_json   TEXT,
      uplift          REAL NOT NULL DEFAULT 0,
      computed_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cgf_uplift ON competitor_growth_findings(uplift DESC);
    CREATE INDEX IF NOT EXISTS idx_cgf_comp   ON competitor_growth_findings(competitor_id);
  `);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function upliftLabel(u: number): string {
  if (u >= 2) return `${u.toFixed(1)}x more views`;
  if (u >= 1.25) return `${Math.round((u - 1) * 100)}% more views`;
  if (u <= 0.8) return `${Math.round((1 - u) * 100)}% fewer views`;
  return 'similar views';
}

interface Finding {
  competitor_id: number;
  competitor_name: string;
  finding_type: string;
  headline: string;
  detail: string | null;
  evidence_json: string;
  uplift: number;
}

export async function computeCompetitorGrowth(): Promise<void> {
  const db = getDb();
  ensureGrowthSchema();

  const competitors = db.prepare(
    `SELECT id, name FROM competitors WHERE last_synced_at IS NOT NULL`
  ).all() as any[];

  db.prepare('DELETE FROM competitor_growth_findings').run();

  const insert = db.prepare(`
    INSERT INTO competitor_growth_findings
      (competitor_id, competitor_name, finding_type, headline, detail, evidence_json, uplift)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const findings: Finding[] = [];

  for (const comp of competitors) {
    const videos = db.prepare(`
      SELECT title, views, duration_seconds, published_at
      FROM competitor_videos
      WHERE competitor_id = ? AND duration_seconds > 180 AND views > 0
    `).all(comp.id) as any[];

    if (videos.length < 6) continue;

    // ── 1. Title patterns ─────────────────────────────────────────────────
    const titlePatterns = [
      { name: 'question',          label: 'Question titles' },
      { name: 'exclamation',       label: 'Exclamation titles' },
      { name: 'colon setup',       label: 'Colon-setup titles' },
      { name: 'has number',        label: 'Titles with numbers' },
      { name: 'all caps word',     label: 'ALL CAPS word titles' },
      { name: 'second person',     label: 'Second-person titles' },
      { name: 'negative framing',  label: 'Negative-framing titles' },
      { name: 'long title',        label: 'Long titles (9+ words)' },
      { name: 'short title',       label: 'Short titles (≤4 words)' },
    ];

    for (const pat of titlePatterns) {
      const tagged = ruleTags.bind(null);
      const withPat  = videos.filter((v: any) => tagged(v.title).includes(pat.name));
      const without  = videos.filter((v: any) => !tagged(v.title).includes(pat.name));
      if (withPat.length < 3 || without.length < 3) continue;

      const medWith    = median(withPat.map((v: any) => v.views as number));
      const medWithout = median(without.map((v: any) => v.views as number));
      const uplift     = medWithout > 0 ? medWith / medWithout : 1;
      if (uplift >= 0.8 && uplift < 1.25) continue;

      const dir = uplift >= 1.25 ? 'outperform' : 'underperform';
      // Concrete examples: their top-viewed titles that actually use this pattern,
      // so it's obvious what it means and what to write for our own channel.
      const examples = [...withPat]
        .sort((a: any, b: any) => (b.views as number) - (a.views as number))
        .slice(0, 3)
        .map((v: any) => ({ title: v.title as string, views_k: Math.round((v.views as number) / 1000) }));
      findings.push({
        competitor_id: comp.id, competitor_name: comp.name,
        finding_type: 'title_pattern',
        headline: `${comp.name}: ${pat.label} ${dir} other titles — ${upliftLabel(uplift)}`,
        detail: `${withPat.length} videos with this pattern (median ${Math.round(medWith / 1000)}k views) vs ${without.length} without (${Math.round(medWithout / 1000)}k).`,
        evidence_json: JSON.stringify({ pattern: pat.name, with_count: withPat.length, without_count: without.length, median_with: Math.round(medWith), median_without: Math.round(medWithout), examples }),
        uplift,
      });
    }

    // ── 2. Video length bins ───────────────────────────────────────────────
    const bins = [
      { label: 'short videos (<20 min)',    test: (s: number) => s < 1200 },
      { label: 'medium videos (20–60 min)', test: (s: number) => s >= 1200 && s < 3600 },
      { label: 'long videos (60+ min)',     test: (s: number) => s >= 3600 },
    ];
    const binGroups = bins
      .map(b => ({ ...b, vids: videos.filter((v: any) => b.test(v.duration_seconds as number)) }))
      .filter(b => b.vids.length >= 3);

    if (binGroups.length >= 2) {
      const best = binGroups.reduce((a, b) =>
        median(b.vids.map((v: any) => v.views as number)) > median(a.vids.map((v: any) => v.views as number)) ? b : a
      );
      const medBest  = median(best.vids.map((v: any) => v.views as number));
      const restVids = binGroups.filter(b => b.label !== best.label).flatMap(b => b.vids.map((v: any) => v.views as number));
      if (restVids.length > 0) {
        const medRest = median(restVids);
        const uplift  = medRest > 0 ? medBest / medRest : 1;
        if (uplift >= 1.25) {
          findings.push({
            competitor_id: comp.id, competitor_name: comp.name,
            finding_type: 'video_length',
            headline: `${comp.name}: ${best.label} perform ${upliftLabel(uplift)} than other formats`,
            detail: `${best.vids.length} ${best.label}: median ${Math.round(medBest / 1000)}k views vs ${Math.round(medRest / 1000)}k for other lengths.`,
            evidence_json: JSON.stringify({ bin: best.label, median_best: Math.round(medBest), median_others: Math.round(medRest), count: best.vids.length, examples: [...best.vids].sort((a: any, b: any) => (b.views as number) - (a.views as number)).slice(0, 3).map((v: any) => ({ title: v.title as string, views_k: Math.round((v.views as number) / 1000) })) }),
            uplift,
          });
        }
      }
    }

    // ── 3. Upload cadence trend (recent 90d vs prior 90d) ─────────────────
    const cut90  = new Date(Date.now() - 90  * 86400000).toISOString().split('T')[0];
    const cut180 = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
    const recent = videos.filter((v: any) => (v.published_at as string) >= cut90);
    const older  = videos.filter((v: any) => (v.published_at as string) >= cut180 && (v.published_at as string) < cut90);

    if (recent.length >= 4 && older.length >= 4) {
      const avgRecent = recent.reduce((s: number, v: any) => s + (v.views as number), 0) / recent.length;
      const avgOlder  = older.reduce((s: number, v: any)  => s + (v.views as number), 0) / older.length;
      const uplift    = avgOlder > 0 ? avgRecent / avgOlder : 1;
      if (uplift >= 1.3 || uplift <= 0.7) {
        const dir = uplift >= 1.3 ? 'growing' : 'declining';
        findings.push({
          competitor_id: comp.id, competitor_name: comp.name,
          finding_type: 'cadence',
          headline: `${comp.name} is ${dir}: recent videos average ${Math.round(avgRecent / 1000)}k views vs ${Math.round(avgOlder / 1000)}k prior`,
          detail: `Last 90 days: ${recent.length} videos at avg ${Math.round(avgRecent / 1000)}k. Prior 90 days: ${older.length} videos at avg ${Math.round(avgOlder / 1000)}k.`,
          evidence_json: JSON.stringify({ recent_count: recent.length, older_count: older.length, avg_recent: Math.round(avgRecent), avg_older: Math.round(avgOlder) }),
          uplift,
        });
      }
    }

    // ── 4. Thumbnail styles (from competitor_thumbnail_analysis) ──────────
    const analyses = db.prepare(`
      SELECT cta.layout, cta.background_type, cta.expression, cta.has_text, cv.views
      FROM competitor_thumbnail_analysis cta
      JOIN competitor_videos cv ON cv.video_id = cta.video_id
      WHERE cv.competitor_id = ? AND cv.views > 0
    `).all(comp.id) as any[];

    if (analyses.length >= 6) {
      for (const sg of [
        { attr: 'layout',          getVal: (a: any) => a.layout },
        { attr: 'background_type', getVal: (a: any) => a.background_type },
        { attr: 'expression',      getVal: (a: any) => a.expression },
      ]) {
        const byVal = new Map<string, number[]>();
        for (const a of analyses) {
          const val: string | null | undefined = sg.getVal(a);
          if (!val) continue;
          if (!byVal.has(val)) byVal.set(val, []);
          byVal.get(val)!.push(a.views as number);
        }
        const qualified = [...byVal.entries()].filter(([, vs]) => vs.length >= 3);
        if (qualified.length < 2) continue;

        qualified.sort((a, b) => median(b[1]) - median(a[1]));
        const [bestVal, bestViews] = qualified[0];
        const restViews = qualified.slice(1).flatMap(([, vs]) => vs);
        const medBest = median(bestViews);
        const medRest = median(restViews);
        const uplift  = medRest > 0 ? medBest / medRest : 1;
        if (uplift < 1.25) continue;

        findings.push({
          competitor_id: comp.id, competitor_name: comp.name,
          finding_type: 'thumbnail_style',
          headline: `${comp.name}: "${bestVal}" ${sg.attr.replace('_', ' ')} thumbnails — ${upliftLabel(uplift)}`,
          detail: `${bestViews.length} thumbnails with this style: median ${Math.round(medBest / 1000)}k views vs ${Math.round(medRest / 1000)}k for others.`,
          evidence_json: JSON.stringify({ attribute: sg.attr, value: bestVal, median_best: Math.round(medBest), median_others: Math.round(medRest), count: bestViews.length }),
          uplift,
        });
      }
    }
  }

  findings.sort((a, b) => b.uplift - a.uplift);

  db.transaction((rows: Finding[]) => {
    for (const f of rows) {
      insert.run(f.competitor_id, f.competitor_name, f.finding_type, f.headline, f.detail, f.evidence_json, f.uplift);
    }
  })(findings);

  console.log(`[competitor-growth] ${findings.length} findings written across ${competitors.length} competitors`);
}
