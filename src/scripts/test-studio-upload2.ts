import { getProfile, saveProfile } from '../services/browser-session.js';

const VIDEO_ID = 'S9emx1ur-Jg';
const IMAGE_PATH = '/Users/charlespatterson/Projects/yt-testing/uploads/3_A_vpXPtNfc.jpg';

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  console.log('Navigating to video editor...');
  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(6000);

  console.log('URL:', page.url());

  // Take screenshot to see what we're working with
  await page.screenshot({ path: '/tmp/studio-edit.png', fullPage: false });
  console.log('Screenshot saved to /tmp/studio-edit.png');

  // Look for all file inputs
  const fileInputs = await page.$$('input[type="file"]');
  console.log(`Found ${fileInputs.length} file inputs`);
  for (let i = 0; i < fileInputs.length; i++) {
    const accept = await fileInputs[i].getAttribute('accept');
    const id = await fileInputs[i].getAttribute('id');
    console.log(`  Input ${i}: accept="${accept}", id="${id}"`);
  }

  // Look for thumbnail-related buttons
  const buttons = await page.$$('button, ytcp-button');
  console.log(`Found ${buttons.length} buttons`);
  for (const btn of buttons) {
    const text = await btn.textContent();
    const ariaLabel = await btn.getAttribute('aria-label');
    if (text && (text.toLowerCase().includes('thumb') || text.toLowerCase().includes('upload') || text.toLowerCase().includes('custom'))) {
      console.log(`  Button: "${text.trim().substring(0, 60)}" aria="${ariaLabel}"`);
    }
  }

  // Look for the thumbnail section specifically
  const thumbSection = await page.$('#still-picker, [test-id="thumbnail-picker"], .thumbnail-editor');
  console.log('Thumbnail section found:', !!thumbSection);

  // Try to find the custom thumbnail upload via aria labels
  const uploadBtns = await page.$$('[aria-label*="thumbnail"], [aria-label*="Upload"], [aria-label*="custom"]');
  console.log(`Upload-related elements: ${uploadBtns.length}`);
  for (const el of uploadBtns) {
    const tag = await el.evaluate(e => e.tagName);
    const text = await el.textContent();
    const ariaLabel = await el.getAttribute('aria-label');
    console.log(`  ${tag}: "${text?.trim().substring(0, 40)}" aria="${ariaLabel}"`);
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
