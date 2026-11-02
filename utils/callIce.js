'use strict';
const crypto = require('crypto');

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const hasTurnUrl = (urls) => [].concat(urls || []).some((u) => typeof u === 'string' && /^turns?:/i.test(u));

// Keeps only what a browser needs (and only reasonable values) from a server entry
function cleanServer(s) {
  if (!s || typeof s !== 'object') return null;
  const urls = [].concat(s.urls || []).filter((u) => typeof u === 'string' && /^(stuns?|turns?):/i.test(u) && u.length <= 300);
  if (urls.length === 0) return null;
  const out = { urls: urls.length === 1 ? urls[0] : urls };
  if (typeof s.username === 'string' && s.username.length <= 300) out.username = s.username;
  if (typeof s.credential === 'string' && s.credential.length <= 500) out.credential = s.credential;
  return out;
}

let cloudflareCache = null;
const resetCache = () => {
  cloudflareCache = null;
};

// Three ways to add a TURN relay (set the matching variables in the environment):
//  1) Cloudflare Realtime TURN : CF_TURN_KEY_ID + CF_TURN_API_TOKEN (short-lived passwords are made by Cloudflare)
//  2) Your own coturn server   : TURN_URLS + TURN_SECRET (short-lived passwords are made here)
//  3) A fixed login (for example the free Metered "Open Relay"): TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
// With none of them set, calls use STUN only.
async function buildIceServers({ userId, env = process.env, now = Date.now, fetchImpl = globalThis.fetch } = {}) {
  const stun = splitList(env.STUN_URLS);
  const servers = [{ urls: stun.length ? stun : DEFAULT_STUN }];
  const ttl = Math.min(Math.max(parseInt(env.TURN_TTL_SECONDS, 10) || 3600, 300), 86400);
  const turnUrls = splitList(env.TURN_URLS);

  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN && typeof fetchImpl === 'function') {
    const maxAge = Math.min(ttl * 500, 10 * 60 * 1000); // reuse them for half their life, at most 10 minutes
    let list = cloudflareCache && cloudflareCache.key === env.CF_TURN_KEY_ID && now() - cloudflareCache.at < maxAge ? cloudflareCache.servers : null;
    if (!list) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetchImpl(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl }),
            signal: controller.signal
          }
        );
        if (res.ok) {
          const data = await res.json();
          list = [].concat((data && data.iceServers) || []).map(cleanServer).filter(Boolean);
          cloudflareCache = { key: env.CF_TURN_KEY_ID, at: now(), servers: list };
        }
      } catch {
        /* the provider did not answer: calls continue with STUN only */
      } finally {
        clearTimeout(timer);
      }
    }
    (list || []).forEach((s) => servers.push(s));
  } else if (turnUrls.length && env.TURN_SECRET) {
    const username = `${Math.floor(now() / 1000) + ttl}:${userId}`; // coturn "use-auth-secret" format
    const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls, username, credential });
  } else if (turnUrls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }

  return { iceServers: servers, hasTurn: servers.some((s) => hasTurnUrl(s.urls)) };
}

module.exports = { buildIceServers, resetCache, DEFAULT_STUN };