import { getProfile, saveProfile } from '../services/browser-session.js';

const VIDEO_ID = 'AbBak_3KARI';
const IMAGE = '/Users/charlespatterson/Projects/yt-testing/uploads/3_B_60HXhI7v.jpg';

async function main() {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  await page.goto(`https://studio.youtube.com/video/${VIDEO_ID}/edit`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(6000);

  // Screenshot before
  await page.screenshot({ path: '/tmp/singapore-before.png' });
  console.log('Before screenshot saved');

  // Remove disabled from uploader
  await page.evaluate(() => {
    document.querySelectorAll('ytcp-thumbnail-editor, ytcp-thumbnail-uploader').forEach(el => el.removeAttribute('disabled'));
  });

  // Set file
  await page.setInputFiles('#file-loader', IMAGE);
  await page.evaluate(() => {
    const input = document.querySelector('#file-loader') as HTMLInputElement;
    if (input) input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  console.log('File set');

  // Wait for processing
  await page.waitForTimeout(15000);

  // Screenshot after upload
  await page.screenshot({ path: '/tmp/singapore-after-upload.png' });
  console.log('After upload screenshot saved');

  // Check save button state
  const saveState = await page.evaluate(() => {
    // Check all potential save buttons
    const results: string[] = [];
    const allBtns = document.querySelectorAll('button, ytcp-button');
    allBtns.forEach(btn => {
      const text = btn.textContent?.trim() || '';
      if (text.includes('Save') || text.includes('Undo')) {
        const disabled = (btn as HTMLButtonElement).disabled;
        const ariaDisabled = btn.getAttribute('aria-disabled');
        results.push(`"${text.substring(0, 30)}" disabled=${disabled} aria=${ariaDisabled}`);
      }
    });
    return results;
  });
  console.log('Save-related buttons:', saveState);

  // Try clicking Save
  try {
    const saveBtn = await page.$('#save-button');
    if (saveBtn) {
      const box = await saveBtn.boundingBox();
      console.log('Save button box:', box);
      await saveBtn.click({ force: true });
      console.log('Clicked #save-button');
    }
  } catch (e: any) {
    console.log('Click #save-button failed:', e.message.substring(0, 80));
  }

  await page.waitForTimeout(3000);

  // Try the top-right "Save" text
  try {
    const saves = await page.$$('text=Save');
    console.log(`Found ${saves.length} "Save" elements`);
    for (let i = 0; i < saves.length; i++) {
      const box = await saves[i].boundingBox();
      const text = await saves[i].textContent();
      console.log(`  Save ${i}: "${text?.trim()}" box:`, box);
    }
    if (saves.length > 0) {
      await saves[saves.length - 1].click({ force: true });
      console.log('Clicked last Save element');
    }
  } catch (e: any) {
    console.log('Click Save text failed:', e.message.substring(0, 80));
  }

  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/singapore-after-save.png' });
  console.log('After save screenshot saved');

  await saveProfile('youtube-studio');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
