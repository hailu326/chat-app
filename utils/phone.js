'use strict';
const crypto = require('crypto');

// ---- secret fingerprint (HMAC-SHA256) ----------------------------------------------------------
// Set PHONE_HASH_KEY in the environment (recommended). If it is missing, a key is derived from JWT_SECRET.
const keyCache = new Map();
function hashKey() {
  const base = process.env.PHONE_HASH_KEY || process.env.JWT_SECRET;
  if (!base) throw new Error('Set PHONE_HASH_KEY (or JWT_SECRET) in the environment');
  if (!keyCache.has(base)) {
    keyCache.set(base, crypto.createHmac('sha256', base).update('hailacho-phone-hash-v1').digest());
  }
  return keyCache.get(base);
}

// ---- make every spelling of a number the same ----------------------------------------------------
//  "+251 91 122 3344" -> 251911223344     (already international)
//  "0911223344"       -> 251911223344     (leading 0 = local number: the default country code is added)
//  "00251911223344"   -> 251911223344
//  "251911223344"     -> 251911223344     (digits that already start with the country code)
// Returns digits only, or null when it does not look like a phone number.
function normalizePhone(raw, defaultCc) {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const s = raw.trim();
  if (!/^[0-9+()\-.\s]+$/.test(s)) return null;

  const cc = String(defaultCc || process.env.DEFAULT_COUNTRY_CODE || '251').replace(/\D/g, '');
  let d = s.replace(/\D/g, '');
  if (!s.startsWith('+')) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = cc + d.slice(1);
  }
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

// Secret fingerprint of a number (hex), or null when the number is not usable
function phoneHashOf(raw, defaultCc) {
  const n = normalizePhone(raw, defaultCc);
  return n ? crypto.createHmac('sha256', hashKey()).update(n).digest('hex') : null;
}

// Gives the fingerprint to accounts that were created before this feature existed.
// Safe to run again and again: it only touches accounts that have a phone number but no fingerprint yet.
async function backfillPhoneHashes(User) {
  const users = await User.find({ phone: { $exists: true, $nin: [null, ''] }, phoneHash: { $exists: false } })
    .select('_id phone')
    .lean();
  for (const u of users) {
    await User.updateOne({ _id: u._id }, { $set: { phoneHash: phoneHashOf(u.phone) } }); // null = "not a usable number"
  }
  return users.length;
}

module.exports = { normalizePhone, phoneHashOf, backfillPhoneHashes };
