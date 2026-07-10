import { uploadThumbnailViaStudio } from '../services/youtube-studio-upload.js';

// Test on "What Do You Call A Guy With One Foot" - the one that showed the blue Save button
const VIDEO_ID = '6JPm86UNAiw';
const IMAGE_PATH = '/Users/charlespatterson/Projects/yt-testing/uploads/3_B_60HXhI7v.jpg'; // 3.8MB

async function main() {
  console.log(`Uploading ${IMAGE_PATH} (3.8MB) to ${VIDEO_ID} via Studio...`);
  const success = await uploadThumbnailViaStudio(VIDEO_ID, IMAGE_PATH);
  console.log(`Result: ${success ? 'SUCCESS' : 'FAILED'}`);
  process.exit(success ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
