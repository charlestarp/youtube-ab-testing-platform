import { getProfile, saveProfile } from '../services/browser-session.js';

// Try on "A Snake in Toni's Shower" - unlikely to have A/B testing
const VIDEO_ID = '3wflNMZcgy0';
const IMAGE = '/Users/charlespatterson/Projects/yt-testing/uploads/3_B_60HXhI7v.jpg'; // 3.8MB

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  console.log('Loading video edit page...');
  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(6000);

  // Check for A/B Testing
  const hasAB = await page.evaluate(() => document.body.textContent?.includes('A/B Testing'));
  console.log('Has A/B Testing:', hasAB);

  // Screenshot before
  await page.screenshot({ path: '/tmp/clean-before.png' });

  // Remove disabled
  await page.evaluate(() => {
    document.querySelectorAll('ytcp-thumbnail-editor, ytcp-thumbnail-uploader').forEach(el => el.removeAttribute('disabled'));
  });

  // Upload
  await page.setInputFiles('#file-loader', IMAGE);
  await page.evaluate(() => {
    const input = document.querySelector('#file-loader') as HTMLInputElement;
    if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  console.log('File uploaded');

  await page.waitForTimeout(12000);
  await page.screenshot({ path: '/tmp/clean-after-upload.png' });

  // Check thumbnail section to see if it changed
  const thumbChanged = await page.evaluate(() => {
    const imgs = document.querySelectorAll('.thumbnail-editor img, ytcp-thumbnail-editor img');
    return Array.from(imgs).map(img => (img as HTMLImageElement).src.substring(0, 60));
  });
  console.log('Thumbnail images:', thumbChanged);

  // Check save state
  const undoVisible = await page.evaluate(() => {
    return document.body.textContent?.includes('Undo changes');
  });
  console.log('Undo changes visible (means changes pending):', undoVisible);

  // Try save
  if (undoVisible) {
    console.log('Changes detected — clicking Save...');
    try {
      await page.click('#save-button', { timeout: 5000 });
      console.log('Clicked #save-button');
    } catch {
      try {
        // Click the actual Save text/button at top right
        const saveEls = await page.$$('[id="save-button"], button');
        for (const el of saveEls) {
          const text = await el.textContent();
          if (text?.trim() === 'Save') {
            await el.click({ force: true });
            console.log('Clicked Save button element');
            break;
          }
        }
      } catch (e: any) {
        console.log('Could not click save:', e.message.substring(0, 80));
      }
    }

    await page.waitForTimeout(8000);

    // Check for errors
    const errorText = await page.evaluate(() => {
      const toast = document.querySelector('.error-message, [role="alert"], .paper-toast');
      return toast?.textContent?.trim() || document.body.textContent?.match(/trouble saving[^.]*\.?/)?.[0] || 'no error';
    });
    console.log('Error check:', errorText);

    await page.screenshot({ path: '/tmp/clean-after-save.png' });
  } else {
    console.log('No changes detected — upload may not have worked');
  }

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
