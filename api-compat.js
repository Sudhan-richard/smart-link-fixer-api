// api-compat.js — persistent Chromium + cancel per runId
// CF-friendly: global concurrency=3, per-host=1, polite delay + backoff

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();

// --- CORS (loose for dev) ---
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toCsvRow = (obj) => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [obj.url, obj.status, obj.isReal404, obj.reason || '', obj.title || '', obj.error || '']
    .map(esc).join(',') + '\n';
};
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// Keep your old feel memory (optional)
const RATE = { minDelayMs: 1000, jitterMs: 600 };
const lastAtByHost = new Map();
function markHost(url) { lastAtByHost.set(hostOf(url), Date.now()); }

// ------------------------------------------------------------------
// PATCH A: CF-friendly concurrency + delay (GLOBAL=3, PER-HOST=1)
// ------------------------------------------------------------------
const GLOBAL_CONCURRENCY = 3;     // run up to 3 URLs at a time
const PER_HOST_CONCURRENCY = 1;   // never hit the same host in parallel
const MIN_DELAY_MS = 900;         // polite per-host spacing (raise to 1200–1500 if CF still blocks)
const JITTER_MS = 700;

class Semaphore {
  constructor(limit){ this.limit = limit; this.active = 0; this.q = []; }
  async acquire(){
    if (this.active < this.limit) { this.active++; return; }
    await new Promise(r => this.q.push(r));
    this.active++;
  }
  release(){
    this.active--;
    const r = this.q.shift();
    if (r) r();
  }
}
const globalSem = new Semaphore(GLOBAL_CONCURRENCY);
const hostActive = new Map();   // host -> active count
const hostLastAt = new Map();   // host -> last-hit timestamp

async function acquireHost(host){
  while ((hostActive.get(host) || 0) >= PER_HOST_CONCURRENCY) {
    await sleep(50);
  }
  hostActive.set(host, (hostActive.get(host) || 0) + 1);
}
function releaseHost(host){
  hostActive.set(host, Math.max(0, (hostActive.get(host) || 1) - 1));
}
async function waitPolite(host){
  const last = hostLastAt.get(host) || 0;
  const gap = MIN_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
  const waitFor = Math.max(0, last + gap - Date.now());
  if (waitFor > 0) await sleep(waitFor);
  hostLastAt.set(host, Date.now());
}

// ------------------------------------------------------------------
// Cancel state
// ------------------------------------------------------------------
const cancels = new Map();   // runId -> boolean
const isCancelled = (runId) => !!(runId && cancels.get(runId));

// ------------------------------------------------------------------
// Single persistent browser/context
// (we'll create a FRESH PAGE for each URL; no shared page across sites)
// ------------------------------------------------------------------
let browser = null;
let context = null;
let page = null;       // optional scratch page (used by closeRun)
let booting = null;

async function ensureBoot() {
  if (browser && browser.isConnected() && context) return { browser, context };
  if (booting) return booting;

  booting = (async () => {
    try {
      if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
        });
      }
      if (!context) {
        context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          locale: 'en-US',
          timezoneId: 'Asia/Kolkata',
          viewport: { width: 1280, height: 800 }
        });
      }
      if (!page || page.isClosed()) {
        page = await context.newPage();
        page.setDefaultTimeout(30000);
        await page.goto('about:blank').catch(()=>{});
      }
      return { browser, context };
    } finally {
      booting = null;
    }
  })();

  return booting;
}

async function closeRun(runId) {
  cancels.delete(runId);
  try { if (page && !page.isClosed()) await page.goto('about:blank'); } catch {}
}

// ------------------------------------------------------------------
// Cancel endpoint
// ------------------------------------------------------------------
app.post('/cancel', async (req, res) => {
  const { runId } = req.body || {};
  if (!runId) return res.status(400).json({ ok: false, error: 'Missing runId' });
  cancels.set(runId, true);
  res.json({ ok: true });
});

// Simple health
app.get('/ping', (_req, res) => res.send('ok'));

