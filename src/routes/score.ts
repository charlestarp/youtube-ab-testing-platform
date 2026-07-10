/**
 * Score routes — thumbnail CTR prediction and title scoring.
 * POST /api/score/thumbnail — multipart image upload, returns CTR prediction + factors
 * POST /api/score/title     — JSON { title }, returns viral score
 * POST /api/score/compare   — multipart with multiple images, returns comparative analysis
 */

import { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { scoreTitle } from '../services/viral-score.js';
import { config } from '../config.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

// Same prompt used in thumbnail-analyzer.ts — kept in sync here for buffer-based calls
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
 * Analyze a thumbnail buffer with Claude Vision.
 * Accepts raw image buffer and media type (image/jpeg, image/png, image/webp).
 * Auto-resizes/converts to JPEG if the image exceeds Claude's 5MB base64 limit.
 */
async function visionAnalyzeBuffer(buffer: Buffer, mediaType: string): Promise<any> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  // Claude Vision has a 5MB limit on base64 images. Resize if needed.
  // Also convert PNGs to JPEG (much smaller) — visual analysis doesn't need lossless.
  const MAX_BYTES = 4 * 1024 * 1024; // 4MB to leave headroom
  let processedBuffer = buffer;
  let finalMediaType = mediaType;

  if (buffer.length > MAX_BYTES || mediaType === 'image/png') {
    const sharp = (await import('sharp')).default;
    let quality = 90;
    processedBuffer = await sharp(buffer)
      .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    // Step down quality if still too large
    while (processedBuffer.length > MAX_BYTES && quality > 30) {
      quality -= 10;
      processedBuffer = await sharp(buffer)
        .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    }
    finalMediaType = 'image/jpeg';
    console.log(`[score] Resized for Vision: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(processedBuffer.length / 1024 / 1024).toFixed(1)}MB (q${quality})`);
  }

  const base64 = processedBuffer.toString('base64');
  const safeMediaType = (finalMediaType === 'image/jpeg' || finalMediaType === 'image/png' || finalMediaType === 'image/webp' || finalMediaType === 'image/gif')
    ? finalMediaType
    : 'image/jpeg';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: safeMediaType as any, data: base64 } },
        { type: 'text', text: ANALYSIS_PROMPT },
      ],
    }],
  });

  try { logAiUsage({ app: 'yt-testing', feature: 'thumbnail-score', user: 'unknown', model: 'claude-sonnet-4-6', usage: response.usage }); } catch {}

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response from Claude Vision');
  return JSON.parse(jsonMatch[0]);
}

/**
 * Compute a CTR prediction score (0-100) by correlating thumbnail attributes
 * against historical performance data in thumbnail_analysis and A/B test results.
 */
