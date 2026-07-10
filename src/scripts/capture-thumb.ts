/**
 * ONE-TIME capture: auto-drive Firefox to SET a thumbnail in Studio and record the EXACT
 * youtubei requests, so we can replicate the commit server-side. Headless, no interaction.
 *   npx tsx src/scripts/capture-thumb.ts <videoId> <imageFile>
 */
import { firefox } from 'playwright';
import { resolve } from 'path';
import { writeFileSync, existsSync, cpSync } from 'fs';

const VIDEO = process.argv[2] || 'zhhch4nTlXI';
const IMAGE = resolve(process.argv[3] || 'uploads/161_D_QkGrvb9G.jpg');
const MASTER = resolve(import.meta.dirname, '../../data/firefox-studio');
const WORK = resolve(import.meta.dirname, '../../data/firefox-studio-work');
const OUT = resolve(import.meta.dirname, '../../data/thumb-capture.json');

(async () => {
  if (!existsSync(WORK) && existsSync(MASTER)) cpSync(MASTER, WORK, { recursive: true });
  const ctx = await firefox.launchPersistentContext(WORK, { headless: true, viewport: { width: 1400, height: 950 }, timeout: 30000 });

  const captured: any[] = [];
  ctx.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const url = req.url();
    if (url.includes('youtubei/v1')) {
      let body = ''; try { body = req.postData() || ''; } catch {}
      captured.push({ url, body: body.slice(0, 20000), headers: req.headers() });
      console.log('[capture] youtubei:', url.split('?')[0].split('/youtubei/v1/')[1], 'bodyLen', body.length);
    } else if (url.includes('upload.youtube.com')) {
      captured.push({ url, body: '(binary omitted)', headers: req.headers() });
      console.log('[capture] upload:', url.split('?')[0]);
    }
  });
  const save = () => writeFileSync(OUT, JSON.stringify(captured, null, 2));

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`https://studio.youtube.com/video/${VIDEO}/edit`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  const loggedIn = !page.url().includes('accounts.google.com') && !(await page.locator('text=Sign in').count().catch(() => 0));
  console.log('signed in:', loggedIn, '| url:', page.url().slice(0, 60));

  for (const sel of ['ytcp-thumbnail-default-image', 'button[aria-label*="thumbnail" i]', '.thumbnail-container button', '#thumbnail-section button']) {
    try { const b = page.locator(sel).first(); if (await b.count()) { await b.click({ timeout: 3000 }); console.log('clicked', sel); break; } } catch {}
  }
  await page.waitForTimeout(1500);
  // #file-loader is hidden — set files directly without waiting for visibility.
  try {
    await page.setInputFiles('#file-loader', IMAGE, { strict: false } as any);
    console.log('thumbnail file set on #file-loader');
  } catch (e: any) {
    try { await page.setInputFiles('input[type="file"][accept*="image"]', IMAGE); console.log('thumbnail file set on accept input'); }
    catch (e2: any) { console.log('file-set issue:', e2.message); }
  }
  // wait for the scotty upload + crop dialog to process
  await page.waitForTimeout(8000);
  // a crop/confirm "Done" dialog may appear
  for (const sel of ['ytcp-button:has-text("Done")', 'button:has-text("Done")', 'tp-yt-paper-dialog #done']) {
    try { const b = page.locator(sel).first(); if (await b.count() && await b.isVisible()) { await b.click({ timeout: 3000 }); console.log('clicked crop Done:', sel); break; } } catch {}
  }
  await page.waitForTimeout(3000);
  save();

  for (const sel of ['#save', 'ytcp-button#save', 'button[aria-label="Save"]', 'ytcp-button[aria-label="Save"]']) {
    try { const b = page.locator(sel).first(); if (await b.count() && await b.isEnabled()) { await b.click({ timeout: 4000 }); console.log('clicked Save:', sel); break; } } catch {}
  }
  await page.waitForTimeout(12000);
  save();
  console.log(`\ncaptured ${captured.length} -> ${OUT}`);
  console.log('youtubei endpoints:', [...new Set(captured.filter(c => c.url.includes('youtubei')).map(c => c.url.split('?')[0].split('/youtubei/v1/')[1]))].join(', '));
  await ctx.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
