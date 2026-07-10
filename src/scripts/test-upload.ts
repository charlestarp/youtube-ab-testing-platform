import { uploadThumbnailViaStudio } from '../services/youtube-studio-upload.js';

const videoId = process.argv[2] || 'qlhmLu30Axc';
const imagePath = process.argv[3] || './uploads/24_B_TfMSRZJT.jpg';

console.log(`Testing upload: ${videoId} with ${imagePath}`);
const ok = await uploadThumbnailViaStudio(videoId, imagePath);
console.log('Result:', ok);
process.exit(ok ? 0 : 1);
