'use strict';
// Reads an HTTP "Range: bytes=..." header (used when a browser seeks inside a video / audio file).
// Returns: null (no usable range -> send the whole file), 'invalid', or { start, end } (both inclusive).
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // odd or multi-range headers: just send everything
  if (!(size > 0)) return 'invalid';

  let start;
  let end;
  if (m[1] === '') {
    // "bytes=-500" means the last 500 bytes
    const n = parseInt(m[2], 10);
    if (!(n > 0)) return 'invalid';
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

module.exports = { parseRange };
