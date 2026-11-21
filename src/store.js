'use strict';

/**
 * In-memory store for temporary addresses and their emails.
 * No database: everything lives in a Map and disappears when the
 * process restarts or when an address expires (30 min TTL).
 */

const LOCAL_RE = /^[a-z0-9]{10,14}$/;
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function createStore({ domain, ttlMs }) {
  // localPart -> { local, address, createdAt, expiresAt, extended, emails: [] }
  const addresses = new Map();

  function normalizeLocal(input) {
    if (!input || typeof input !== 'string') return null;
    const local = input.trim().toLowerCase().split('@')[0];
    if (!LOCAL_RE.test(local)) return null;
    return local;
  }

  function generateLocal() {
    let local;
    do {
      const len = 10 + Math.floor(Math.random() * 5); // 10-14 chars
      let out = '';
      for (let i = 0; i < len; i++) {
        out += CHARS[Math.floor(Math.random() * CHARS.length)];
      }
      local = out;
    } while (addresses.has(local));
    return local;
  }

  function create() {
    const local = generateLocal();
    const now = Date.now();
    const record = {
      local,
      address: `${local}@${domain}`,
      createdAt: now,
      expiresAt: now + ttlMs,
      extended: false,
      emails: [],
    };
    addresses.set(local, record);
    return record;
  }

  // Returns the record or null when missing/expired (expired records are removed).
  function get(local) {
    const record = addresses.get(local);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      addresses.delete(local);
      return null;
    }
    return record;
  }

  function remove(local) {
    return addresses.delete(local);
  }

  function extend(local) {
    const record = get(local);
    if (!record) return { error: 'not_found' };
    if (record.extended) return { error: 'already_extended' };
    record.extended = true;
    record.expiresAt = Date.now() + ttlMs;
    return { ok: true, record };
  }

  function addEmail(local, email) {
    const record = get(local);
    if (!record) return false;
    record.emails.push(email);
    return true;
  }

  // Periodic sweep for expired addresses (also enforced lazily on access).
  function sweep() {
    const now = Date.now();
    for (const [local, record] of addresses) {
      if (record.expiresAt <= now) addresses.delete(local);
    }
  }

  return { create, get, remove, extend, addEmail, sweep, normalizeLocal, addresses };
}

module.exports = { createStore };
