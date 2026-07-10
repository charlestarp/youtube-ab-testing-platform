/**
 * Backfill title tags for all videos + title-test variants.
 *   npx tsx src/scripts/title-tag-cli.ts            # rules + semantic (Claude)
 *   npx tsx src/scripts/title-tag-cli.ts --no-ai    # rules only, no Claude
 */
import { tagAllVideos, tagAllVariants, ensureTitleSchema } from '../services/title-tagger.js';

const semantic = !process.argv.includes('--no-ai');

async function main() {
  ensureTitleSchema();
  console.log(`Tagging video titles (semantic=${semantic})...`);
  const v = await tagAllVideos({ semantic });
  console.log(`  videos: ${v.subjects}, rule tags: ${v.rule_tags}, semantic tags: ${v.semantic_tags}`);
  console.log(`Tagging title-test variants...`);
  const t = await tagAllVariants({ semantic });
  console.log(`  variants: ${t.subjects}, rule tags: ${t.rule_tags}, semantic tags: ${t.semantic_tags}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
