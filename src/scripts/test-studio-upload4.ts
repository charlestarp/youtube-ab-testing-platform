import { getProfile, saveProfile } from '../services/browser-session.js';

const VIDEO_ID = 'S9emx1ur-Jg';
const IMAGE_PATH = '/Users/charlespatterson/Projects/yt-testing/uploads/3_A_vpXPtNfc.jpg';

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(6000);

  // YouTube Studio uses a hidden file input — set files directly on it
  // Then trigger the change event
  const result = await page.evaluate((imgPath) => {
    const input = document.querySelector('#file-loader') as HTMLInputElement;
    if (!input) return { error: 'no input found' };
    return {
      type: input.type,
      accept: input.accept,
      id: input.id,
      hidden: input.hidden,
      style: input.style.display,
      parentTag: input.parentElement?.tagName,
    };
  }, IMAGE_PATH);
  console.log('File input details:', result);

  // Use Playwright's setInputFiles which handles hidden inputs
  await page.setInputFiles('#file-loader', IMAGE_PATH);
  console.log('File set via setInputFiles');

  // Wait for processing
  console.log('Waiting 15s for thumbnail to process...');
  await page.waitForTimeout(15000);

  // Screenshot
  await page.screenshot({ path: '/tmp/studio-after-upload2.png' });

  // Check save button
  const saveState = await page.evaluate(() => {
    const container = document.querySelector('#save-button');
    if (!container) return 'no save container';
    const btn = container.querySelector('button, ytcp-button');
    if (!btn) return 'no inner button';
    return `disabled=${(btn as any).disabled}, aria=${btn.getAttribute('aria-disabled')}, text=${btn.textContent?.trim()}`;
  });
  console.log('Save state:', saveState);

  // Try clicking save
  try {
    await page.click('#save-button', { timeout: 5000 });
    console.log('Save clicked!');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/studio-after-save.png' });
    console.log('After save screenshot taken');
  } catch (err: any) {
    console.log('Could not click save:', err.message.substring(0, 100));
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
