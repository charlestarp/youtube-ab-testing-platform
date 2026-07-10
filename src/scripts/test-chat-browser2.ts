import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const session = 'm_QvJZcy3uJvLJF2obPgaNHp9X8bwFfuYO6WzgjkfFLA9XE8';
  await page.context().addCookies([{
    name: 'session', value: session, domain: 'app.example.com', path: '/',
  }]);

  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('Error') || t.includes('error') || t.includes('stream')) {
      console.log(`[CONSOLE ${msg.type()}]`, t.substring(0, 200));
    }
  });

  page.on('requestfailed', req => {
    console.log('[FAILED]', req.url().substring(0, 80), req.failure()?.errorText);
  });

  await page.goto('https://app.example.com/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const input = await page.$('input[placeholder*="analytics"]');
  if (!input) { console.log('No input found'); await browser.close(); return; }

  await input.fill('Score this title: Toni Tries To Be A Flight Attendant');
  const sendBtn = await page.$('button:has-text("Send")');
  await sendBtn?.click();
  console.log('Sent title analysis request...');

  // Wait longer for tools
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const lastMsg = await page.$eval('[class*="rounded-2xl"]:last-of-type', el => el.textContent?.substring(0, 100) || '');
    console.log(`[${(i+1)*5}s] Last msg: "${lastMsg.substring(0, 80)}"`);
    if (lastMsg.includes('Score:') || lastMsg.includes('##') || lastMsg.length > 200) {
      console.log('\nFull response received!');
      const full = await page.$eval('[class*="rounded-2xl"]:last-of-type', el => el.textContent || '');
      console.log(full.substring(0, 500));
      break;
    }
  }

  await browser.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
