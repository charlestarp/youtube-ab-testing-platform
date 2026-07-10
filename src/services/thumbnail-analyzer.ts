/**
 * Thumbnail Emotion Mapping — uses Claude Vision to analyze thumbnails
 * and correlate attributes with performance (views, CTR).
 * Works for both our channel and competitor channels.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

const ANALYSIS_PROMPT = `Analyze this YouTube thumbnail image. Return ONLY a JSON object with these exact fields (no markdown, no explanation):

{
  "expression": "shocked|laughing|neutral|scared|angry|confused|excited|smiling|crying|disgusted",
  "mouth_open": true/false,
  "eyebrows_raised": true/false,
  "face_count": number (0 if no faces),
  "face_size": "large|medium|small|none" (how much of the frame the main face takes up),
  "faces": [{"position": "left|right|center", "gender": "male|female|unknown", "expression": "shocked|laughing|neutral|scared|angry|confused|excited|smiling|crying|disgusted", "mouth_open": true/false}],
  "primary_color": "red|blue|green|yellow|purple|orange|pink|white|black|brown|teal",
  "secondary_color": "red|blue|green|yellow|purple|orange|pink|white|black|brown|teal",
  "brightness": "bright|dark|medium",
  "contrast": "high|medium|low",
  "has_text": true/false,
  "text_content": "the text shown on the thumbnail" or "" if none,
  "text_color": "white|yellow|red|black|blue|green|pink|orange" or "" if no text,
  "text_size": "large|medium|small|none",
  "all_caps_text": true/false,
  "layout": "face-left|face-right|centered|split|collage",
  "background_type": "photo|solid|gradient|collage|blurred",
  "has_border": true/false,
  "has_emoji": true/false
}`;

/**
 * Call Claude Vision on a thumbnail image and return the parsed analysis.
 */
