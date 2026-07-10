import { chromium } from 'playwright';
import { spawn, execSync } from 'child_process';

const PROFILE = process.env.HOME + '/Projects/socials/data/browser-profiles/youtube-studio';
try { execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null'); } catch {}
try { execSync(`rm -f "${PROFILE}/SingletonLock" 2>/dev/null`); } catch {}
await new Promise(r => setTimeout(r, 2000));

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--remote-debugging-port=9222', `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--profile-directory=Default',
  '--window-size=1400,900'
], { stdio: 'ignore', detached: true });
chrome.unref();

for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 1000));
  try { const r = await fetch('http://localhost:9222/json/version'); if (r.ok) break; } catch {}
}

const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();

await page.goto('https://studio.youtube.com/video/xe3viwHTTJY/edit?c=UCkhy7g4GvHuzhbzTVjc8izQ', {
  waitUntil: 'domcontentloaded', timeout: 30000,
});
await page.waitForTimeout(8000);

console.log('URL:', page.url());
await page.screenshot({ path: '/tmp/studio-edit-page.png', fullPage: false, timeout: 10000 });
console.log('Screenshot saved to /tmp/studio-edit-page.png');

// Check buttons
const buttons = await page.evaluate(() => {
  const btns = document.querySelectorAll('button');
  return Array.from(btns).map(b => ({
    text: b.textContent?.trim().substring(0, 50),
    disabled: b.disabled,
  })).filter(b => b.text && b.text.length > 0);
});
console.log('Buttons:', JSON.stringify(buttons));

// Check file input
const fileInput = await page.$('#file-loader');
console.log('File input found:', !!fileInput);

await browser.close();
try { execSync('pkill -f "remote-debugging-port=9222" 2>/dev/null'); } catch {}
process.exit(0);
