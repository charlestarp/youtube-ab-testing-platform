import { readFileSync } from 'fs';
import { setThumbnail } from '../services/studio-thumbnail.js';
const [videoId, file] = process.argv.slice(2);
if (!videoId || !file) { console.error('usage: set-thumbnail <videoId> <imageFile> [mime]'); process.exit(1); }
const buf = readFileSync(file);
// detect mime from magic bytes
let mime = process.argv[4] || (buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg');
console.log(`uploading ${file} (${buf.length} bytes, ${mime}) -> video ${videoId}`);
setThumbnail(videoId, buf, mime).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 2); })
  .catch(e => { console.error('FAILED:', e.message); process.exit(1); });