function computeCtrScore(analysis: any): {
  score: number;
  factors: { name: string; value: string; score: number; insight: string }[];
  advice: string[];
  matchesWinners: boolean;
} {
  const db = getDb();
  const factors: { name: string; value: string; score: number; insight: string }[] = [];
  const advice: string[] = [];

  // Helper: get avg CTR and count for a given attribute value from thumbnail_analysis
  function getAttrCtr(column: string, value: string | number): { avg_ctr: number; count: number; global_avg: number } {
    try {
      const row = db.prepare(`
        SELECT ROUND(AVG(ctr), 2) as avg_ctr, COUNT(*) as count
        FROM thumbnail_analysis
        WHERE ${column} = ? AND ctr > 0
      `).get(value) as any;
      const globalRow = db.prepare(`
        SELECT ROUND(AVG(ctr), 2) as global_avg FROM thumbnail_analysis WHERE ctr > 0
      `).get() as any;
      return {
        avg_ctr: row?.avg_ctr || 0,
        count: row?.count || 0,
        global_avg: globalRow?.global_avg || 0,
      };
    } catch { return { avg_ctr: 0, count: 0, global_avg: 0 }; }
  }

  // Helper: get avg CTR for a boolean column
  function getBoolCtr(column: string, value: boolean): { yes_ctr: number; no_ctr: number; yes_count: number; no_count: number } {
    try {
      const yes = db.prepare(`SELECT ROUND(AVG(ctr), 2) as avg_ctr, COUNT(*) as count FROM thumbnail_analysis WHERE ${column} = 1 AND ctr > 0`).get() as any;
      const no = db.prepare(`SELECT ROUND(AVG(ctr), 2) as avg_ctr, COUNT(*) as count FROM thumbnail_analysis WHERE ${column} = 0 AND ctr > 0`).get() as any;
      return {
        yes_ctr: yes?.avg_ctr || 0,
        no_ctr: no?.avg_ctr || 0,
        yes_count: yes?.count || 0,
        no_count: no?.count || 0,
      };
    } catch { return { yes_ctr: 0, no_ctr: 0, yes_count: 0, no_count: 0 }; }
  }

  // Helper: get best performing value for an attribute
  function getBestValue(column: string): { best: string; best_ctr: number; worst: string; worst_ctr: number } {
    try {
      const rows = db.prepare(`
        SELECT ${column} as value, ROUND(AVG(ctr), 2) as avg_ctr, COUNT(*) as count
        FROM thumbnail_analysis
        WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} != 'none' AND ctr > 0
        GROUP BY ${column}
        HAVING count >= 2
        ORDER BY avg_ctr DESC
      `).all() as any[];
      if (rows.length < 2) return { best: '', best_ctr: 0, worst: '', worst_ctr: 0 };
      return { best: rows[0].value, best_ctr: rows[0].avg_ctr, worst: rows[rows.length - 1].value, worst_ctr: rows[rows.length - 1].avg_ctr };
    } catch { return { best: '', best_ctr: 0, worst: '', worst_ctr: 0 }; }
  }

  // Check how many analyses exist — if too few, fall back to competitor data for scoring direction
  const analysisCount = (db.prepare('SELECT COUNT(*) as c FROM thumbnail_analysis WHERE ctr > 0').get() as any)?.c || 0;
  const hasEnoughData = analysisCount >= 10;

  // --- Factor 1: Expression ---
  const expressionValue = analysis.expression || 'neutral';
  if (hasEnoughData) {
    const { avg_ctr, count, global_avg } = getAttrCtr('expression', expressionValue);
    const best = getBestValue('expression');
    let score = 50;
    if (count >= 2 && global_avg > 0) {
      const ratio = avg_ctr / global_avg;
      score = Math.min(95, Math.max(15, Math.round(ratio * 65)));
    } else {
      // Fallback scoring based on known research (expression engagement hierarchy)
      const expressionScores: Record<string, number> = {
        shocked: 85, scared: 82, excited: 80, laughing: 78, confused: 72,
        crying: 68, angry: 65, disgusted: 60, smiling: 58, neutral: 40,
      };
      score = expressionScores[expressionValue] || 50;
    }
    const insight = count >= 2
      ? `${expressionValue} expression: ${avg_ctr}% avg CTR from ${count} videos (channel avg: ${global_avg}%).${best.best && best.best !== expressionValue ? ` Best: ${best.best} at ${best.best_ctr}%.` : ''}`
      : `${expressionValue} expression. Not enough data for channel-specific insight — general benchmark: ${score}/100.`;
    factors.push({ name: 'Expression', value: expressionValue, score, insight });
    if (best.best && best.best !== expressionValue && best.best_ctr > avg_ctr + 0.5) {
      advice.push(`Switch to ${best.best} expression — ${best.best_ctr}% avg CTR vs ${avg_ctr}% for ${expressionValue}`);
    }
  } else {
    const expressionScores: Record<string, number> = {
      shocked: 85, scared: 82, excited: 80, laughing: 78, confused: 72,
      crying: 68, angry: 65, disgusted: 60, smiling: 58, neutral: 40,
    };
    const score = expressionScores[expressionValue] || 50;
    factors.push({ name: 'Expression', value: expressionValue, score, insight: `${expressionValue} expression. Shocked/scared/excited expressions typically outperform neutral on YouTube.` });
  }

  // --- Factor 2: Face Size ---
  const faceSizeValue = analysis.face_size || 'none';
  if (hasEnoughData) {
    const { avg_ctr, count, global_avg } = getAttrCtr('face_size', faceSizeValue);
    const best = getBestValue('face_size');
    let score = 50;
    if (count >= 2 && global_avg > 0) {
      score = Math.min(95, Math.max(15, Math.round((avg_ctr / global_avg) * 65)));
    } else {
      const faceSizeScores: Record<string, number> = { large: 85, medium: 65, small: 45, none: 35 };
      score = faceSizeScores[faceSizeValue] || 50;
    }
    const insight = count >= 2
      ? `Face size ${faceSizeValue}: ${avg_ctr}% avg CTR from ${count} videos.${best.best && best.best !== faceSizeValue ? ` Best: ${best.best} at ${best.best_ctr}%.` : ''}`
      : `Face size: ${faceSizeValue}. Larger faces typically drive higher CTR by making expressions visible at thumbnail size.`;
    factors.push({ name: 'Face Size', value: faceSizeValue, score, insight });
    if (best.best && best.best !== faceSizeValue && (faceSizeValue === 'small' || faceSizeValue === 'none')) {
      advice.push(`Larger face in frame — face size ${best.best} achieves ${best.best_ctr}% avg CTR`);
    }
  } else {
    const faceSizeScores: Record<string, number> = { large: 85, medium: 65, small: 45, none: 35 };
    const score = faceSizeScores[faceSizeValue] || 50;
    factors.push({ name: 'Face Size', value: faceSizeValue, score, insight: `Face size: ${faceSizeValue}. Larger faces are typically more clickable at small sizes.` });
  }

  // --- Factor 3: Primary Color ---
  const primaryColor = analysis.primary_color || 'unknown';
  if (hasEnoughData) {
    const { avg_ctr, count, global_avg } = getAttrCtr('primary_color', primaryColor);
    const best = getBestValue('primary_color');
    let score = 50;
    if (count >= 2 && global_avg > 0) {
      score = Math.min(95, Math.max(15, Math.round((avg_ctr / global_avg) * 65)));
    } else {
      const colorScores: Record<string, number> = { red: 80, orange: 75, yellow: 72, teal: 70, blue: 65, green: 60, purple: 58, pink: 55, white: 50, black: 45, brown: 40 };
      score = colorScores[primaryColor] || 50;
    }
    const insight = count >= 2
      ? `${primaryColor} background: ${avg_ctr}% avg CTR from ${count} videos.${best.best && best.best !== primaryColor ? ` Top color: ${best.best} at ${best.best_ctr}%.` : ''}`
      : `Primary color: ${primaryColor}. High-contrast colors (red, orange, teal) tend to stand out in feeds.`;
    factors.push({ name: 'Primary Color', value: primaryColor, score, insight });
    if (best.best && best.best !== primaryColor && best.best_ctr > (avg_ctr || 0) + 0.3) {
      advice.push(`Try ${best.best} as primary color — ${best.best_ctr}% avg CTR vs channel average`);
    }
  } else {
    const colorScores: Record<string, number> = { red: 80, orange: 75, yellow: 72, teal: 70, blue: 65, green: 60, purple: 58, pink: 55, white: 50, black: 45, brown: 40 };
    const score = colorScores[primaryColor] || 50;
    factors.push({ name: 'Primary Color', value: primaryColor, score, insight: `Primary color: ${primaryColor}. Warm and high-contrast colors typically drive more clicks.` });
  }

  // --- Factor 4: Text Overlay ---
  const hasText = !!analysis.has_text;
  const textData = getBoolCtr('has_text', hasText);
  let textScore = 60;
  let textInsight = '';
  if (hasEnoughData && (textData.yes_count >= 3 && textData.no_count >= 3)) {
    const relevantCtr = hasText ? textData.yes_ctr : textData.no_ctr;
    const otherCtr = hasText ? textData.no_ctr : textData.yes_ctr;
    const global_avg = ((textData.yes_ctr * textData.yes_count) + (textData.no_ctr * textData.no_count)) / (textData.yes_count + textData.no_count);
    textScore = Math.min(90, Math.max(20, Math.round((relevantCtr / (global_avg || 1)) * 65)));
    textInsight = hasText
      ? `Thumbnails with text: ${textData.yes_ctr}% avg CTR (${textData.yes_count} videos). Without text: ${textData.no_ctr}%${textData.yes_ctr > textData.no_ctr ? ' — text helps here.' : ' — consider testing without.'}`
      : `Thumbnails without text: ${textData.no_ctr}% avg CTR. With text: ${textData.yes_ctr}% — ${textData.yes_ctr > textData.no_ctr ? 'adding text may improve CTR.' : 'no text is working better currently.'}`;
    if (!hasText && textData.yes_ctr > textData.no_ctr + 0.3) {
      advice.push(`Add text overlay — thumbnails with text average ${textData.yes_ctr}% CTR vs ${textData.no_ctr}% without`);
    }
    if (hasText && textData.no_ctr > textData.yes_ctr + 0.3) {
      advice.push(`Consider testing without text — thumbnails without text average ${textData.no_ctr}% CTR vs ${textData.yes_ctr}% with`);
    }
  } else {
    textScore = hasText ? 70 : 55;
    textInsight = hasText
      ? `Has text overlay: "${analysis.text_content || ''}". Text helps communicate context at a glance.`
      : 'No text overlay. Adding bold text can clarify the video topic and boost CTR.';
    if (!hasText) advice.push('Consider adding text overlay to clarify the video topic');
  }
  factors.push({ name: 'Text Overlay', value: hasText ? `Yes ("${(analysis.text_content || '').slice(0, 30)}")` : 'No', score: textScore, insight: textInsight });

  // --- Factor 5: Brightness ---
  const brightness = analysis.brightness || 'medium';
  if (hasEnoughData) {
    const { avg_ctr, count, global_avg } = getAttrCtr('brightness', brightness);
    const best = getBestValue('brightness');
    let score = 50;
    if (count >= 2 && global_avg > 0) {
      score = Math.min(90, Math.max(20, Math.round((avg_ctr / global_avg) * 65)));
    } else {
      const brightnessScores: Record<string, number> = { bright: 72, medium: 60, dark: 45 };
      score = brightnessScores[brightness] || 50;
    }
    const insight = count >= 2
      ? `${brightness} brightness: ${avg_ctr}% avg CTR from ${count} videos.`
      : `Brightness: ${brightness}. Bright thumbnails are easier to see at small sizes in the feed.`;
    factors.push({ name: 'Brightness', value: brightness, score, insight });
    if (brightness === 'dark' && best.best && best.best !== 'dark') {
      advice.push(`Lighter thumbnail background — ${best.best} brightness achieves ${best.best_ctr}% avg CTR`);
    }
  } else {
    const brightnessScores: Record<string, number> = { bright: 72, medium: 60, dark: 45 };
    const score = brightnessScores[brightness] || 50;
    factors.push({ name: 'Brightness', value: brightness, score, insight: `Brightness: ${brightness}. Bright thumbnails stand out in the YouTube feed.` });
  }

  // --- Factor 6: Eyebrows Raised (engagement signal) ---
  const eyebrowsRaised = !!analysis.eyebrows_raised;
  const eyebrowData = getBoolCtr('eyebrows_raised', eyebrowsRaised);
  let eyebrowScore = 60;
  let eyebrowInsight = '';
  if (hasEnoughData && eyebrowData.yes_count >= 3 && eyebrowData.no_count >= 3) {
    const relevantCtr = eyebrowsRaised ? eyebrowData.yes_ctr : eyebrowData.no_ctr;
    const global_avg = ((eyebrowData.yes_ctr * eyebrowData.yes_count) + (eyebrowData.no_ctr * eyebrowData.no_count)) / (eyebrowData.yes_count + eyebrowData.no_count);
    eyebrowScore = Math.min(90, Math.max(20, Math.round((relevantCtr / (global_avg || 1)) * 65)));
    eyebrowInsight = eyebrowsRaised
      ? `Raised eyebrows: ${eyebrowData.yes_ctr}% avg CTR vs ${eyebrowData.no_ctr}% without.`
      : `No raised eyebrows: ${eyebrowData.no_ctr}% avg CTR. Raised eyebrows signal surprise/excitement.`;
  } else {
    eyebrowScore = eyebrowsRaised ? 75 : 55;
    eyebrowInsight = eyebrowsRaised
      ? 'Raised eyebrows detected — signals surprise or excitement, which increases curiosity.'
      : 'No raised eyebrows. Exaggerated expression (raised eyebrows) can increase CTR.';
  }
  factors.push({ name: 'Eyebrows Raised', value: eyebrowsRaised ? 'Yes' : 'No', score: eyebrowScore, insight: eyebrowInsight });

  // --- Check A/B test winners for attribute matching ---
  let matchesWinners = false;
  try {
    // Find completed tests with a clear winner (highest CTR variant)
    const winnerAttrs = db.prepare(`
      SELECT ta.expression, ta.face_size, ta.primary_color, ta.has_text, ta.brightness
      FROM test_measurements tm
      JOIN test_variants tv ON tv.id = tm.variant_id
      JOIN thumbnail_analysis ta ON ta.video_id = (
        SELECT video_id FROM tests WHERE id = tm.test_id LIMIT 1
      )
      WHERE tm.ctr > 0
      GROUP BY tm.test_id
      HAVING tm.ctr = MAX(tm.ctr)
      LIMIT 50
    `).all() as any[];

    if (winnerAttrs.length >= 3) {
      // Check if this thumbnail matches the majority of winner attributes
      let matches = 0;
      let total = 0;
      for (const w of winnerAttrs) {
        if (w.expression) { total++; if (w.expression === analysis.expression) matches++; }
        if (w.face_size) { total++; if (w.face_size === analysis.face_size) matches++; }
        if (w.primary_color) { total++; if (w.primary_color === analysis.primary_color) matches++; }
        if (w.has_text !== null) { total++; if ((w.has_text === 1) === hasText) matches++; }
      }
      matchesWinners = total > 0 && (matches / total) >= 0.55;
    }
  } catch { /* winner matching is best-effort */ }

  // Overall score — weighted average (expression and face size weighted highest)
  const weights = [0.25, 0.20, 0.15, 0.15, 0.15, 0.10]; // expression, face size, color, text, brightness, eyebrows
  const weightedScore = factors.reduce((sum, f, i) => sum + f.score * (weights[i] || 0.1), 0);
  const score = Math.round(Math.min(97, Math.max(10, weightedScore)));

  return { score, factors, advice, matchesWinners };
}