// ------------------------------------------------------------------
// Fake-200 detectors (Instagram, X/Twitter)
// ------------------------------------------------------------------
async function detectFake200(page, url, rawBodyText) {
  const bodyText = (rawBodyText || '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();

  if (url.includes('instagram.com')) {
    if (
      bodyText.includes("sorry, this page isn't available") ||
      bodyText.includes("page isn't available") ||
      bodyText.includes("link you followed may be broken")
    ) {
      return { fake404: true, reason: 'Instagram: Page not found or broken link' };
    }
  }

  if (url.includes('twitter.com') || url.includes('x.com')) {
    try {
      await page.waitForTimeout(1500);
      const errorLocator = page.locator('text=/doesn[’\']?t exist/i').first();
      const isVisible = await errorLocator.isVisible();
      if (isVisible) {
        const reason = url.includes('/status/')
          ? 'Twitter: Post doesn’t exist'
          : 'Twitter: Account doesn’t exist';
        return { fake404: true, reason };
      }
    } catch (_) {}
  }

  return { fake404: false };
}

// ------------------------------------------------------------------
// Cancel-aware navigation helper
// ------------------------------------------------------------------
async function gotoWithCancel(p, url, runId, timeoutMs = 30000) {
  const nav = p.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  for (;;) {
    if (isCancelled(runId)) throw new Error('__CANCELLED__');
    const winner = await Promise.race([
      nav.then(r => ({ t: 'nav', r })).catch(err => ({ t: 'err', err })),
      p.waitForTimeout(150).then(() => ({ t: 'tick' }))
    ]);
    if (winner.t === 'tick') continue;
    if (winner.t === 'err') throw winner.err;
    return winner.r || null;
  }
}

// ------------------------------------------------------------------
// PATCH B: per-URL worker — fresh page + polite backoff
// ------------------------------------------------------------------
async function checkUrlOnce(ctx, url, runId, attempt = 1) {
  const p = await ctx.newPage({
    userAgent: 'SmartLinkFixer/2.0 (+contact: you@example.com)',
    timezoneId: 'Asia/Kolkata', locale: 'en-US', viewport: { width: 1280, height: 800 }
  });

  // lighten requests: skip heavy assets
  await p.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    route.continue();
  });
  p.setDefaultTimeout(30000);

  const result = { url, status: '', isReal404: false, reason: '', title: '', error: '' };

  try {
    const response = await gotoWithCancel(p, url, runId, 30000);
    await p.waitForTimeout(1000);

    const bodyText = await p.textContent('body').catch(() => '');
    const title = await p.title().catch(() => '');
    const status = response ? response.status() : 0;

    result.status = status;
    result.title  = title;

    // polite retries on CF/rate-limit
    if ((status === 403 || status === 429) && attempt < 3) {
      const backoff = 2000 * Math.pow(2, attempt - 1); // 2s, 4s
      await sleep(backoff + Math.floor(Math.random()*300));
      await p.close().catch(()=>{});
      return await checkUrlOnce(ctx, url, runId, attempt + 1);
    }

    const fake404 = await detectFake200(p, url, bodyText);
    const is404 = status === 404
      || /404|not found|page not found|oops/i.test(title)
      || fake404.fake404;

    result.isReal404 = is404;

    if (fake404.fake404) {
      result.status = 404;
      result.reason = fake404.reason;
    } else if (is404) {
      result.reason = 'Page Not Found (404)';
    } else if (
      status === 403 &&
      /cloudflare|captcha|just a moment|enable javascript/i.test((bodyText || '').toLowerCase())
    ) {
      result.reason = 'Blocked by Cloudflare CAPTCHA';
      result.status = 403;
    } else if (status === 403) {
      result.reason = 'Access Forbidden (403)';
    } else if (status >= 500) {
      result.reason = 'Server Error (5xx)';
    } else if (status >= 400) {
      result.reason = `Client Error (${status})`;
    } else {
      result.reason = 'OK';
    }

    return result;

  } catch (e) {
    result.status = 'error';
    result.isReal404 = true;
    result.error = e.message || String(e);
    if (/Timeout/i.test(result.error)) result.reason = 'Timeout while loading page';
    else if (/ENOTFOUND|ECONNREFUSED|net::ERR/i.test(result.error)) result.reason = 'Network Error';
    else result.reason = 'Unexpected Error';
    return result;

  } finally {
    await p.close().catch(()=>{});
  }
}

async function checkUrlWithPoliteness(ctx, url, runId) {
  const host = hostOf(url) || 'unknown';
  await globalSem.acquire();
  await acquireHost(host);
  try {
    await waitPolite(host);           // per-host spacing (host-based)
    const r = await checkUrlOnce(ctx, url, runId);
    markHost(url);                    // preserves your old timing memory
    return r;
  } finally {
    releaseHost(host);
    globalSem.release();
  }
}

// ------------------------------------------------------------------
// Simple echo (kept from your code)
// ------------------------------------------------------------------
app.post('/echo', (req, res) => {
  res.json({ ok: true, body: req.body, when: new Date().toISOString() });
});

// ------------------------------------------------------------------
// PATCH C: /check — chunked runner using batch=GLOBAL_CONCURRENCY
// Body: { urls: string[] | string, runId?: string, close?: boolean }
// ------------------------------------------------------------------
app.post('/check', async (req, res) => {
  let { urls, runId, close } = req.body || {};
  if (typeof urls === 'string') {
    try { const maybe = JSON.parse(urls); if (Array.isArray(maybe)) urls = maybe; }
    catch { urls = urls.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  }
  if (!Array.isArray(urls)) urls = [];

  if (!runId) runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  if (!cancels.has(runId)) cancels.set(runId, false);

  console.log('[CHECK] runId:', runId, 'batch size:', urls.length, 'close:', !!close);
  if (!urls.length) return res.json([]);

  const results = [];

  try {
    await ensureBoot();
    const ctx = context;   // persistent context (fresh page per URL)
    const BATCH = GLOBAL_CONCURRENCY; // 3

    for (let i = 0; i < urls.length; i += BATCH) {
      if (isCancelled(runId)) { console.warn('[CHECK] cancelled (batch)'); break; }

      const chunk = urls.slice(i, i + BATCH);

      // up to 3 in parallel; per-host=1 inside checkUrlWithPoliteness
      const chunkResults = await Promise.all(
        chunk.map(u => checkUrlWithPoliteness(ctx, u, runId))
      );

      for (const r of chunkResults) {
        console.log('[CHECK]', r);
        results.push(r);
      }

      // light pacing between batches (cancel-aware)
      for (let t = 0; t < 5; t++) { if (isCancelled(runId)) break; await sleep(150); }
    }

  } catch (e) {
    console.error('[CHECK] fatal:', e);

  } finally {
    try {
      const header = 'URL,Status,isReal404,Reason,Title,Error\n';
      const csv = header + results.map(toCsvRow).join('');
      fs.writeFileSync('results.csv', csv);
    } catch (e) {
      console.warn('[CHECK] CSV write failed:', e.message);
    }

    if (close) {
      await closeRun(runId);
    }
  }

  res.json(results);
});

// ------------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ API running at http://localhost:${port}`));
