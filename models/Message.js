'use strict';
const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId }, // the file inside MongoDB (GridFS)
    storedName: { type: String, match: /^[a-f0-9]{32}$/ }, // OLD messages only: file on disk, random name
    originalName: { type: String, maxlength: 120 },
    mime: String, // detected from the real file bytes, not from the browser
    size: Number
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // set by the SERVER only
    text: { type: String, default: '', maxlength: 4000 },
    attachment: { type: attachmentSchema, default: undefined },
    readAt: { type: Date, default: null },
    editedAt: Date,
    deletedAt: Date
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, _id: -1 });

// New collection name on purpose: your old global messages stay untouched in "messages"
// and no route can read them (they have no sender id or conversation, so they cannot be private).
module.exports = mongoose.model('Message', messageSchema, 'private_messages');
