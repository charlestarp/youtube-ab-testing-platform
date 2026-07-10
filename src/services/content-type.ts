/**
 * Content type classifier. The channel makes two very different kinds of video
 * and they must never be pooled: Try Not To Laugh / reaction videos average far
 * more views than the regular podcast, so a "good" title or thumbnail means
 * different things for each.
 *
 *   podcast  — the regular podcast episodes (default bucket)
 *   TNTL     — Try Not To Laugh / reaction videos (youtube.db category 'reaction')
 */
export type ContentType = 'podcast' | 'TNTL';

export function classifyContent(title?: string | null, category?: string | null): ContentType {
  const c = (category || '').toLowerCase();
  if (c === 'reaction') return 'TNTL';
  if (c === 'podcast') return 'podcast';
  if (/try not to laugh/i.test(title || '')) return 'TNTL';
  return 'podcast';
}

export const CONTENT_LABEL: Record<ContentType, string> = {
  podcast: 'Podcast',
  TNTL: 'Try Not To Laugh',
};
