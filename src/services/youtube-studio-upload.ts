/**
 * Upload thumbnails via YouTube Studio using Playwright Firefox.
 * Bypasses the API's 2MB limit — uploads full quality thumbnails.
 * Firefox profile with YouTube login at data/firefox-studio/.
 */

import { firefox, type BrowserContext, type Page } from 'playwright';
import { resolve } from 'path';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';

const MASTER_PROFILE = resolve(import.meta.dirname, '../../data/firefox-studio');
const WORK_PROFILE = resolve(import.meta.dirname, '../../data/firefox-studio-work');

let _context: BrowserContext | null = null;
let _contextClosed = false;
let _lockPromise: Promise<void> = Promise.resolve();

export async function acquireLock(): Promise<() => void> {
  let release: () => void;
  const prev = _lockPromise;
  _lockPromise = new Promise(r => { release = r; });
  await prev;
  return release!;
}

async function getContext(): Promise<BrowserContext> {
  if (_context) {
    if (!_contextClosed) return _context;
    try { await _context.close(); } catch {}
    _context = null;
  }

  // Copy master profile to work profile (so master stays clean)
  if (existsSync(WORK_PROFILE)) {
    try { cpSync(MASTER_PROFILE + '/cookies.sqlite', WORK_PROFILE + '/cookies.sqlite'); } catch {}
  } else {
    mkdirSync(WORK_PROFILE, { recursive: true });
    cpSync(MASTER_PROFILE, WORK_PROFILE, { recursive: true });
  }

  // Launch with retry. The common failure is "Failed to launch the browser
  // process" from a stale profile lock left by a stray/crashed Firefox — which
  // otherwise drops the write straight onto the quota'd Data API. Clear the lock
  // (and any stray Firefox on THIS profile only) and relaunch before giving up.
  const ATTEMPTS = 3;
  let launchErr: any = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      _context = await firefox.launchPersistentContext(WORK_PROFILE, {
        headless: true,
        viewport: { width: 1400, height: 900 },
        timeout: 20000,
      });
      launchErr = null;
      break;
    } catch (e: any) {
      launchErr = e;
      console.warn(`[studio-upload] Firefox launch failed (attempt ${i + 1}/${ATTEMPTS}): ${e?.message}`);
      if (i < ATTEMPTS - 1) {
        // Kill only Firefoxes bound to OUR work profile, then clear its lock files.
        try { execSync(`pkill -f ${JSON.stringify(WORK_PROFILE)}`, { stdio: 'ignore' }); } catch {}
        for (const lf of ['lock', '.parentlock', 'lock.tmp']) { try { rmSync(resolve(WORK_PROFILE, lf), { force: true }); } catch {} }
        await new Promise(r => setTimeout(r, 2500));
      }
    }
  }
  if (launchErr || !_context) throw launchErr || new Error('Firefox launch failed');
  _contextClosed = false;
  _context.on('close', () => { _contextClosed = true; });
  return _context;
}

// The context can close out from under us (Firefox crash, manual close) between
// getContext() and newPage(); retry once with a fresh context before giving up.
async function getPage(): Promise<Page> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctx = await getContext();
    try {
      return ctx.pages()[0] || await ctx.newPage();
    } catch (err) {
      console.error(`[studio-upload] Context died getting page (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
      _contextClosed = true;
      await closeBrowser();
    }
  }
  throw new Error('Failed to open a page after restarting the browser context');
}

async function closeBrowser(): Promise<void> {
  try { if (_context) await _context.close(); } catch {}
  _context = null;
}

/**
 * Upload a full-res thumbnail via YouTube Studio.
 */
export async function uploadThumbnailViaStudio(videoId: string, imagePath: string): Promise<boolean> {
  const release = await acquireLock();
  try {
    // Always get a fresh page per upload — reusing a page from a previous upload
    // can leave the thumbnail panel in a collapsed/wrong state.
    await closeBrowser();
    const page = await getPage();

    const studioUrl = `https://studio.youtube.com/video/${videoId}/edit`;
    console.log(`[studio-upload] Navigating to ${videoId}`);
    await page.goto(studioUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000);

    // Check for login redirect
    if (page.url().includes('accounts.google.com')) {
      console.error('[studio-upload] Session expired — need to re-login in Firefox');
      try {
        const { sendEmail } = await import('./email.js');
        await sendEmail('team@example.com', 'YT Testing: Firefox Studio session expired',
          '<p>The Firefox Studio session has expired. All thumbnail uploads are failing until you re-login.</p>' +
          '<p>Run: <code>open -a Firefox --args --profile ~/Projects/yt-testing/data/firefox-studio --no-remote https://studio.youtube.com</code></p>' +
          '<p>Any paused tests will need to be manually resumed after re-login.</p>');
      } catch {}
      await closeBrowser();
      // Throw a typed error so callers know this is session expiry, not a transient failure.
      // youtube-api.ts will NOT use the API compression fallback for this error type.
      const err = new Error('Firefox Studio session expired') as any;
      err.sessionExpired = true;
      throw err;
    }

    if (!page.url().includes('studio.youtube.com')) {
      console.error('[studio-upload] Not on Studio:', page.url());
      return false;
    }

    // YouTube Studio's thumbnail file input only appears after clicking the thumbnail area.
    // Try to click the "Change thumbnail" / thumbnail edit area first to reveal it.
    const thumbnailClickSelectors = [
      'ytcp-thumbnail-default-image',
      '[data-testid="thumbnail-upload-button"]',
      'button[aria-label*="thumbnail" i]',
      'button[aria-label*="Thumbnail" i]',
      '.thumbnail-container button',
      '#thumbnail-section button',
    ];
    for (const sel of thumbnailClickSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0) {
          await btn.click({ timeout: 3000 });
          console.log(`[studio-upload] Clicked thumbnail area: ${sel}`);
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    // Wait for file input to appear (may have been hidden before thumbnail click)
    await page.waitForSelector('#file-loader, input[type="file"][accept*="image"]', { timeout: 10000 }).catch(() => {
      console.warn('[studio-upload] file input not immediately visible after thumbnail click');
    });

    // Upload file
    const absPath = resolve(imagePath);
    const fileInput = page.locator('#file-loader').first();
    const fileInputAlt = page.locator('input[type="file"][accept*="image"]').first();
    const inputExists = await fileInput.count();
    const inputAltExists = await fileInputAlt.count();

    if (inputExists > 0) {
      await fileInput.setInputFiles(absPath);
      console.log('[studio-upload] File set via #file-loader');
    } else if (inputAltExists > 0) {
      await fileInputAlt.setInputFiles(absPath);
      console.log('[studio-upload] File set via input[type=file]');
    } else {
      // Last resort: trigger file chooser via JS click
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
        page.evaluate(() => {
          const el = (document.querySelector('#file-loader') || document.querySelector('input[type="file"][accept*="image"]')) as HTMLInputElement | null;
          if (el) el.click();
        }),
      ]);
      if (fileChooser) {
        await fileChooser.setFiles(absPath);
        console.log('[studio-upload] File set via filechooser');
      } else {
        console.error('[studio-upload] Could not find file input');
        return false;
      }
    }

    // Wait for processing
    console.log('[studio-upload] Waiting for thumbnail to process...');
    await page.waitForTimeout(12000);

    // Click Save
    let saved = false;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent?.trim() === 'Save' && !btn.disabled) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log(`[studio-upload] Save clicked (attempt ${attempt})`);
        await page.waitForTimeout(5000);

        const saveDisabled = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const btn of btns) {
            if (btn.textContent?.trim() === 'Save') return btn.disabled;
          }
          return true;
        });

        if (saveDisabled) {
          saved = true;
          console.log('[studio-upload] Save confirmed');
          break;
        }
      }
      await page.waitForTimeout(2000);
    }

    if (saved) {
      console.log(`[studio-upload] Thumbnail uploaded for ${videoId} via Studio`);
    } else {
      console.error('[studio-upload] Save never confirmed');
    }

    return saved;
  } catch (err: any) {
    if ((err as any).sessionExpired) throw err;
    console.error(`[studio-upload] Error: ${err.message}`);
    await closeBrowser();
    return false;
  } finally {
    release();
  }
}

