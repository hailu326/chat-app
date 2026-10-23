'use strict';
// The four privacy switches that live on the SERVER (they change what OTHER people can see).
// A missing value means "use the default", so old accounts keep working without any database change.
const DEFAULTS = Object.freeze({
  readReceipts: true, // send "read" (blue ticks) to the person who wrote to me
  showOnline: true, // show when I am online
  showTyping: true, // show when I am typing
  discoverableByPhone: true // let people find me by my phone number
});
const KEYS = Object.keys(DEFAULTS);

function normalizeSettings(s) {
  const out = {};
  for (const k of KEYS) out[k] = s && typeof s[k] === 'boolean' ? s[k] : DEFAULTS[k];
  return out;
}

module.exports = { DEFAULTS, KEYS, normalizeSettings };
