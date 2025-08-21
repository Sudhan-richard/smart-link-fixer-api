// api-compat.js — persistent Chromium + cancel per runId
// ✅ Status detection/classification copied 1:1 from your OLD code

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

// --- helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toCsvRow = (obj) => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [obj.url, obj.status, obj.isReal404, obj.reason || '', obj.title || '', obj.error || '']
    .map(esc).join(',') + '\n';
};

// --- light per-host delay (keeps your “old feel”) ---
const RATE = { minDelayMs: 1000, jitterMs: 600 };
const lastAtByHost = new Map();
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const randInt = (n) => Math.floor(Math.random() * n);
async function waitPerHost(url) {
  const host = hostOf(url);
  const last = lastAtByHost.get(host) || 0;
  const base = RATE.minDelayMs + randInt(RATE.jitterMs);
  const wait = Math.max(0, last + base - Date.now());
  if (wait > 0) await sleep(wait);
}
function markHost(url) { lastAtByHost.set(hostOf(url), Date.now()); }

// --- cancel state (per runId) ---
const cancels = new Map();   // runId -> boolean
const isCancelled = (runId) => !!(runId && cancels.get(runId));

// --- SINGLE persistent browser/context/page for everything ---
let browser = null;
let context = null;
let page = null;
let booting = null;

async function ensureBoot() {
  if (browser && browser.isConnected() && context && page && !page.isClosed()) {
    return { browser, context, page };
  }
  if (booting) return booting;

  booting = (async () => {
    try {
      if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox','--disable-setuid-sandbox']
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
      }
      return { browser, context, page };
    } finally {
      booting = null;
    }
  })();

  return booting;
}

async function resetPageIfBroken() {
  if (!context) return ensureBoot();
  if (!page || page.isClosed()) {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
  }
  return { browser, context, page };
}

async function closeRun(runId) {
  cancels.delete(runId);
  try { await page.goto('about:blank'); } catch {}
}

// --- Cancel endpoint ---
app.post('/cancel', async (req, res) => {
  const { runId } = req.body || {};
  if (!runId) return res.status(400).json({ ok: false, error: 'Missing runId' });
  cancels.set(runId, true);
  res.json({ ok: true });
});

// --- Instagram + Twitter/X 404 detector (unchanged) ---
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

// --- cancel-aware navigation helper ---
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

// --- Simple echo ---
app.post('/echo', (req, res) => {
  res.json({ ok: true, body: req.body, when: new Date().toISOString() });
});

// --- Main: /check ---
// Body: { urls: string[] | string, runId?: string, close?: boolean }
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
    const p = page;

    for (const url of urls) {
      if (isCancelled(runId)) { console.warn('[CHECK] cancelled before URL:', url); break; }

      const result = { url, status: '', isReal404: false, reason: '', title: '', error: '' };

      try {
        await resetPageIfBroken();
        await p.goto('about:blank');
        await waitPerHost(url);

        // ---- NAVIGATE (kept cancel-aware) ----
        const response = await gotoWithCancel(p, url, runId, 30000);
        await p.waitForTimeout(1000); // ✅ same settle as old code
        if (isCancelled(runId)) throw new Error('__CANCELLED__');

        // ---- GATHER TEXT & STATUS (exactly like old) ----
        const bodyText = await p.textContent('body');          // may throw if no <body> — same as old
        const title = await p.title();
        const status = response ? response.status() : 0;       // safe fallback

        result.status = status;
        result.title  = title;

        // ---- CLASSIFY (identical order and strings to OLD code) ----
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

      } catch (e) {
        if (e && e.message === '__CANCELLED__') { console.warn('[CHECK] cancelled during nav'); break; }

        // ✅ Error handling matches OLD code
        result.status = 'error';
        result.isReal404 = true;                   // conservative, same as old
        result.error = e.message || String(e);

        if (/Timeout/i.test(result.error)) {
          result.reason = 'Timeout while loading page';
        } else if (/ENOTFOUND|ECONNREFUSED|net::ERR/i.test(result.error)) {
          result.reason = 'Network Error';
        } else {
          result.reason = 'Unexpected Error';
        }

        try { await resetPageIfBroken(); } catch {}
      }

      console.log('[CHECK]', result);
      results.push(result);
      markHost(url);

      // keep the old ~2s pacing, cancel-aware
      for (let i = 0; i < 10; i++) { if (isCancelled(runId)) break; await sleep(200); }
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ API running at http://localhost:${port}`));
