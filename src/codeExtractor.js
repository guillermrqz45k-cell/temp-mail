'use strict';

/**
 * Extract a confirmation code from an email subject + body.
 *
 * Accepted forms:
 *  - a standalone 4-8 digit number:            "Tu código es 482913"   -> "482913"
 *  - two groups of 3 digits separated by a
 *    space or a dash:                           "Tu código es 123 456"  -> "123456"
 *                                                "Tu código es 123-456"  -> "123456"
 *
 * Preference: a code that appears shortly after a keyword such as
 * "código", "code", "OTP", "verificación" or "verification" wins;
 * otherwise the first code found in the text wins.
 */

const KEYWORD_RE = /c[óo]digo|code|otp|verificaci[óo]n|verification|clave|pin/i;
const STANDALONE_RE = /\b\d{4,8}\b/g;
const GROUPED_RE = /\b(\d{3})[\s-](\d{3})\b/g;
const KEYWORD_WINDOW = 40; // chars before a code that still count as "near" a keyword

function findCandidates(text) {
  const candidates = [];
  let m;
  STANDALONE_RE.lastIndex = 0;
  while ((m = STANDALONE_RE.exec(text)) !== null) {
    candidates.push({ index: m.index, code: m[0] });
  }
  GROUPED_RE.lastIndex = 0;
  while ((m = GROUPED_RE.exec(text)) !== null) {
    candidates.push({ index: m.index, code: m[1] + m[2] });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates;
}

function extractCode(subject, text) {
  const combined = [subject || '', text || ''].join('\n');
  if (!combined.trim()) return null;

  const candidates = findCandidates(combined);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const before = combined.slice(Math.max(0, candidate.index - KEYWORD_WINDOW), candidate.index);
    if (KEYWORD_RE.test(before)) return candidate.code;
  }
  return candidates[0].code;
}

module.exports = { extractCode };
