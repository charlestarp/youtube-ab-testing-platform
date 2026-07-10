import { getProfile, saveProfile } from '../services/browser-session.js';

// Use a different video that's NOT being A/B tested
const VIDEO_ID = '6JPm86UNAiw'; // Who Pooped In My Sister's Garden
const IMAGE_PATH = '/Users/charlespatterson/Projects/yt-testing/uploads/3_A_vpXPtNfc.jpg';

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(6000);

  // Check if uploader is disabled
  const uploaderState = await page.evaluate(() => {
    const uploader = document.querySelector('ytcp-thumbnail-uploader ytcp-thumbnail-editor');
    return {
      found: !!uploader,
      disabled: uploader?.getAttribute('disabled'),
      hasAbTest: !!document.querySelector('[class*="ab-test"], [class*="a-b"]'),
    };
  });
  console.log('Uploader state:', uploaderState);

  if (uploaderState.disabled !== null) {
    // Remove disabled attribute
    await page.evaluate(() => {
      const editor = document.querySelector('ytcp-thumbnail-uploader ytcp-thumbnail-editor');
      if (editor) editor.removeAttribute('disabled');
      const uploader = document.querySelector('ytcp-thumbnail-uploader');
      if (uploader) uploader.removeAttribute('disabled');
    });
    console.log('Removed disabled attribute');
    await page.waitForTimeout(1000);
  }

  // Now try clicking upload
  const uploadBtn = await page.$('button[aria-label="Upload file"]');
  if (uploadBtn) {
    const isDisabled = await uploadBtn.isDisabled();
    console.log(`Upload button disabled: ${isDisabled}`);

    if (isDisabled) {
      await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Upload file"]') as HTMLButtonElement;
        if (btn) { btn.disabled = false; btn.removeAttribute('disabled'); }
      });
      console.log('Force-enabled upload button');
    }

    // Try file chooser approach
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        page.click('button[aria-label="Upload file"]'),
      ]);
      await fileChooser.setFiles(IMAGE_PATH);
      console.log('File set via file chooser!');
    } catch {
      console.log('File chooser didnt fire, trying setInputFiles');
      await page.setInputFiles('#file-loader', IMAGE_PATH);
      await page.evaluate(() => {
        const input = document.querySelector('#file-loader') as HTMLInputElement;
        if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }

  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/studio-upload6.png' });

  const saveDisabled = await page.evaluate(() => {
    const save = document.querySelector('#save-button button, button:has-text("Save")') as HTMLButtonElement | null;
    return save ? save.disabled : 'not found';
  });
  console.log('Save disabled:', saveDisabled);

  if (saveDisabled === false) {
    await page.click('#save-button button');
    console.log('SAVE CLICKED!');
    await page.waitForTimeout(5000);
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
