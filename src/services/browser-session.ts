/**
 * Browser session management.
 * Spawns real Chrome (not Playwright Chromium) to preserve YouTube login cookies.
 * Connects via CDP for automation.
 */

import { chromium, BrowserContext, Page, Browser } from 'playwright';
import { execSync, spawn } from 'child_process';

const CDP_PORT = 9222;
const PROFILE_DIR = `${process.env.HOME}/Projects/socials/data/browser-profiles/youtube-studio`;

interface ProfileSession {
  context: BrowserContext;
  page: Page;
}

let _browser: Browser | null = null;
let _page: Page | null = null;
let _consecutiveFailures = 0;
let _sessionLock: Promise<void> = Promise.resolve();

function killExistingChrome(): void {
  try { execSync(`lsof -ti:${CDP_PORT} | xargs kill -9 2>/dev/null`); } catch {}
  try { execSync(`rm -f "${PROFILE_DIR}/SingletonLock" 2>/dev/null`); } catch {}
}

function isSessionHealthy(): boolean {
  if (!_browser || !_page) return false;
  try {
    return !_page.isClosed() && _browser.isConnected();
  } catch {
    return false;
  }
}

async function launchChrome(startUrl?: string): Promise<void> {
  killExistingChrome();
  await new Promise(r => setTimeout(r, 2000));

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--profile-directory=Default',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-sandbox',
    '--headless=new',
    '--disable-gpu',
    '--window-size=1400,900',
    ...(startUrl ? [startUrl] : ['about:blank']),
  ], { stdio: 'ignore', detached: true });
  chrome.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const resp = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      if (resp.ok) {
        console.log('[browser] Chrome launched on port', CDP_PORT);
        return;
      }
    } catch {}
  }
  throw new Error('Chrome failed to start within 20 seconds');
}

export async function getProfile(_name: string, _options?: { headed?: boolean; startUrl?: string }): Promise<ProfileSession> {
  if (_browser && isSessionHealthy()) {
    return { context: _browser.contexts()[0], page: _page! };
  }

  await closeAll();
  // Launch to about:blank first, connect, then navigate
  await launchChrome();

  // Connect with generous timeout
  _browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`, { timeout: 30000 });

  const contexts = _browser!.contexts();
  if (contexts.length === 0) throw new Error('No browser contexts');

  _browser.on('disconnected', () => {
    console.log('[browser] Browser disconnected');
    _browser = null;
    _page = null;
  });

  const context = contexts[0];
  _page = context.pages()[0] || await context.newPage();

  // Now navigate if needed
  if (_options?.startUrl) {
    await _page.goto(_options.startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }

  _consecutiveFailures = 0;
  return { context, page: _page };
}

export function recordFailure(): number {
  _consecutiveFailures++;
  console.log(`[browser] Consecutive failures: ${_consecutiveFailures}`);
  return _consecutiveFailures;
}

export function recordSuccess(): void {
  if (_consecutiveFailures > 0) console.log(`[browser] Recovered after ${_consecutiveFailures} failures`);
  _consecutiveFailures = 0;
}

export async function forceRestart(startUrl?: string): Promise<ProfileSession> {
  console.log('[browser] Force restarting...');
  await closeAll();
  killExistingChrome();
  await new Promise(r => setTimeout(r, 2000));
  return getProfile('youtube-studio', { startUrl });
}

export async function closeAll(): Promise<void> {
  try { if (_browser) await _browser.close(); } catch {}
  _browser = null;
  _page = null;
}

// No-op: cookies saved by Chrome automatically
export async function saveProfile(_name: string): Promise<void> {}

export async function acquireLock(): Promise<() => void> {
  let release: () => void;
  const prev = _sessionLock;
  _sessionLock = new Promise(r => { release = r; });
  await prev;
  return release!;
}