const COMPARE_PROMPT = `You are a YouTube thumbnail A/B testing expert with access to data from hundreds of A/B tests. You are comparing thumbnail variants for the SAME video to predict which will get the highest click-through rate (CTR).

For each thumbnail, score it 0-100 and give differentiated scores — identical scores are useless for A/B testing. Consider:
- Emotional intensity and clarity of expression (not just "shocked" but HOW compelling)
- Visual hierarchy and where the eye lands first
- Color contrast and how it would stand out in a YouTube feed at small size (120x68px)
- Text readability at thumbnail size (if present)
- Composition balance and use of space
- Overall "scroll-stopping" power — would this make you pause in a feed?

Return ONLY a JSON array (no markdown, no explanation) with one object per thumbnail in order:
[
  {
    "index": 0,
    "score": 72,
    "strengths": ["clear emotional expression", "bold text visible at small size"],
    "weaknesses": ["background too busy", "face partially obscured"],
    "verdict": "one sentence on why this would or wouldn't get clicked"
  }
]

Be harsh and differentiated. A 5-point spread between similar thumbnails is meaningful. The best thumbnail should score highest, worst lowest. Never give identical scores.`;

/**
 * Build a data context string from actual A/B test results to guide the comparison.
 */
function getChannelCtrContext(): string {
  const db = getDb();
  try {
    // Get top-performing attribute combos from completed tests
    const topCombos = db.prepare(`
      SELECT ta.expression, ta.primary_color, ta.face_size, ta.has_text, ta.brightness,
        ROUND(AVG(tm.ctr), 2) as avg_ctr, COUNT(DISTINCT t.id) as test_count
      FROM thumbnail_analysis ta
      JOIN tests t ON t.video_id = ta.video_id
      JOIN test_variants tv ON tv.test_id = t.id
      JOIN test_measurements tm ON tm.variant_id = tv.id
      WHERE t.status = 'completed' AND tm.ctr > 0
      GROUP BY ta.expression, ta.primary_color, ta.face_size
      HAVING test_count >= 2
      ORDER BY avg_ctr DESC
      LIMIT 8
    `).all() as any[];

    if (topCombos.length < 3) return '';

    const lines = topCombos.map((r: any) =>
      `${r.expression} + ${r.primary_color} + ${r.face_size} face${r.has_text ? ' + text' : ''}: ${r.avg_ctr}% CTR (${r.test_count} tests)`
    );

    // Get overall channel avg CTR
    const avgRow = db.prepare(`
      SELECT ROUND(AVG(tm.ctr), 2) as avg FROM test_measurements tm
      JOIN tests t ON t.id = tm.test_id WHERE t.status = 'completed' AND tm.ctr > 0
    `).get() as any;

    return `\n\nCHANNEL A/B TEST DATA (real results from this channel):\nAverage CTR across all tests: ${avgRow?.avg || '?'}%\nTop performing combos:\n${lines.join('\n')}\n\nUse this data to inform your scoring — thumbnails matching high-CTR patterns should score higher.`;
  } catch {
    return '';
  }
}

