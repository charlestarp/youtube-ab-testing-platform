/**
 * Debug script: scrape YouTube Studio Reach tab and dump all JSON responses.
 */
import { getProfile, saveProfile } from '../services/browser-session.js';
import { mkdirSync, writeFileSync } from 'fs';

const VIDEO_ID = 'S9emx1ur-Jg'; // A Radio Station Has Reached Out

async function main() {
  console.log('Getting browser session...');
  const session = await getProfile('youtube-studio');
  const { page } = session;

  const captured: { url: string; data: any }[] = [];

  page.on('response', async (response: any) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    if (url.includes('log_event') || url.includes('heartbeat') || url.includes('generate_204')) return;

    try {
      let text = await response.text();
      if (text.length < 200) return;
      if (text.startsWith(")]}'")) text = text.substring(text.indexOf('\n') + 1);
      const json = JSON.parse(text);
      const shortUrl = url.split('?')[0].split('/').slice(-2).join('/');
      captured.push({ url: shortUrl, data: json });
      console.log(`  Captured: ${shortUrl} (${text.length} bytes)`);
    } catch {}
  });

  // First go to the analytics overview so the page is fully loaded
  console.log('Loading analytics overview...');
  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/analytics/tab-overview`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(6000);
  console.log(`  Captured ${captured.length} responses from overview`);

  // Now navigate to Reach tab with "First 24 hours" period
  console.log('Navigating to Reach tab (First 24 hours)...');
  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/analytics/tab-reach_viewers/period-since-publish,time_period_unit-nth_days,1`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(8000);
  console.log(`  Captured ${captured.length} total responses after reach`);

  await saveProfile('youtube-studio');

  // Dump all captured responses
  const debugDir = `${process.cwd()}/data/yt-studio-debug`;
  mkdirSync(debugDir, { recursive: true });

  for (let i = 0; i < captured.length; i++) {
    const fname = `reach_${VIDEO_ID}_${captured[i].url.replace(/[^a-zA-Z0-9]/g, '_')}_${i}.json`;
    writeFileSync(`${debugDir}/${fname}`, JSON.stringify(captured[i].data, null, 2));
  }

  console.log(`\nDumped ${captured.length} responses to ${debugDir}/`);

  // Also search for any impression/CTR related data
  for (const { url, data } of captured) {
    if (!data.cards) continue;
    for (const card of data.cards) {
      const cfg = card.config || {};

      // Key metrics
      if (cfg.keyMetricCardConfig && card.keyMetricCardData?.keyMetricTabs) {
        for (const tab of card.keyMetricCardData.keyMetricTabs) {
          const metric = tab.primaryContent?.metric;
          const total = tab.primaryContent?.total;
          const chartData = tab.primaryContent?.mainChartData;
          console.log(`  Metric: ${metric} = ${total}`);
          if (chartData?.metricColumns?.[0]?.counts?.values) {
            const vals = chartData.metricColumns[0].counts.values;
            console.log(`    Chart data: ${vals.length} points: [${vals.slice(0, 10).join(', ')}...]`);
          }
        }
      }

      // Line chart cards
      if (cfg.lineChartCardConfig && card.lineChartCardData) {
        const lcd = card.lineChartCardData;
        console.log(`  LineChart: metric=${lcd.metric || cfg.lineChartCardConfig.metric || '?'}`);
        if (lcd.metricColumns) {
          for (const col of lcd.metricColumns) {
            console.log(`    Column: ${col.metric?.type || '?'} — ${col.counts?.values?.length || 0} values`);
          }
        }
      }

      // Any card with "impression" in config keys
      for (const key of Object.keys(cfg)) {
        if (key.toLowerCase().includes('impression') || key.toLowerCase().includes('reach')) {
          console.log(`  Found config key: ${key}`);
        }
      }
    }
  }

  // Close
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
