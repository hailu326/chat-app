'use strict';
const Conversation = require('../models/conversation');
const Message = require('../models/Message');

// THE core privacy check. The user id comes from the signed login cookie (req.user),
// never from the request. A conversation is found only if this user is one of its two members.
// "Not found" and "not a member" give the SAME answer, so nobody can probe which ids exist.
async function loadConversation(req, res, next) {
  const conversation = await Conversation.findOne({ _id: req.params.id, participants: req.user._id });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  req.conversation = conversation;
  next();
}

// For edit / delete / download of ONE message: the message must exist AND belong to a
// conversation that this user is a member of.
async function loadMessage(req, res, next) {
  const message = await Message.findById(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  const isMember = await Conversation.exists({ _id: message.conversation, participants: req.user._id });
  if (!isMember) return res.status(404).json({ error: 'Message not found' });
  req.message = message;
  next();
}

module.exports = { loadConversation, loadMessage };
