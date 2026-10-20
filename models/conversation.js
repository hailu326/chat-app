'use strict';
const mongoose = require('mongoose');

// A private chat between exactly two users.
// participantKey = the two user ids sorted and joined. It is UNIQUE, so the same two
// people can never end up with two separate conversations.
const conversationSchema = new mongoose.Schema(
  {
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      validate: {
        validator: (v) => Array.isArray(v) && v.length === 2 && String(v[0]) !== String(v[1]),
        message: 'A conversation needs exactly two different users'
      }
    },
    participantKey: { type: String, required: true, unique: true },
    lastMessageAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
