import { uploadThumbnailViaStudio } from '../services/youtube-studio-upload.js';

const VIDEO_ID = 'AbBak_3KARI'; // Toni Tries Killing 12 Hours In The Singapore Airport
const IMAGE = '/Users/charlespatterson/Projects/yt-testing/uploads/3_B_60HXhI7v.jpg'; // 3.8MB

async function main() {
  console.log('Uploading 3.8MB thumbnail to Singapore Airport video via Studio...');
  const success = await uploadThumbnailViaStudio(VIDEO_ID, IMAGE);
  console.log(success ? 'SUCCESS — thumbnail uploaded at full quality!' : 'FAILED');
  process.exit(success ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
