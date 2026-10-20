'use strict';
// Checks what a file REALLY is by reading its first bytes ("magic bytes").
// We never trust the file extension or the MIME type sent by the browser.
const fs = require('fs');
const path = require('path');

const startsWith = (buf, sig, offset = 0) =>
  buf.length >= offset + sig.length && sig.every((b, i) => buf[offset + i] === b);
const ascii = (buf, str, offset = 0) =>
  buf.length >= offset + str.length && buf.toString('latin1', offset, offset + str.length) === str;

function looksLikeText(buf) {
  if (buf.length === 0) return false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  return true;
}

// DEFAULT-DENY: a file is accepted only if its extension is listed here AND its bytes match.
// html, svg, js, exe, php ... are not listed, so they are always rejected.
const SIGNATURES = [
  { mime: 'image/jpeg', exts: ['jpg', 'jpeg'], inline: true, test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/png', exts: ['png'], inline: true, test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/gif', exts: ['gif'], inline: true, test: (b) => ascii(b, 'GIF87a') || ascii(b, 'GIF89a') },
  { mime: 'image/webp', exts: ['webp'], inline: true, test: (b) => ascii(b, 'RIFF') && ascii(b, 'WEBP', 8) },
  { mime: 'application/pdf', exts: ['pdf'], inline: false, test: (b) => ascii(b, '%PDF-') },
  { mime: 'audio/mp4', exts: ['m4a'], inline: true, test: (b) => ascii(b, 'ftyp', 4) },
  { mime: 'video/mp4', exts: ['mp4', 'mov', 'm4v'], inline: true, test: (b) => ascii(b, 'ftyp', 4) },
  { mime: 'video/webm', exts: ['webm'], inline: true, test: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) },
  { mime: 'audio/mpeg', exts: ['mp3'], inline: true, test: (b) => ascii(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { mime: 'audio/ogg', exts: ['ogg', 'oga'], inline: true, test: (b) => ascii(b, 'OggS') },
  { mime: 'audio/wav', exts: ['wav'], inline: true, test: (b) => ascii(b, 'RIFF') && ascii(b, 'WAVE', 8) },
  { mime: 'application/vnd.rar', exts: ['rar'], inline: false, test: (b) => startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { mime: 'application/x-7z-compressed', exts: ['7z'], inline: false, test: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { mime: 'text/plain', exts: ['txt', 'log'], inline: false, test: looksLikeText },
  { mime: 'text/csv', exts: ['csv'], inline: false, test: looksLikeText }
];

const OFFICE_ZIP = {
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};
const OLD_OFFICE = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint'
};

// Returns { mime, inline } or null (= not allowed)
function detectType(buf, ext) {
  ext = String(ext || '').toLowerCase();
  if (!buf || buf.length < 4) return null;
  for (const s of SIGNATURES) {
    if (s.exts.includes(ext) && s.test(buf)) return { mime: s.mime, inline: s.inline };
  }
  if (OFFICE_ZIP[ext] && (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]))) {
    return { mime: OFFICE_ZIP[ext], inline: false };
  }
  if (OLD_OFFICE[ext] && startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: OLD_OFFICE[ext], inline: false };
  }
  return null;
}

function detectImage(buf) {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(buf, 'GIF87a') || ascii(buf, 'GIF89a')) return 'image/gif';
  if (ascii(buf, 'RIFF') && ascii(buf, 'WEBP', 8)) return 'image/webp';
  return null;
}

// Parses "data:image/jpeg;base64,...." and verifies the bytes are really that image type.
function parseImageDataUrl(dataUrl, { maxBytes = 200 * 1024, allowed = ['image/jpeg', 'image/png'] } = {}) {
  if (typeof dataUrl !== 'string') return { ok: false, error: 'Invalid image' };
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return { ok: false, error: 'Invalid image' };
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) return { ok: false, error: 'Image is too large' };
  const real = detectImage(buffer);
  if (!real || real !== m[1] || !allowed.includes(real)) return { ok: false, error: 'Invalid image' };
  return { ok: true, mime: real, buffer };
}

// Makes a safe display name for a file (never used as a path on disk).
function sanitizeFileName(name) {
  let n = String(name || 'file');
  // multer reads UTF-8 names as latin1; repair them (Afaan Oromoo / Amharic names)
  if (!/[^\u0000-\u00ff]/.test(n)) {
    const fixed = Buffer.from(n, 'latin1').toString('utf8');
    if (!fixed.includes('\ufffd')) n = fixed;
  }
  n = n.split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 10);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || 'file';
}

async function readHead(filePath, n = 4100) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

module.exports = { detectType, detectImage, parseImageDataUrl, sanitizeFileName, readHead };
