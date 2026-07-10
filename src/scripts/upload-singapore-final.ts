import { getProfile, saveProfile } from '../services/browser-session.js';

const VIDEO_ID = 'AbBak_3KARI';
const IMAGE = '/Users/charlespatterson/Projects/yt-testing/uploads/3_A_vpXPtNfc.jpg'; // 2.8MB

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

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
  console.log('File uploaded, waiting 12s...');
  await page.waitForTimeout(12000);

  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`Save attempt ${attempt}...`);
    try {
      const saveButtons = await page.$$('button');
      for (const btn of saveButtons) {
        const text = await btn.textContent();
        if (text?.trim() === 'Save') {
          const disabled = await btn.isDisabled();
          if (!disabled) { await btn.click(); console.log('Clicked Save'); break; }
        }
      }
    } catch {}

    await page.waitForTimeout(6000);

    const saveDisabled = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) { if (btn.textContent?.trim() === 'Save') return btn.disabled; }
      return 'not found';
    });

    if (saveDisabled === true) { console.log('SAVE SUCCEEDED!'); break; }

    // Click Retry if visible
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent?.trim() === 'Retry') (btn as HTMLElement).click();
      });
    });
    await page.waitForTimeout(5000);
  }

  await page.screenshot({ path: '/tmp/singapore-final.png' });
  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