async function visionAnalyze(thumbnailUrl: string): Promise<any> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const imgRes = await fetch(thumbnailUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch thumbnail: ${imgRes.status}`);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  const base64 = imgBuffer.toString('base64');
  const mediaType = thumbnailUrl.includes('.webp') ? 'image/webp' : thumbnailUrl.includes('.png') ? 'image/png' : 'image/jpeg';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType as any, data: base64 } },
        { type: 'text', text: ANALYSIS_PROMPT },
      ],
    }],
  });

  try { logAiUsage({ app: 'yt-testing', feature: 'thumbnail-analyzer', user: 'unknown', model: 'claude-sonnet-4-6', usage: response.usage }); } catch {}

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Analyze a single thumbnail using Claude Vision (our channel).
 */
export async function analyzeThumbnail(videoId: string, thumbnailUrl: string, title: string, views: number, ctr: number): Promise<any> {
  try {
    const analysis = await visionAnalyze(thumbnailUrl);
    const db = getDb();
    db.prepare(`
      INSERT INTO thumbnail_analysis (
        video_id, title, thumbnail_url, views, ctr,
        expression, mouth_open, eyebrows_raised,
        face_count, face_size,
        primary_color, secondary_color, brightness, contrast,
        has_text, text_content, text_color, text_size, all_caps_text,
        layout, background_type, has_border, has_emoji,
        analysis_json, faces_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        views = excluded.views, ctr = excluded.ctr,
        expression = excluded.expression, mouth_open = excluded.mouth_open,
        eyebrows_raised = excluded.eyebrows_raised, face_count = excluded.face_count,
        face_size = excluded.face_size, primary_color = excluded.primary_color,
        secondary_color = excluded.secondary_color, brightness = excluded.brightness,
        contrast = excluded.contrast, has_text = excluded.has_text,
        text_content = excluded.text_content, text_color = excluded.text_color,
        text_size = excluded.text_size, all_caps_text = excluded.all_caps_text,
        layout = excluded.layout, background_type = excluded.background_type,
        has_border = excluded.has_border, has_emoji = excluded.has_emoji,
        analysis_json = excluded.analysis_json, faces_json = excluded.faces_json,
        analyzed_at = datetime('now')
    `).run(
      videoId, title, thumbnailUrl, views, ctr,
      analysis.expression, analysis.mouth_open ? 1 : 0, analysis.eyebrows_raised ? 1 : 0,
      analysis.face_count || 0, analysis.face_size || 'none',
      analysis.primary_color, analysis.secondary_color, analysis.brightness, analysis.contrast,
      analysis.has_text ? 1 : 0, analysis.text_content || '', analysis.text_color || '',
      analysis.text_size || 'none', analysis.all_caps_text ? 1 : 0,
      analysis.layout, analysis.background_type, analysis.has_border ? 1 : 0, analysis.has_emoji ? 1 : 0,
      JSON.stringify(analysis), JSON.stringify(analysis.faces || []),
    );

    console.log(`[thumb-analyzer] ${videoId}: ${analysis.expression}, ${analysis.primary_color}, text="${analysis.text_content?.substring(0, 30)}"`);
    return analysis;
  } catch (err: any) {
    console.error(`[thumb-analyzer] Failed for ${videoId}: ${err.message}`);
    return null;
  }
}

/**
 * Analyze a single competitor thumbnail.
 */
export async function analyzeCompetitorThumbnail(videoId: string, thumbnailUrl: string, title: string, views: number, channelName: string): Promise<any> {
  try {
    const analysis = await visionAnalyze(thumbnailUrl);
    const db = getDb();
    db.prepare(`
      INSERT INTO competitor_thumbnail_analysis (
        video_id, channel_name, title, thumbnail_url, views,
        expression, mouth_open, eyebrows_raised,
        face_count, face_size,
        primary_color, secondary_color, brightness, contrast,
        has_text, text_content, text_color, text_size, all_caps_text,
        layout, background_type, has_border, has_emoji,
        analysis_json, faces_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        views = excluded.views,
        expression = excluded.expression, mouth_open = excluded.mouth_open,
        eyebrows_raised = excluded.eyebrows_raised, face_count = excluded.face_count,
        face_size = excluded.face_size, primary_color = excluded.primary_color,
        secondary_color = excluded.secondary_color, brightness = excluded.brightness,
        contrast = excluded.contrast, has_text = excluded.has_text,
        text_content = excluded.text_content, text_color = excluded.text_color,
        text_size = excluded.text_size, all_caps_text = excluded.all_caps_text,
        layout = excluded.layout, background_type = excluded.background_type,
        has_border = excluded.has_border, has_emoji = excluded.has_emoji,
        analysis_json = excluded.analysis_json, faces_json = excluded.faces_json,
        analyzed_at = datetime('now')
    `).run(
      videoId, channelName, title, thumbnailUrl, views,
      analysis.expression, analysis.mouth_open ? 1 : 0, analysis.eyebrows_raised ? 1 : 0,
      analysis.face_count || 0, analysis.face_size || 'none',
      analysis.primary_color, analysis.secondary_color, analysis.brightness, analysis.contrast,
      analysis.has_text ? 1 : 0, analysis.text_content || '', analysis.text_color || '',
      analysis.text_size || 'none', analysis.all_caps_text ? 1 : 0,
      analysis.layout, analysis.background_type, analysis.has_border ? 1 : 0, analysis.has_emoji ? 1 : 0,
      JSON.stringify(analysis), JSON.stringify(analysis.faces || []),
    );

    console.log(`[thumb-analyzer-comp] ${channelName}/${videoId}: ${analysis.expression}, ${analysis.primary_color}`);
    return analysis;
  } catch (err: any) {
    console.error(`[thumb-analyzer-comp] Failed for ${videoId}: ${err.message}`);
    return null;
  }
}

/**
 * Analyze all unanalyzed thumbnails from our channel.
 */
export async function analyzeAllThumbnails(limit = 20): Promise<{ analyzed: number; errors: number }> {
  const db = getDb();
  let analyzed = 0;
  let errors = 0;

  try {
    const videos = db.prepare(`
      SELECT v.video_id, v.title, v.thumbnail_url, v.view_count
      FROM yt.videos v
      LEFT JOIN thumbnail_analysis ta ON v.video_id = ta.video_id
      WHERE ta.id IS NULL AND v.duration_seconds > 180 AND v.thumbnail_url IS NOT NULL
      ORDER BY v.publish_date DESC
      LIMIT ?
    `).all(limit) as any[];

    for (const video of videos) {
      let ctr = 0;
      try {
        const snap = db.prepare('SELECT ctr FROM studio_snapshots WHERE video_id = ? ORDER BY scraped_at DESC LIMIT 1').get(video.video_id) as any;
        if (snap) ctr = snap.ctr;
      } catch {}

      const result = await analyzeThumbnail(video.video_id, video.thumbnail_url, video.title, video.view_count, ctr);
      if (result) analyzed++;
      else errors++;

      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err: any) {
    console.error(`[thumb-analyzer] Batch analysis failed: ${err.message}`);
  }

  console.log(`[thumb-analyzer] Analyzed ${analyzed}, errors ${errors}`);
  return { analyzed, errors };
}

/**
 * Analyze competitor thumbnails — spread evenly across channels, top viewed first.
 */
export async function analyzeCompetitorThumbnails(limitPerChannel = 50): Promise<{ analyzed: number; errors: number }> {
  const db = getDb();
  let analyzed = 0;
  let errors = 0;

  try {
    // Get competitor channels ordered by fewest analyzed first (so we balance)
    const channels = db.prepare(`
      SELECT c.id, c.name,
        (SELECT COUNT(*) FROM competitor_thumbnail_analysis cta WHERE cta.channel_name = c.name) as already_done
      FROM competitors c
      ORDER BY already_done ASC, c.subscriber_count DESC
    `).all() as any[];

    for (const channel of channels) {
      // Get top-viewed unanalyzed videos for this channel
      const videos = db.prepare(`
        SELECT cv.video_id, cv.title, cv.thumbnail_url, cv.views, c.name as channel_name
        FROM competitor_videos cv
        JOIN competitors c ON cv.competitor_id = c.id
        LEFT JOIN competitor_thumbnail_analysis cta ON cv.video_id = cta.video_id
        WHERE cta.id IS NULL AND cv.competitor_id = ? AND cv.duration_seconds > 180 AND cv.thumbnail_url IS NOT NULL
        ORDER BY cv.views DESC
        LIMIT ?
      `).all(channel.id, limitPerChannel) as any[];

      if (videos.length === 0) continue;
      console.log(`[thumb-analyzer-comp] Analyzing ${videos.length} from ${channel.name}`);

      for (const video of videos) {
        const result = await analyzeCompetitorThumbnail(
          video.video_id, video.thumbnail_url, video.title, video.views, video.channel_name
        );
        if (result) analyzed++;
        else errors++;

        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (err: any) {
    console.error(`[thumb-analyzer-comp] Batch analysis failed: ${err.message}`);
  }

  console.log(`[thumb-analyzer-comp] Analyzed ${analyzed}, errors ${errors}`);
  return { analyzed, errors };
}

/**
 * Helper: query insights from a given table.
 */
function getInsightsFromTable(table: string): any {
  const db = getDb();

  const total = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
  if (total < 5) return { total, insights: [], message: 'Need at least 5 analyzed thumbnails for insights' };

  const avgViews = (db.prepare(`SELECT AVG(views) as avg FROM ${table}`).get() as any).avg;
  const hasCtr = table === 'thumbnail_analysis'; // competitor table has no ctr column

  const attributes = [
    { name: 'Expression', column: 'expression' },
    { name: 'Face Size', column: 'face_size' },
    { name: 'Primary Color', column: 'primary_color' },
    { name: 'Brightness', column: 'brightness' },
    { name: 'Contrast', column: 'contrast' },
    { name: 'Text Size', column: 'text_size' },
    { name: 'Layout', column: 'layout' },
    { name: 'Background', column: 'background_type' },
  ];

  const insights = [];

  for (const attr of attributes) {
    const rows = db.prepare(`
      SELECT ${attr.column} as value, COUNT(*) as count,
        ROUND(AVG(views)) as avg_views
        ${hasCtr ? ', ROUND(AVG(ctr), 2) as avg_ctr' : ', 0 as avg_ctr'}
      FROM ${table}
      WHERE ${attr.column} IS NOT NULL AND ${attr.column} != '' AND ${attr.column} != 'none'
      GROUP BY ${attr.column}
      HAVING count >= 2
      ORDER BY avg_views DESC
    `).all() as any[];

    if (rows.length >= 2) {
      // Add example thumbnails for each value
      const values = rows.map((r: any) => {
        const examples = db.prepare(`
          SELECT video_id, title, thumbnail_url, views
          FROM ${table}
          WHERE ${attr.column} = ?
          ORDER BY views DESC LIMIT 3
        `).all(r.value) as any[];
        return { ...r, examples };
      });

      insights.push({
        attribute: attr.name,
        values,
        bestValue: values[0]?.value,
        bestAvgViews: values[0]?.avg_views,
        worstValue: values[values.length - 1]?.value,
        worstAvgViews: values[values.length - 1]?.avg_views,
        liftPercent: values[values.length - 1]?.avg_views > 0
          ? Math.round(((values[0]?.avg_views - values[values.length - 1]?.avg_views) / values[values.length - 1]?.avg_views) * 100)
          : 0,
      });
    }
  }

  const boolAttrs = [
    { name: 'Mouth Open', column: 'mouth_open' },
    { name: 'Eyebrows Raised', column: 'eyebrows_raised' },
    { name: 'Has Text', column: 'has_text' },
    { name: 'All Caps Text', column: 'all_caps_text' },
    { name: 'Has Border', column: 'has_border' },
    { name: 'Has Emoji', column: 'has_emoji' },
  ];

  for (const attr of boolAttrs) {
    const rows = db.prepare(`
      SELECT ${attr.column} as value, COUNT(*) as count,
        ROUND(AVG(views)) as avg_views
        ${hasCtr ? ', ROUND(AVG(ctr), 2) as avg_ctr' : ', 0 as avg_ctr'}
      FROM ${table}
      GROUP BY ${attr.column}
      ORDER BY avg_views DESC
    `).all() as any[];

    if (rows.length === 2) {
      const yes = rows.find((r: any) => r.value === 1);
      const no = rows.find((r: any) => r.value === 0);
      if (yes && no) {
        insights.push({
          attribute: attr.name,
          values: [
            { value: 'Yes', count: yes.count, avg_views: yes.avg_views, avg_ctr: yes.avg_ctr },
            { value: 'No', count: no.count, avg_views: no.avg_views, avg_ctr: no.avg_ctr },
          ],
          bestValue: yes.avg_views > no.avg_views ? 'Yes' : 'No',
          bestAvgViews: Math.max(yes.avg_views, no.avg_views),
          worstValue: yes.avg_views > no.avg_views ? 'No' : 'Yes',
          worstAvgViews: Math.min(yes.avg_views, no.avg_views),
          liftPercent: Math.min(yes.avg_views, no.avg_views) > 0
            ? Math.round(((Math.max(yes.avg_views, no.avg_views) - Math.min(yes.avg_views, no.avg_views)) / Math.min(yes.avg_views, no.avg_views)) * 100)
            : 0,
        });
      }
    }
  }

  insights.sort((a, b) => b.liftPercent - a.liftPercent);

  // Combination insights: expression + color combos
  const combos: any[] = [];
  try {
    const comboRows = db.prepare(`
      SELECT expression, primary_color, COUNT(*) as count,
        ROUND(AVG(views)) as avg_views
      FROM ${table}
      WHERE expression IS NOT NULL AND primary_color IS NOT NULL
        AND expression != '' AND primary_color != ''
      GROUP BY expression, primary_color
      HAVING count >= 2
      ORDER BY avg_views DESC
      LIMIT 20
    `).all() as any[];

    for (const r of comboRows) {
      const ex = db.prepare(`
        SELECT video_id, title, thumbnail_url, views FROM ${table}
        WHERE expression = ? AND primary_color = ?
        ORDER BY views DESC LIMIT 2
      `).all(r.expression, r.primary_color) as any[];
      combos.push({ ...r, examples: ex });
    }
  } catch {}

  // Face combo insights (Toni vs Ryan style — left face vs right face expressions)
  const faceComboInsights: any[] = [];
  try {
    const withFaces = db.prepare(`
      SELECT video_id, title, thumbnail_url, views, faces_json
      FROM ${table}
      WHERE faces_json IS NOT NULL AND faces_json != '[]' AND face_count >= 2
    `).all() as any[];

    // Analyze left+right expression combos
    const comboPerfMap: Record<string, { count: number; totalViews: number; examples: any[] }> = {};
    for (const row of withFaces) {
      try {
        const faces = JSON.parse(row.faces_json);
        if (faces.length < 2) continue;
        const leftFace = faces.find((f: any) => f.position === 'left');
        const rightFace = faces.find((f: any) => f.position === 'right');
        if (!leftFace || !rightFace) continue;

        const key = `${leftFace.expression} (left) + ${rightFace.expression} (right)`;
        if (!comboPerfMap[key]) comboPerfMap[key] = { count: 0, totalViews: 0, examples: [] };
        comboPerfMap[key].count++;
        comboPerfMap[key].totalViews += row.views;
        if (comboPerfMap[key].examples.length < 3) {
          comboPerfMap[key].examples.push({ video_id: row.video_id, title: row.title, thumbnail_url: row.thumbnail_url, views: row.views });
        }
      } catch {}
    }

    for (const [combo, data] of Object.entries(comboPerfMap)) {
      if (data.count >= 2) {
        faceComboInsights.push({
          combo,
          count: data.count,
          avg_views: Math.round(data.totalViews / data.count),
          examples: data.examples.sort((a: any, b: any) => b.views - a.views),
        });
      }
    }
    faceComboInsights.sort((a, b) => b.avg_views - a.avg_views);
  } catch {}

  // Generate advice lines from top insights
  const advice: string[] = [];
  const topExpression = insights.find(i => i.attribute === 'Expression');
  const topColor = insights.find(i => i.attribute === 'Primary Color');
  const topLayout = insights.find(i => i.attribute === 'Layout');
  const topBg = insights.find(i => i.attribute === 'Background');
  const topText = insights.find(i => i.attribute === 'Has Text');

  if (topExpression && topColor) {
    advice.push(`Use ${topExpression.bestValue} expression with ${topColor.bestValue} color — your best combo gets ${topExpression.bestAvgViews?.toLocaleString()} avg views`);
  }
  if (topLayout) {
    advice.push(`${topLayout.bestValue} layout outperforms ${topLayout.worstValue} by ${topLayout.liftPercent}%`);
  }
  if (topBg) {
    advice.push(`${topBg.bestValue} backgrounds get ${topBg.bestAvgViews?.toLocaleString()} avg views vs ${topBg.worstAvgViews?.toLocaleString()} for ${topBg.worstValue}`);
  }
  if (topText && topText.liftPercent > 10) {
    advice.push(`Thumbnails ${topText.bestValue === 'Yes' ? 'with' : 'without'} text get ${topText.liftPercent}% more views`);
  }
  if (combos.length > 0) {
    advice.push(`Best combo: ${combos[0].expression} + ${combos[0].primary_color} = ${combos[0].avg_views?.toLocaleString()} avg views (${combos[0].count} videos)`);
  }
  if (faceComboInsights.length > 0) {
    advice.push(`Best face pair: ${faceComboInsights[0].combo} = ${faceComboInsights[0].avg_views?.toLocaleString()} avg views`);
  }

  return { total, avgViews: Math.round(avgViews), insights, combos, faceComboInsights, advice };
}

/**
 * Get insights filtered by content type (podcast vs reaction/TNTL).
 */
function getInsightsFiltered(table: string, contentType: string): any {
  const db = getDb();

  // Join with yt.videos to get category
  const categoryFilter = contentType === 'podcast'
    ? "AND v.category = 'podcast'"
    : "AND (v.category = 'reaction' OR v.title LIKE '%TRY NOT TO LAUGH%' OR v.title LIKE '%TNTL%')";

  const countSql = `SELECT COUNT(*) as c FROM ${table} ta JOIN yt.videos v ON ta.video_id = v.video_id WHERE 1=1 ${categoryFilter}`;
  const total = (db.prepare(countSql).get() as any).c;
  if (total < 5) return { total, contentType, insights: [], message: `Need at least 5 ${contentType} thumbnails for insights` };

  const avgViews = (db.prepare(`SELECT AVG(ta.views) as avg FROM ${table} ta JOIN yt.videos v ON ta.video_id = v.video_id WHERE 1=1 ${categoryFilter}`).get() as any).avg;

  const attributes = [
    { name: 'Expression', column: 'expression' },
    { name: 'Face Size', column: 'face_size' },
    { name: 'Primary Color', column: 'primary_color' },
    { name: 'Brightness', column: 'brightness' },
    { name: 'Contrast', column: 'contrast' },
    { name: 'Text Size', column: 'text_size' },
    { name: 'Layout', column: 'layout' },
    { name: 'Background', column: 'background_type' },
  ];

  const insights = [];

  for (const attr of attributes) {
    const rows = db.prepare(`
      SELECT ta.${attr.column} as value, COUNT(*) as count,
        ROUND(AVG(ta.views)) as avg_views,
        ROUND(AVG(ta.ctr), 2) as avg_ctr
      FROM ${table} ta
      JOIN yt.videos v ON ta.video_id = v.video_id
      WHERE ta.${attr.column} IS NOT NULL AND ta.${attr.column} != '' AND ta.${attr.column} != 'none'
      ${categoryFilter}
      GROUP BY ta.${attr.column}
      HAVING count >= 2
      ORDER BY avg_views DESC
    `).all() as any[];

    if (rows.length >= 2) {
      // Get example thumbnails for each value
      const values = rows.map((r: any) => {
        const examples = db.prepare(`
          SELECT ta.video_id, ta.title, ta.thumbnail_url, ta.views
          FROM ${table} ta
          JOIN yt.videos v ON ta.video_id = v.video_id
          WHERE ta.${attr.column} = ? ${categoryFilter}
          ORDER BY ta.views DESC LIMIT 3
        `).all(r.value) as any[];
        return { ...r, examples };
      });

      insights.push({
        attribute: attr.name,
        values,
        bestValue: values[0]?.value,
        bestAvgViews: values[0]?.avg_views,
        worstValue: values[values.length - 1]?.value,
        worstAvgViews: values[values.length - 1]?.avg_views,
        liftPercent: values[values.length - 1]?.avg_views > 0
          ? Math.round(((values[0]?.avg_views - values[values.length - 1]?.avg_views) / values[values.length - 1]?.avg_views) * 100)
          : 0,
      });
    }
  }

  const boolAttrs = [
    { name: 'Mouth Open', column: 'mouth_open' },
    { name: 'Eyebrows Raised', column: 'eyebrows_raised' },
    { name: 'Has Text', column: 'has_text' },
    { name: 'All Caps Text', column: 'all_caps_text' },
    { name: 'Has Border', column: 'has_border' },
    { name: 'Has Emoji', column: 'has_emoji' },
  ];

  for (const attr of boolAttrs) {
    const rows = db.prepare(`
      SELECT ta.${attr.column} as value, COUNT(*) as count,
        ROUND(AVG(ta.views)) as avg_views,
        ROUND(AVG(ta.ctr), 2) as avg_ctr
      FROM ${table} ta
      JOIN yt.videos v ON ta.video_id = v.video_id
      WHERE 1=1 ${categoryFilter}
      GROUP BY ta.${attr.column}
      ORDER BY avg_views DESC
    `).all() as any[];

    if (rows.length === 2) {
      const yes = rows.find((r: any) => r.value === 1);
      const no = rows.find((r: any) => r.value === 0);
      if (yes && no) {
        insights.push({
          attribute: attr.name,
          values: [
            { value: 'Yes', count: yes.count, avg_views: yes.avg_views, avg_ctr: yes.avg_ctr },
            { value: 'No', count: no.count, avg_views: no.avg_views, avg_ctr: no.avg_ctr },
          ],
          bestValue: yes.avg_views > no.avg_views ? 'Yes' : 'No',
          bestAvgViews: Math.max(yes.avg_views, no.avg_views),
          worstValue: yes.avg_views > no.avg_views ? 'No' : 'Yes',
          worstAvgViews: Math.min(yes.avg_views, no.avg_views),
          liftPercent: Math.min(yes.avg_views, no.avg_views) > 0
            ? Math.round(((Math.max(yes.avg_views, no.avg_views) - Math.min(yes.avg_views, no.avg_views)) / Math.min(yes.avg_views, no.avg_views)) * 100)
            : 0,
        });
      }
    }
  }

  insights.sort((a, b) => b.liftPercent - a.liftPercent);

  // Combination insights for this content type
  const combos: any[] = [];
  try {
    const comboRows = db.prepare(`
      SELECT ta.expression, ta.primary_color, COUNT(*) as count,
        ROUND(AVG(ta.views)) as avg_views
      FROM ${table} ta
      JOIN yt.videos v ON ta.video_id = v.video_id
      WHERE ta.expression IS NOT NULL AND ta.primary_color IS NOT NULL
        AND ta.expression != '' AND ta.primary_color != ''
        ${categoryFilter}
      GROUP BY ta.expression, ta.primary_color
      HAVING count >= 2
      ORDER BY avg_views DESC
      LIMIT 15
    `).all() as any[];

    for (const r of comboRows) {
      const ex = db.prepare(`
        SELECT ta.video_id, ta.title, ta.thumbnail_url, ta.views FROM ${table} ta
        JOIN yt.videos v ON ta.video_id = v.video_id
        WHERE ta.expression = ? AND ta.primary_color = ? ${categoryFilter}
        ORDER BY ta.views DESC LIMIT 2
      `).all(r.expression, r.primary_color) as any[];
      combos.push({ ...r, examples: ex });
    }
  } catch {}

  // Generate advice
  const advice: string[] = [];
  const topExpression = insights.find(i => i.attribute === 'Expression');
  const topColor = insights.find(i => i.attribute === 'Primary Color');
  if (topExpression && topColor) {
    advice.push(`Use ${topExpression.bestValue} expression with ${topColor.bestValue} color for ${contentType} videos`);
  }
  if (combos.length > 0) {
    advice.push(`Best ${contentType} combo: ${combos[0].expression} + ${combos[0].primary_color} = ${combos[0].avg_views?.toLocaleString()} avg views`);
  }

  return { total, contentType, avgViews: Math.round(avgViews), insights, combos, advice };
}

/**
 * Get insights from our channel thumbnails. Optionally filter by content type.
 */
export function getThumbnailInsights(contentType?: string): any {
  if (contentType === 'podcast' || contentType === 'reaction') {
    return getInsightsFiltered('thumbnail_analysis', contentType);
  }
  return getInsightsFromTable('thumbnail_analysis');
}

/**
 * Get insights from competitor thumbnails.
 */
export function getCompetitorThumbnailInsights(): any {
  return getInsightsFromTable('competitor_thumbnail_analysis');
}

/**
 * Side-by-side comparison: us vs competitors for each attribute.
 */
export function getThumbnailComparison(): any {
  const db = getDb();
  const ours = getThumbnailInsights();
  const theirs = getCompetitorThumbnailInsights();

  if (!ours.insights.length || !theirs.insights.length) {
    return { ours, competitors: theirs, comparison: [], message: 'Need data from both channels for comparison' };
  }

  const comparison: any[] = [];

  for (const ourInsight of ours.insights) {
    const theirInsight = theirs.insights.find((i: any) => i.attribute === ourInsight.attribute);
    if (!theirInsight) continue;

    // Find what top competitors use that we don't (or underuse)
    const gaps: any[] = [];
    for (const tv of theirInsight.values) {
      const ourMatch = ourInsight.values.find((ov: any) => ov.value === tv.value);
      const ourCount = ourMatch?.count || 0;
      const theirPct = (tv.count / theirs.total) * 100;
      const ourPct = ours.total > 0 ? (ourCount / ours.total) * 100 : 0;

      if (theirPct > ourPct + 10 && tv.avg_views > theirs.avgViews) {
        gaps.push({
          value: tv.value,
          competitorUsage: Math.round(theirPct),
          ourUsage: Math.round(ourPct),
          competitorAvgViews: tv.avg_views,
          ourAvgViews: ourMatch?.avg_views || 0,
        });
      }
    }

    comparison.push({
      attribute: ourInsight.attribute,
      ourBest: ourInsight.bestValue,
      ourBestViews: ourInsight.bestAvgViews,
      competitorBest: theirInsight.bestValue,
      competitorBestViews: theirInsight.bestAvgViews,
      sameTopChoice: ourInsight.bestValue === theirInsight.bestValue,
      gaps,
    });
  }

  // Per-channel breakdown for competitors
  let channelBreakdown: any[] = [];
  try {
    channelBreakdown = db.prepare(`
      SELECT channel_name, COUNT(*) as analyzed,
        ROUND(AVG(views)) as avg_views,
        -- Most common expression
        (SELECT expression FROM competitor_thumbnail_analysis c2 WHERE c2.channel_name = cta.channel_name GROUP BY expression ORDER BY COUNT(*) DESC LIMIT 1) as top_expression,
        (SELECT primary_color FROM competitor_thumbnail_analysis c2 WHERE c2.channel_name = cta.channel_name GROUP BY primary_color ORDER BY COUNT(*) DESC LIMIT 1) as top_color,
        (SELECT layout FROM competitor_thumbnail_analysis c2 WHERE c2.channel_name = cta.channel_name GROUP BY layout ORDER BY COUNT(*) DESC LIMIT 1) as top_layout,
        ROUND(AVG(has_text) * 100) as text_pct,
        ROUND(AVG(face_count), 1) as avg_faces
      FROM competitor_thumbnail_analysis cta
      GROUP BY channel_name
      ORDER BY avg_views DESC
    `).all() as any[];
  } catch {}

  return { ours, competitors: theirs, comparison, channelBreakdown };
}
