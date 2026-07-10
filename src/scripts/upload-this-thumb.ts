import { getProfile, saveProfile } from '../services/browser-session.js';

const VIDEO_ID = 'AbBak_3KARI'; // Toni Tries Killing 12 Hours In The Singapore Airport
const IMAGE = '/Volumes/TARPTOWER/TARP AUDIO and VIDEO/2026/PODCAST/260330/THUMBNAIL/EXPORTS/1.png';

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  console.log('Uploading 2.8MB thumbnail...');
  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(6000);

  await page.evaluate(() => {
    document.querySelectorAll('ytcp-thumbnail-editor, ytcp-thumbnail-uploader').forEach(el => el.removeAttribute('disabled'));
  });
  await page.setInputFiles('#file-loader', IMAGE);
  await page.evaluate(() => {
    const input = document.querySelector('#file-loader') as HTMLInputElement;
    if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  console.log('File set, waiting 12s for processing...');
  await page.waitForTimeout(12000);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const btns = await page.$$('button');
      for (const btn of btns) {
        const text = await btn.textContent();
        if (text?.trim() === 'Save' && !(await btn.isDisabled())) {
          await btn.click();
          break;
        }
      }
    } catch {}

    console.log(`Save attempt ${attempt}...`);
    await page.waitForTimeout(6000);

    const saved = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) { if (btn.textContent?.trim() === 'Save') return btn.disabled; }
      return false;
    });

    if (saved) {
      console.log('SUCCESS — thumbnail saved!');
      break;
    }

    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent?.trim() === 'Retry') (btn as HTMLElement).click();
      });
    });
    await page.waitForTimeout(5000);
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
