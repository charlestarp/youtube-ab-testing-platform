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

  // Find the "Upload file" button in the thumbnail section
  const uploadBtn = await page.$('button[aria-label="Upload file"]');
  if (uploadBtn) {
    console.log('Found Upload file button');
    // Use file chooser
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      uploadBtn.click(),
    ]);
    await fileChooser.setFiles(IMAGE_PATH);
    console.log('File set via file chooser');
  } else {
    console.log('No Upload file button found, trying #file-loader directly');
    const fl = await page.$('#file-loader');
    if (fl) {
      await fl.setInputFiles(IMAGE_PATH);
      console.log('File set via #file-loader');
    }
  }

  // Wait for processing
  console.log('Waiting for thumbnail to process...');
  await page.waitForTimeout(10000);

  // Screenshot to see result
  await page.screenshot({ path: '/tmp/studio-after-upload.png' });
  console.log('Screenshot: /tmp/studio-after-upload.png');

  // Check if Save is now enabled
  const saveEnabled = await page.evaluate(() => {
    const btn = document.querySelector('#save-button') as any;
    const inner = btn?.querySelector('button') as HTMLButtonElement | null;
    return {
      found: !!btn,
      innerFound: !!inner,
      disabled: inner?.disabled,
      ariaDisabled: inner?.getAttribute('aria-disabled'),
      text: btn?.textContent?.trim(),
    };
  });
  console.log('Save button state:', saveEnabled);

  if (!saveEnabled.disabled) {
    const saveBtn = await page.$('#save-button button');
    if (saveBtn) {
      await saveBtn.click();
      console.log('Save clicked!');
      await page.waitForTimeout(5000);
    }
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