// Compatibility exports for browser-session imports
/**
 * Keep the Studio login warm so Google does not idle-time-out the session
 * between (sometimes hours-apart) uploads. Loads Studio on the MASTER profile
 * (the source of truth that uploads copy from) so refreshed cookies persist.
 * Serialized behind the same lock as uploads. Never throws.
 */
let _lastWarmState: 'ok' | 'logged_out' | null = null;
export async function keepStudioSessionWarm(): Promise<'ok' | 'logged_out' | 'error'> {
  const release = await acquireLock();
  let ctx: BrowserContext | null = null;
  try {
    await closeBrowser(); // ensure no work-profile context is open
    ctx = await firefox.launchPersistentContext(MASTER_PROFILE, { headless: true, viewport: { width: 1200, height: 800 }, timeout: 20000 });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000); // let Google reissue session cookies
    const url = page.url();
    const loggedOut = /accounts\.google\.com|\/signin|ServiceLogin/i.test(url);
    console.log(`[studio-keepalive] ${loggedOut ? 'LOGGED OUT, needs manual Firefox re-login' : 'session refreshed'} (${url.slice(0, 60)})`);
    // Proactive alert: email only on the transition into logged-out, so you hear
    // about it hours before a test would actually stall, and only once per lapse.
    if (loggedOut && _lastWarmState !== 'logged_out') {
      try {
        const { sendEmail } = await import('./email.js');
        await sendEmail('team@example.com', 'YT Testing: Firefox Studio login needs a refresh (heads up)',
          '<p>The routine session check found the Firefox Studio login has lapsed. Re-login now so your next test rotation does not stall on a thumbnail upload.</p>' +
          '<p>Run this, log in, then CLOSE the Firefox window:</p>' +
          '<p><code>open -a Firefox --args --profile ~/Projects/yt-testing/data/firefox-studio --no-remote https://studio.youtube.com</code></p>');
      } catch {}
    }
    _lastWarmState = loggedOut ? 'logged_out' : 'ok';
    if (!loggedOut) {
      // The internal-API stats fetch (reach-refresh) reads the WORK profile's
      // cookies. Push the freshly-refreshed master cookies across so stats stay
      // live even when uploads are hours apart.
      try { await ctx.close(); ctx = null; if (existsSync(WORK_PROFILE)) cpSync(MASTER_PROFILE + '/cookies.sqlite', WORK_PROFILE + '/cookies.sqlite'); } catch {}
    }
    return loggedOut ? 'logged_out' : 'ok';
  } catch (e: any) {
    console.warn('[studio-keepalive] error:', e?.message);
    return 'error';
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
    release();
  }
}

export async function closeAll(): Promise<void> { await closeBrowser(); }
export function recordFailure(): number { return 0; }
export function recordSuccess(): void {}
export async function saveProfile(_name: string): Promise<void> {}
export async function getProfile(_name: string, _opts?: any): Promise<any> {
  const page = await getPage();
  if (_opts?.startUrl) await page.goto(_opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return { page, context: page.context() };
}
export async function forceRestart(startUrl?: string): Promise<any> {
  await closeBrowser();
  return getProfile('', { startUrl });
}
