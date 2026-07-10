/**
 * Test uploading a >2MB thumbnail via Playwright YouTube Studio.
 */
import { uploadThumbnailViaStudio } from '../services/youtube-studio-upload.js';

const VIDEO_ID = 'S9emx1ur-Jg'; // A Radio Station Has Reached Out (already published, safe to test)
const IMAGE_PATH = '/Users/charlespatterson/Projects/yt-testing/uploads/3_A_vpXPtNfc.jpg'; // 2.8MB

async function main() {
  console.log('Testing Studio thumbnail upload...');
  console.log(`Video: ${VIDEO_ID}`);
  console.log(`Image: ${IMAGE_PATH} (2.8MB)`);

  const success = await uploadThumbnailViaStudio(VIDEO_ID, IMAGE_PATH);
  console.log(`Result: ${success ? 'SUCCESS' : 'FAILED'}`);
  process.exit(success ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
