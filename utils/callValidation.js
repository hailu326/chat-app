'use strict';
// Strict checks for the messages a browser sends while setting up a call.

const CALL_ID = /^[a-f0-9]{32}$/;
const isCallId = (v) => typeof v === 'string' && CALL_ID.test(v);
const isCallKind = (v) => v === 'audio' || v === 'video';

// A WebRTC "session description" is plain text that starts with "v=0". We only pass it on, we never run it.
const validSdp = (v) => typeof v === 'string' && v.length >= 20 && v.length <= 20000 && v.startsWith('v=0');

// Returns a CLEAN copy of a network candidate (only the 4 allowed fields), or null if anything looks wrong.
function cleanCandidate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = c;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2000) return null;
  if (!candidate.startsWith('candidate:')) return null;
  if (sdpMid !== null && sdpMid !== undefined && (typeof sdpMid !== 'string' || sdpMid.length > 64)) return null;
  if (sdpMLineIndex !== null && sdpMLineIndex !== undefined && !(Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 10)) return null;
  if (usernameFragment !== null && usernameFragment !== undefined && (typeof usernameFragment !== 'string' || usernameFragment.length > 64)) return null;
  return {
    candidate,
    sdpMid: sdpMid === undefined ? null : sdpMid,
    sdpMLineIndex: sdpMLineIndex === undefined ? null : sdpMLineIndex,
    usernameFragment: usernameFragment === undefined ? null : usernameFragment
  };
}

module.exports = { isCallId, isCallKind, validSdp, cleanCandidate };