/**
 * Head-to-head comparison of multiple thumbnails using Claude Vision.
 * Sends all images in a single prompt so Claude can compare directly.
 * Includes actual channel CTR data to ground the scoring.
 */
async function compareVariants(buffers: { buffer: Buffer; mediaType: string; filename: string }[]): Promise<any[]> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const sharp = (await import('sharp')).default;

  const content: any[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const { buffer, filename } = buffers[i];
    // Resize for Vision API
    let processed = await sharp(buffer)
      .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    if (processed.length > 4 * 1024 * 1024) {
      processed = await sharp(buffer).resize({ width: 1280, height: 720, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
    }

    content.push({
      type: 'text' as const,
      text: `Thumbnail ${i + 1} (${filename}):`,
    });
    content.push({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: processed.toString('base64') },
    });
  }

  const ctrContext = getChannelCtrContext();
  content.push({ type: 'text' as const, text: COMPARE_PROMPT + ctrContext });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content }],
  });

  try { logAiUsage({ app: 'yt-testing', feature: 'thumbnail-compare', user: 'unknown', model: 'claude-sonnet-4-6', usage: response.usage }); } catch {}

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in comparison response');
  return JSON.parse(jsonMatch[0]);
}

export async function scoreRoutes(app: FastifyInstance): Promise<void> {
  // All score routes require auth
  app.addHook('preHandler', authMiddleware);

  /**
   * POST /api/score/thumbnail
   * Accepts multipart image upload.
   * Returns CTR prediction score + analysis + factors + advice.
   */
  app.post('/score/thumbnail', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        reply.code(400).send({ detail: 'No file uploaded' });
        return;
      }

      // Read file buffer (stream must be consumed)
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        reply.code(400).send({ detail: 'Uploaded file is empty' });
        return;
      }

      // Determine media type from mimetype or default to jpeg
      const mediaType = (data.mimetype && data.mimetype.startsWith('image/')) ? data.mimetype : 'image/jpeg';

      // Run Claude Vision analysis
      const analysis = await visionAnalyzeBuffer(buffer, mediaType);

      // Compute CTR prediction
      const { score, factors, advice, matchesWinners } = computeCtrScore(analysis);

      return { score, analysis, factors, advice, matchesWinners };
    } catch (err: any) {
      console.error('[score/thumbnail] Error:', err.message);
      reply.code(500).send({ detail: err.message || 'Scoring failed' });
    }
  });

  /**
   * POST /api/score/title
   * Body: { title: string }
   * Returns viral score result from viral-score.ts.
   */
  app.post('/score/title', async (request, reply) => {
    const { title } = request.body as { title?: string };
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      reply.code(400).send({ detail: 'title is required' });
      return;
    }
    try {
      const result = scoreTitle(title.trim());
      return result;
    } catch (err: any) {
      console.error('[score/title] Error:', err.message);
      reply.code(500).send({ detail: err.message || 'Scoring failed' });
    }
  });

  /**
   * POST /api/score/title-preflight
   * Body: { title: string, content_type?: 'podcast' | 'TNTL', video_id?: string, test_id?: number }
   * Returns pre-flight score: A/B uplifts + corpus lift + winner similarity.
   * If video_id or test_id is provided, persists the prediction for calibration tracking.
   */
  app.post('/score/title-preflight', async (request, reply) => {
    const { title, content_type, video_id, test_id } = request.body as { title?: string; content_type?: string; video_id?: string; test_id?: number };
    if (!title?.trim()) { reply.code(400).send({ detail: 'title required' }); return; }
    try {
      const { preflightTitle } = await import('../services/title-preflight.js');
      const ctype = content_type === 'TNTL' ? 'TNTL' : content_type === 'podcast' ? 'podcast' : undefined;
      const result = preflightTitle(title.trim(), ctype as any);
      if (video_id || test_id) {
        try {
          const { savePrediction } = await import('../services/title-calibration.js');
          savePrediction({ videoId: video_id, testId: test_id ?? null, title: title.trim(), result });
        } catch {}
      }
      return result;
    } catch (err: any) {
      console.error('[score/title-preflight] Error:', err.message);
      reply.code(500).send({ detail: err.message || 'Preflight failed' });
    }
  });

  /**
   * GET /api/preflight/calibration
   * Returns prediction accuracy by band — how well the pre-flight model predicts real CTR outcomes.
   */
  app.get('/preflight/calibration', async (_request, reply) => {
    try {
      const { getCalibrationReport } = await import('../services/title-calibration.js');
      return getCalibrationReport();
    } catch (err: any) {
      console.error('[preflight/calibration] Error:', err.message);
      reply.code(500).send({ detail: err.message || 'Calibration report failed' });
    }
  });

  /**
   * POST /api/score/compare
   * Accepts multipart with multiple image fields (field name: "images").
   * Sends all images to Claude Vision in one prompt for direct head-to-head comparison.
   * Returns differentiated scores, strengths, weaknesses, and a predicted winner.
   */
  app.post('/score/compare', async (request, reply) => {
    try {
      const parts = request.files();
      const images: { buffer: Buffer; mediaType: string; filename: string }[] = [];

      for await (const part of parts) {
        if (!part.file) continue;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) continue;
        const mediaType = (part.mimetype && part.mimetype.startsWith('image/')) ? part.mimetype : 'image/jpeg';
        images.push({ buffer, mediaType, filename: part.filename || `image_${images.length}` });
      }

      if (images.length < 2) {
        reply.code(400).send({ detail: 'Need at least 2 images to compare' });
        return;
      }

      // Head-to-head comparison via Claude Vision
      const rankings = await compareVariants(images);

      // Map rankings to enriched results (skip individual analysis to save time/cost)
      const enriched = rankings.map((r: any, i: number) => ({
        index: r.index ?? i,
        filename: images[i]?.filename || `Thumbnail ${i + 1}`,
        score: r.score,
        strengths: r.strengths || [],
        weaknesses: r.weaknesses || [],
        verdict: r.verdict || '',
        analysis: {},
        factors: [],
      }));

      // Sort by score descending
      enriched.sort((a, b) => b.score - a.score);
      const winner = enriched[0];

      return {
        thumbnails: enriched,
        predicted_winner: {
          filename: winner.filename,
          score: winner.score,
          reason: winner.verdict,
        },
        key_differences: enriched.length >= 2
          ? [
              `${winner.filename} (${winner.score}) vs ${enriched[1].filename} (${enriched[1].score})`,
              ...winner.strengths.slice(0, 2).map((s: string) => `Winner: ${s}`),
              ...enriched[enriched.length - 1].weaknesses.slice(0, 2).map((w: string) => `Lowest: ${w}`),
            ]
          : [],
      };
    } catch (err: any) {
      console.error('[score/compare] Error:', err.message);
      reply.code(500).send({ detail: err.message || 'Comparison failed' });
    }
  });
}
