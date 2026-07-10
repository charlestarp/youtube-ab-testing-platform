import { getProfile, saveProfile } from '../services/browser-session.js';

const VIDEO_ID = '3wflNMZcgy0'; // A Snake in Toni's Shower
const IMAGE = '/Users/charlespatterson/Projects/yt-testing/uploads/3_B_60HXhI7v.jpg';

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(6000);

  // Upload the thumbnail
  await page.evaluate(() => {
    document.querySelectorAll('ytcp-thumbnail-editor, ytcp-thumbnail-uploader').forEach(el => el.removeAttribute('disabled'));
  });
  await page.setInputFiles('#file-loader', IMAGE);
  await page.evaluate(() => {
    const input = document.querySelector('#file-loader') as HTMLInputElement;
    if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  console.log('File uploaded, waiting for processing...');
  await page.waitForTimeout(12000);

  // Try saving with multiple approaches
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`\nSave attempt ${attempt}...`);

    // Click save
    try {
      const saveButtons = await page.$$('button');
      for (const btn of saveButtons) {
        const text = await btn.textContent();
        if (text?.trim() === 'Save') {
          const disabled = await btn.isDisabled();
          if (!disabled) {
            await btn.click();
            console.log('Clicked Save');
            break;
          }
        }
      }
    } catch {}

    await page.waitForTimeout(6000);

    // Check if save succeeded (save button becomes disabled/greyed)
    const saveDisabled = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent?.trim() === 'Save') return btn.disabled;
      }
      return 'not found';
    });
    console.log(`Save button disabled: ${saveDisabled}`);

    if (saveDisabled === true) {
      console.log('SAVE SUCCEEDED!');
      break;
    }

    // Check for error and click Retry
    const hasRetry = await page.evaluate(() => {
      const retryBtn = document.querySelector('button');
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        if (btn.textContent?.trim() === 'Retry') {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (hasRetry) console.log('Clicked Retry');

    await page.waitForTimeout(5000);
  }

  await page.screenshot({ path: '/tmp/upload-final-state.png' });
  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
