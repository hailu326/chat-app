'use strict';
const crypto = require('crypto');

const MAX_ICE_PER_SIDE = 100;

// Keeps track of every call that is ringing or in progress (in memory: one server process).
// The manager never trusts a person: who may do what is decided here from what the SERVER recorded.
//  - only the person who was called can accept or decline
//  - only the two people in the call can send network candidates or hang up
//  - a person can be in one call at a time (the other caller hears "busy")
class CallManager {
  constructor(opts = {}) {
    this.emitToUser = opts.emitToUser || (() => {}); // (userId, event, payload, exceptSocketId?) -> sends to ALL devices of a user
    this.notify = opts.notify || (() => {}); // ({ type: 'ringing' | 'missed', call }) -> phone alerts
    this.ringMs = opts.ringMs || 45000;
    this.graceMs = opts.graceMs || 20000;
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.now = opts.now || Date.now;
    this.newId = opts.newId || (() => crypto.randomBytes(16).toString('hex'));
    this.calls = new Map(); // callId -> call
    this.byUser = new Map(); // userId -> callId
  }

  get(callId) {
    return this.calls.get(callId);
  }

  callOf(userId) {
    const id = this.byUser.get(userId);
    return id ? this.calls.get(id) : undefined;
  }

  other(call, userId) {
    return call.callerId === userId ? call.calleeId : call.calleeId === userId ? call.callerId : null;
  }

  start({ callerId, calleeId, conversationId, kind, offer, socketId }) {
    if (!callerId || !calleeId || callerId === calleeId) return { error: 'invalid' };
    if (this.byUser.has(callerId)) return { error: 'already_in_call' };
    if (this.byUser.has(calleeId)) return { error: 'busy' };

    const call = {
      id: this.newId(),
      conversationId,
      callerId,
      calleeId,
      kind,
      offer,
      state: 'ringing',
      callerSocketId: socketId || null,
      calleeSocketId: null,
      callerIce: [], // kept while ringing, so a person who connects late (from a phone alert) receives them
      iceCount: { [callerId]: 0, [calleeId]: 0 },
      createdAt: this.now(),
      answeredAt: null,
      ringTimer: null,
      graceTimers: {}
    };
    this.calls.set(call.id, call);
    this.byUser.set(callerId, call.id);
    this.byUser.set(calleeId, call.id);
    call.ringTimer = this.setTimer(() => this._timeout(call.id), this.ringMs);

    this.emitToUser(calleeId, 'call:incoming', { callId: call.id, conversationId, kind, from: callerId, offer });
    this.notify({ type: 'ringing', call });
    return { ok: true, call };
  }

  accept({ userId, callId, answer, socketId }) {
    const call = this.calls.get(callId);
    if (!call) return { error: 'not_found' };
    if (call.calleeId !== userId) return { error: 'forbidden' };
    if (call.state !== 'ringing') return { error: 'not_ringing' };

    this.clearTimer(call.ringTimer);
    call.ringTimer = null;
    call.state = 'active';
    call.answeredAt = this.now();
    call.calleeSocketId = socketId || null;
    call.callerIce = [];

    this.emitToUser(call.callerId, 'call:accepted', { callId, answer });
    // the person's other devices stop ringing
    this.emitToUser(call.calleeId, 'call:ended', { callId, reason: 'answered_elsewhere' }, socketId);
    return { ok: true, call };
  }

  reject({ userId, callId, socketId }) {
    const call = this.calls.get(callId);
    if (!call) return { error: 'not_found' };
    if (call.calleeId !== userId) return { error: 'forbidden' };
    if (call.state !== 'ringing') return { error: 'not_ringing' };
    this._finish(call, 'rejected', [call.callerId]);
    this.emitToUser(call.calleeId, 'call:ended', { callId, reason: 'rejected_elsewhere' }, socketId);
    return { ok: true };
  }

  hangup({ userId, callId, socketId }) {
    const call = this.calls.get(callId);
    if (!call) return { error: 'not_found' };
    if (call.callerId !== userId && call.calleeId !== userId) return { error: 'forbidden' };
    if (call.state === 'ringing' && userId === call.calleeId) return this.reject({ userId, callId, socketId });

    const wasRinging = call.state === 'ringing';
    this._finish(call, wasRinging ? 'cancelled' : 'hangup', [this.other(call, userId)]);
    if (wasRinging) this.notify({ type: 'missed', call }); // the caller gave up: the callee missed a call
    return { ok: true };
  }

  ice({ userId, callId, candidate }) {
    const call = this.calls.get(callId);
    if (!call) return { error: 'not_found' };
    if (call.callerId !== userId && call.calleeId !== userId) return { error: 'forbidden' };
    if (call.iceCount[userId] >= MAX_ICE_PER_SIDE) return { error: 'too_many' };
    call.iceCount[userId] += 1;
    if (userId === call.callerId && call.state === 'ringing') call.callerIce.push(candidate);
    this.emitToUser(this.other(call, userId), 'call:ice', { callId, candidate });
    return { ok: true };
  }

  // What a person who connects while a call is ringing for them should receive
  pendingFor(userId) {
    const call = this.callOf(userId);
    if (!call || call.calleeId !== userId || call.state !== 'ringing') return null;
    return { callId: call.id, conversationId: call.conversationId, kind: call.kind, from: call.callerId, offer: call.offer, ice: call.callerIce.slice() };
  }

  // The person has no connection left (closed the app, lost the network)
  userGone(userId) {
    const call = this.callOf(userId);
    if (!call) return;
    if (call.state === 'ringing') {
      if (call.callerId === userId) {
        this._finish(call, 'cancelled', [call.calleeId]);
        this.notify({ type: 'missed', call });
      }
      return; // a callee who disconnects can still pick the call up when they come back
    }
    // a call in progress: give the person a short time to come back (for example a phone changing network)
    if (!call.graceTimers[userId]) {
      call.graceTimers[userId] = this.setTimer(() => {
        const c = this.calls.get(call.id);
        if (c) this._finish(c, 'disconnected', [this.other(c, userId)]);
      }, this.graceMs);
    }
  }

  userBack(userId) {
    const call = this.callOf(userId);
    if (call && call.graceTimers[userId]) {
      this.clearTimer(call.graceTimers[userId]);
      delete call.graceTimers[userId];
    }
  }

  _timeout(callId) {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'ringing') return;
    this._finish(call, 'timeout', [call.callerId, call.calleeId]);
    this.notify({ type: 'missed', call });
  }

  _finish(call, reason, tell) {
    if (!this.calls.has(call.id)) return; // already finished
    if (call.ringTimer) this.clearTimer(call.ringTimer);
    Object.values(call.graceTimers).forEach((t) => this.clearTimer(t));
    this.calls.delete(call.id);
    if (this.byUser.get(call.callerId) === call.id) this.byUser.delete(call.callerId);
    if (this.byUser.get(call.calleeId) === call.id) this.byUser.delete(call.calleeId);
    tell.filter(Boolean).forEach((u) => this.emitToUser(u, 'call:ended', { callId: call.id, reason }));
  }
}

module.exports = { CallManager, MAX_ICE_PER_SIDE };