'use strict';

/**
 * Temp Mail — temporary email service that REALLY receives emails.
 *
 * Receiving happens ONLY through the webhook POST /api/incoming-email,
 * called by a Cloudflare Worker (Email Routing) that parses the incoming
 * message and forwards it as JSON. No email sending/receiving service,
 * no API keys, no third-party temp-mail API.
 *
 * Run:  npm install && node server.js   (PORT env, default 3000)
 */

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const { createStore } = require('./src/store');
const { extractCode } = require('./src/codeExtractor');
const { createRateLimiter } = require('./src/rateLimit');

const DOMAIN = process.env.TEMP_MAIL_DOMAIN || 'temp.robindark.co';
const TTL_MS = 30 * 60 * 1000; // addresses live 30 minutes
const SWEEP_MS = 60 * 1000;

function publicRecord(record) {
  return {
    address: record.address,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    extended: record.extended,
  };
}

function snippetOf(text, html) {
  let source = (text || '').trim();
  if (!source && html) {
    source = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const flat = source.replace(/\s+/g, ' ');
  return flat.length > 120 ? flat.slice(0, 120) + '…' : flat;
}

function createApp() {
  const app = express();
  const store = createStore({ domain: DOMAIN, ttlMs: TTL_MS });

  // Behind Railway's proxy so req.ip reflects the real client (used by the limiter).
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const createLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 }); // 20 addresses / IP / hour
  const webhookLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 200, global: true }); // 200 webhook posts / min

  // ---- Health ----
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, app: 'temp-mail' });
  });

  // ---- Create a temp address ----
  app.post('/api/inbox', createLimiter, (req, res) => {
    const record = store.create();
    res.status(201).json({ ok: true, ...publicRecord(record) });
  });

  // ---- List emails for an address (newest first) ----
  app.get('/api/inbox/:address', (req, res) => {
    const local = store.normalizeLocal(req.params.address);
    const record = local ? store.get(local) : null;
    if (!record) return res.status(404).json({ ok: false, error: 'address_not_found' });
    const emails = [...record.emails]
      .sort((a, b) => b.receivedAtMs - a.receivedAtMs)
      .map((email) => ({
        id: email.id,
        from: email.from,
        subject: email.subject,
        snippet: email.snippet,
        receivedAt: email.receivedAt,
        hasCode: email.code !== null,
        code: email.code,
      }));
    res.json({ ok: true, ...publicRecord(record), emails });
  });

  // ---- Read one full email ----
  app.get('/api/inbox/:address/:id', (req, res) => {
    const local = store.normalizeLocal(req.params.address);
    const record = local ? store.get(local) : null;
    if (!record) return res.status(404).json({ ok: false, error: 'address_not_found' });
    const email = record.emails.find((e) => e.id === req.params.id);
    if (!email) return res.status(404).json({ ok: false, error: 'email_not_found' });
    res.json({
      ok: true,
      id: email.id,
      from: email.from,
      subject: email.subject,
      text: email.text,
      html: email.html,
      receivedAt: email.receivedAt,
      code: email.code,
    });
  });

  // ---- Delete an address and its emails ----
  app.delete('/api/inbox/:address', (req, res) => {
    const local = store.normalizeLocal(req.params.address);
    if (!local || !store.remove(local)) {
      return res.status(404).json({ ok: false, error: 'address_not_found' });
    }
    res.json({ ok: true, deleted: true });
  });

  // ---- Extend an address by 30 min (once) ----
  app.post('/api/inbox/:address/extend', (req, res) => {
    const local = store.normalizeLocal(req.params.address);
    if (!local) return res.status(404).json({ ok: false, error: 'address_not_found' });
    const result = store.extend(local);
    if (result.error === 'not_found') {
      return res.status(404).json({ ok: false, error: 'address_not_found' });
    }
    if (result.error === 'already_extended') {
      return res.status(400).json({ ok: false, error: 'already_extended' });
    }
    res.json({ ok: true, ...publicRecord(result.record) });
  });

  // ---- Incoming email webhook (called by the Cloudflare Worker) ----
  app.post('/api/incoming-email', webhookLimiter, (req, res) => {
    const body = req.body || {};
    const to = typeof body.to === 'string' ? body.to : '';
    const from = typeof body.from === 'string' ? body.from : '';
    if (!to || !from) return res.status(400).json({ ok: false, error: 'missing_to_or_from' });

    const local = store.normalizeLocal(to);
    const record = local ? store.get(local) : null;
    // Unknown or expired address: ignore silently, still answer 200
    // so the Worker does not retry a message that can never be delivered.
    if (!record) return res.json({ ok: true, ignored: true });

    const subject = typeof body.subject === 'string' ? body.subject : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const html = typeof body.html === 'string' ? body.html : '';
    const receivedMs = Number.isFinite(Date.parse(body.receivedAt))
      ? Date.parse(body.receivedAt)
      : Date.now();
    const code = extractCode(subject, text);

    const email = {
      id: crypto.randomUUID(),
      from,
      subject,
      text,
      html,
      receivedAt: new Date(receivedMs).toISOString(),
      receivedAtMs: receivedMs,
      snippet: snippetOf(text, html),
      code,
    };
    store.addEmail(local, email);
    res.json({ ok: true, stored: true, id: email.id });
  });

  // Remove expired addresses every minute.
  const sweepTimer = setInterval(() => store.sweep(), SWEEP_MS);
  sweepTimer.unref();

  return { app, store };
}

if (require.main === module) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`[temp-mail] listening on http://localhost:${port} (domain ${DOMAIN})`);
  });
}

module.exports = { createApp };
