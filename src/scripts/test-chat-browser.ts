/**
 * Test chat SSE in a real browser via Playwright
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Go to the login page and set the session cookie
  const session = 'm_QvJZcy3uJvLJF2obPgaNHp9X8bwFfuYO6WzgjkfFLA9XE8';
  await page.context().addCookies([{
    name: 'session',
    value: session,
    domain: 'app.example.com',
    path: '/',
  }]);

  // Navigate to chat
  await page.goto('https://app.example.com/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log('Page loaded, URL:', page.url());

  // Listen for console messages
  page.on('console', msg => {
    if (msg.text().includes('streamChat') || msg.text().includes('Error') || msg.text().includes('error')) {
      console.log('[BROWSER]', msg.type(), msg.text());
    }
  });

  // Listen for failed requests
  page.on('requestfailed', req => {
    console.log('[FAILED]', req.url(), req.failure()?.errorText);
  });

  // Listen for responses
  page.on('response', res => {
    if (res.url().includes('chat') && res.url().includes('stream')) {
      console.log('[RESPONSE]', res.status(), res.url().substring(0, 80));
    }
  });

  // Type in the input and send
  const input = await page.$('input[placeholder*="analytics"]');
  if (!input) {
    console.log('Input not found!');
    const html = await page.content();
    console.log(html.substring(0, 500));
    await browser.close();
    return;
  }

  await input.fill('Quick test - is this working?');
  const sendBtn = await page.$('button:has-text("Send")');
  if (sendBtn) {
    await sendBtn.click();
    console.log('Message sent, waiting for response...');
  }

  // Wait and check
  await page.waitForTimeout(15000);

  // Get the assistant message content
  const messages = await page.$$eval('[class*="bg-card"]', els =>
    els.map(el => el.textContent?.substring(0, 200) || '')
  );
  console.log('\nMessages found:', messages.length);
  for (const m of messages) {
    console.log('  MSG:', m.substring(0, 150));
  }

  await browser.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
