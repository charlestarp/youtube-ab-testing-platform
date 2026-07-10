/**
 * Comment scraper — fetches YouTube comments for social listening.
 * Tracks sentiment, topics, and mentions of the channel.
 */

import { getDb } from '../db/client.js';
import { getVideoComments } from './youtube-api.js';
import { config } from '../config.js';

const MENTION_KEYWORDS = ['the channel', 'toni & ryan', 'the channel', 'tarpgpt', 'toni ryan'];

/**
 * Scrape comments for our channel's recent videos and competitor videos.
 */
export async function scrapeComments(): Promise<{ scraped: number; mentions: number }> {
  const db = getDb();
  let totalScraped = 0;
  let totalMentions = 0;

  // Get our recent videos from youtube.db
  try {
    const ourVideos = db.prepare(
      'SELECT video_id FROM yt.videos ORDER BY publish_date DESC LIMIT 30'
    ).all() as any[];

    for (const v of ourVideos) {
      const count = await scrapeVideoComments(v.video_id, config.youtubeChannelId, false);
      totalScraped += count.scraped;
      totalMentions += count.mentions;
    }
  } catch (err: any) {
    console.error(`[comments] Error scraping our videos: ${err.message}`);
  }

  // Get competitor videos
  try {
    const compVideos = db.prepare(
      'SELECT cv.video_id, c.channel_id FROM competitor_videos cv JOIN competitors c ON cv.competitor_id = c.id ORDER BY cv.published_at DESC LIMIT 20'
    ).all() as any[];

    for (const v of compVideos) {
      const count = await scrapeVideoComments(v.video_id, v.channel_id, true);
      totalScraped += count.scraped;
      totalMentions += count.mentions;
    }
  } catch (err: any) {
    // Competitor table might not have data yet
    if (!err.message.includes('no such table')) {
      console.error(`[comments] Error scraping competitor videos: ${err.message}`);
    }
  }

  console.log(`[comments] Scraped ${totalScraped} new comments, ${totalMentions} mentions`);
  return { scraped: totalScraped, mentions: totalMentions };
}

async function scrapeVideoComments(
  videoId: string,
  channelId: string,
  checkMentions: boolean
): Promise<{ scraped: number; mentions: number }> {
  const db = getDb();
  let scraped = 0;
  let mentions = 0;

  try {
    const comments = await getVideoComments(videoId, 100);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO comments (comment_id, video_id, channel_id, author, author_channel_url, author_profile_image, content, like_count, published_at, sentiment, mentions_us)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of comments) {
      const contentLower = c.content.toLowerCase();

      // Simple sentiment analysis via keyword matching
      const sentiment = analyzeSentiment(contentLower);

      // Check for mentions of the channel
      const mentionsUs = checkMentions && MENTION_KEYWORDS.some(kw => contentLower.includes(kw)) ? 1 : 0;
      if (mentionsUs) mentions++;

      const result = insert.run(c.commentId, videoId, channelId, c.author,
        c.authorChannelUrl || null, c.authorProfileImage || null,
        c.content, c.likeCount, c.publishedAt, sentiment, mentionsUs);
      if (result.changes > 0) scraped++;
    }
  } catch (err: any) {
    // Comments might be disabled
    if (!err.message.includes('commentsDisabled')) {
      console.error(`[comments] Error for ${videoId}: ${err.message}`);
    }
  }

  return { scraped, mentions };
}

/**
 * Simple keyword-based sentiment analysis.
 * Returns 'positive', 'negative', or 'neutral'.
 */
function analyzeSentiment(text: string): string {
  const positive = ['love', 'amazing', 'hilarious', 'funny', 'great', 'awesome', 'best',
    'incredible', 'brilliant', 'perfect', 'haha', 'lmao', 'lol', 'favourite', 'favorite',
    'beautiful', 'wonderful', 'excellent', 'thank', 'legend'];
  const negative = ['hate', 'terrible', 'awful', 'worst', 'boring', 'annoying', 'bad',
    'cringe', 'clickbait', 'disappointing', 'unfunny', 'trash', 'garbage', 'unsubscribe'];

  let posScore = 0;
  let negScore = 0;

  for (const word of positive) {
    if (text.includes(word)) posScore++;
  }
  for (const word of negative) {
    if (text.includes(word)) negScore++;
  }

  if (posScore > negScore) return 'positive';
  if (negScore > posScore) return 'negative';
  return 'neutral';
}
