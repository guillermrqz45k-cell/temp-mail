'use strict';

/**
 * Small end-to-end test for temp-mail.
 * Starts the server on an ephemeral port and exercises the real HTTP API.
 * Run:  npm test
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server.js');

const BASE = 'http://127.0.0.1';

async function req(port, method, path, body) {
  const res = await fetch(`${BASE}:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, data };
}

(async () => {
  const { app, store } = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  let passed = 0;

  function check(name, cond) {
    assert.ok(cond, name);
    passed += 1;
    console.log(`  ✓ ${name}`);
  }

  try {
    console.log('temp-mail tests');

    // 1. Health
    const health = await req(port, 'GET', '/api/health');
    check('health returns {ok:true, app:"temp-mail"}', health.status === 200 && health.data.ok === true && health.data.app === 'temp-mail');

    // 2. No auto-generation + public page copy.
    //    Nothing creates addresses by itself: after startup, idle time and
    //    read-only requests, the store stays empty.
    check('no auto-generation: store is empty right after startup', store.addresses.size === 0);
    await new Promise((r) => setTimeout(r, 1500));
    await req(port, 'GET', '/api/health');
    await req(port, 'GET', `/api/inbox/${encodeURIComponent('nadie12345@temp.robindark.co')}`);
    check('no auto-generation: still empty after idle time and read-only requests', store.addresses.size === 0);
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const genCalls = (appJs.match(/generate\(/g) || []).length;
    const genClicks = (appJs.match(/addEventListener\('click', generate\)/g) || []).length;
    check('frontend: generate() only defined once and only wired to button clicks',
      genCalls === 1 && appJs.includes('function generate()') && genClicks === 2);
    check('frontend: no timer calls generate()',
      !appJs.split('\n').some((l) => /set(Interval|Timeout)/.test(l) && l.includes('generate')));
    const home = await fetch(`${BASE}:${port}/`);
    const homeText = await home.text();
    check('homepage explains it is public, no registration, 30 minutes',
      home.status === 200 && /sin registro/i.test(homeText) && /30 minutos/.test(homeText) && /p[úu]blico/i.test(homeText));

    // 3. Rate limit: 20 creations per IP per hour, 21st is 429.
    //    Run this first so later creations do not pollute the count.
    const created = [];
    for (let i = 0; i < 20; i++) {
      const r = await req(port, 'POST', '/api/inbox');
      assert.strictEqual(r.status, 201, `creation ${i + 1} should be 201`);
      created.push(r.data.address);
    }
    const over = await req(port, 'POST', '/api/inbox');
    check('rate limit: 21st creation in an hour returns 429', over.status === 429 && over.data.error === 'rate_limited');

    // 4. Address format
    const address = created[0];
    check('address matches <10-14 lowercase alnum>@temp.robindark.co', /^[a-z0-9]{10,14}@temp\.robindark\.co$/.test(address));

    // 5. Webhook stores an email under the right address, code extracted.
    const hook = await req(port, 'POST', '/api/incoming-email', {
      to: address,
      from: 'noreply@ejemplo.com',
      subject: 'Tu código de verificación',
      text: 'Hola, tu código es 482913. No lo compartas con nadie.',
      receivedAt: new Date().toISOString(),
    });
    check('webhook returns 200 {ok:true, stored:true}', hook.status === 200 && hook.data.ok === true && hook.data.stored === true);

    const inbox = await req(port, 'GET', `/api/inbox/${encodeURIComponent(address)}`);
    check('inbox lists 1 email', inbox.status === 200 && inbox.data.emails.length === 1);
    check('code extraction: "Tu código es 482913" -> 482913', inbox.data.emails[0].code === '482913' && inbox.data.emails[0].hasCode === true);

    // 6. Spaced and dashed code formats.
    await req(port, 'POST', '/api/incoming-email', {
      to: address.toUpperCase(), // case-insensitive match on the local part
      from: 'soporte@tienda.com',
      subject: 'Código',
      text: 'Tu código es 123 456',
    });
    await req(port, 'POST', '/api/incoming-email', {
      to: address,
      from: 'soporte@tienda.com',
      subject: 'Código',
      text: 'Tu código es 123-456',
    });
    const inbox2 = await req(port, 'GET', `/api/inbox/${encodeURIComponent(address)}`);
    const codes = inbox2.data.emails.map((e) => e.code).sort();
    check('code extraction: "123 456" and "123-456" both normalize to 123456', codes.includes('123456') && inbox2.data.emails.filter((e) => e.code === '123456').length === 2);

    // 7. Email without a code -> code null.
    await req(port, 'POST', '/api/incoming-email', {
      to: address,
      from: 'news@blog.com',
      subject: 'Boletín semanal',
      text: 'Hola, estas son las noticias de la semana.',
    });
    const inbox3 = await req(port, 'GET', `/api/inbox/${encodeURIComponent(address)}`);
    const plain = inbox3.data.emails.find((e) => e.subject === 'Boletín semanal');
    check('email without a code has code null / hasCode false', plain && plain.code === null && plain.hasCode === false);

    // 8. Full email read.
    const firstId = inbox3.data.emails.find((e) => e.code === '482913').id;
    const full = await req(port, 'GET', `/api/inbox/${encodeURIComponent(address)}/${firstId}`);
    check('full email returns from/subject/text/code', full.status === 200 && full.data.from === 'noreply@ejemplo.com' && full.data.text.includes('482913') && full.data.code === '482913');

    // 9. Webhook to an unknown address is ignored silently (200).
    const ghost = await req(port, 'POST', '/api/incoming-email', {
      to: 'nadie12345@temp.robindark.co',
      from: 'x@y.com',
      subject: 'Hola',
      text: 'Tu código es 111111',
    });
    check('webhook to unknown address returns 200 ignored', ghost.status === 200 && ghost.data.ignored === true);

    // 10. Extend once, second extend fails.
    const ext1 = await req(port, 'POST', `/api/inbox/${encodeURIComponent(address)}/extend`);
    check('extend works once', ext1.status === 200 && ext1.data.ok === true && ext1.data.extended === true);
    const ext2 = await req(port, 'POST', `/api/inbox/${encodeURIComponent(address)}/extend`);
    check('second extend returns 400 already_extended', ext2.status === 400 && ext2.data.error === 'already_extended');

    // 11. Expiry removes the address (forced by moving expiresAt to the past).
    const local = address.split('@')[0];
    const record = store.addresses.get(local);
    record.expiresAt = Date.now() - 1000;
    const expiredGet = await req(port, 'GET', `/api/inbox/${encodeURIComponent(address)}`);
    check('expired address returns 404', expiredGet.status === 404 && expiredGet.data.error === 'address_not_found');
    const expiredHook = await req(port, 'POST', '/api/incoming-email', {
      to: address,
      from: 'x@y.com',
      subject: 'Tarde',
      text: 'Tu código es 222222',
    });
    check('webhook to expired address is ignored (200)', expiredHook.status === 200 && expiredHook.data.ignored === true);

    // 12. Delete removes the address and its emails.
    const victim = created[1];
    await req(port, 'POST', '/api/incoming-email', {
      to: victim,
      from: 'a@b.com',
      subject: 'Hola',
      text: 'Tu código es 333333',
    });
    const del = await req(port, 'DELETE', `/api/inbox/${encodeURIComponent(victim)}`);
    check('delete returns 200 deleted:true', del.status === 200 && del.data.deleted === true);
    const afterDel = await req(port, 'GET', `/api/inbox/${encodeURIComponent(victim)}`);
    check('deleted address returns 404', afterDel.status === 404);

    console.log(`\nAll ${passed} checks passed.`);
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
