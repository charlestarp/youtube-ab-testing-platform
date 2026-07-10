/**
 * CLI for the auto-tagger.
 *   npx tsx src/scripts/autotag-cli.ts --limit 6 --dry      # preview, no writes
 *   npx tsx src/scripts/autotag-cli.ts --all                # backfill all untagged
 *   npx tsx src/scripts/autotag-cli.ts --ids 6,7,8 --dry    # specific variants
 */
import { autoTagBatch, autoTagVariant, reclassifyTweets } from '../services/auto-tagger.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const dryRun = has('--dry');
const idsArg = val('--ids');

async function main() {
  if (has('--reclassify-tweets')) {
    const changes = await reclassifyTweets({ dryRun });
    for (const c of changes) console.log(`  v${c.variant_id}: ${c.from.join(',') || '(none)'} -> ${c.to || '(removed)'}`);
    console.log(`\n${dryRun ? '[DRY RUN] ' : ''}${changes.length} tweet tags reclassified`);
    process.exit(0);
  }

  let results;
  if (idsArg) {
    const ids = idsArg.split(',').map(s => parseInt(s.trim()));
    results = [];
    for (const id of ids) results.push(await autoTagVariant(id, { dryRun }));
  } else {
    const limit = has('--all') ? undefined : parseInt(val('--limit') || '6');
    results = await autoTagBatch({ limit, onlyUntagged: true, dryRun, concurrency: 5 });
  }

  let tagged = 0, errors = 0, tagCount = 0;
  for (const r of results) {
    if (r.error) { errors++; console.log(`  v${r.variant_id}: ERROR ${r.error}`); continue; }
    if (r.applied.length) tagged++;
    tagCount += r.applied.length;
    const skip = r.skipped.length ? `  (skipped: ${r.skipped.join(', ')})` : '';
    console.log(`  v${r.variant_id}: ${r.applied.join(', ') || '(none)'}${skip}`);
  }
  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}${results.length} variants, ${tagged} tagged, ${tagCount} tags total, ${errors} errors`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
