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

  // Scroll down to make sure thumbnail section is visible
  await page.evaluate(() => {
    const thumbSection = document.querySelector('ytcp-thumbnail-uploader');
    if (thumbSection) thumbSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await page.waitForTimeout(1000);

  // Click the "Upload file" button which should open the file picker
  // Then intercept the file chooser
  console.log('Looking for upload trigger...');

  // Method: Find and click the visible upload button, catch the file chooser
  const uploadArea = await page.$('button[aria-label="Upload file"]');
  if (!uploadArea) {
    console.log('No upload button found');
    process.exit(1);
  }

  // Playwright can intercept file choosers even from web components
  page.on('filechooser', async (chooser) => {
    console.log('File chooser intercepted!');
    await chooser.setFiles(IMAGE_PATH);
  });

  // Force the click with JavaScript to bypass disabled state
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Upload file"]') as HTMLElement;
    if (btn) {
      // Remove disabled if present
      btn.removeAttribute('disabled');
      btn.click();
    }
  });

  console.log('Upload button clicked via JS');
  await page.waitForTimeout(3000);

  // If file chooser didn't fire, try directly setting on the input and dispatching change
  const uploaded = await page.evaluate(() => {
    const uploader = document.querySelector('ytcp-thumbnail-uploader');
    return uploader ? uploader.innerHTML.substring(0, 200) : 'not found';
  });
  console.log('Uploader HTML:', uploaded);

  // Try the direct input approach with change event dispatch
  await page.setInputFiles('#file-loader', IMAGE_PATH);
  await page.evaluate(() => {
    const input = document.querySelector('#file-loader') as HTMLInputElement;
    if (input) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  console.log('Dispatched change+input events');

  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/studio-upload5.png' });

  // Check if thumbnail changed
  const thumbs = await page.$$eval('img', imgs =>
    imgs.filter(i => i.src.includes('ytimg') || i.src.includes('thumbnail') || i.src.includes('blob:'))
      .map(i => ({ src: i.src.substring(0, 80), width: i.width, height: i.height }))
  );
  console.log('Thumbnail images:', thumbs);

  // Try the Save/Undo changes buttons at the top
  const topSave = await page.$('button:has-text("Save")');
  if (topSave) {
    const isDisabled = await topSave.isDisabled();
    console.log(`Top Save button found, disabled=${isDisabled}`);
    if (!isDisabled) {
      await topSave.click();
      console.log('Save clicked!');
      await page.waitForTimeout(5000);
    }
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
