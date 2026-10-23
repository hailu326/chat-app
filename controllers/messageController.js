'use strict';
const mongoose = require('mongoose');
const path = require('path');
const Conversation = require('../models/conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const presence = require('../socket/presence');
const { normalizeSettings } = require('../utils/settings');
const { messageDTO, conversationDTO, hasFile } = require('../utils/dto');
const { detectType, readHead, sanitizeFileName } = require('../utils/fileType');
const { parseRange } = require('../utils/range');
const fileStore = require('../utils/fileStore');
const { LEGACY_DIR, removeTempFile, removeLegacyFile } = require('../middleware/upload');
const { isObjectId } = require('../middleware/validation');

const room = (conversationId) => `conv:${conversationId}`;
const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

// ---------- conversation list ----------
async function buildConversations(convs, meId) {
  if (convs.length === 0) return [];
  const me = toObjectId(meId);
  const partnerIds = convs.map((c) => c.participants.find((p) => String(p) !== String(me)));

  const [partners, unreadRows, lastMessages] = await Promise.all([
    User.find({ _id: { $in: partnerIds } }).select('name updatedAt settings').lean(),
    Message.aggregate([
      { $match: { conversation: { $in: convs.map((c) => c._id) }, sender: { $ne: me }, readAt: null, deletedAt: null } },
      { $group: { _id: '$conversation', n: { $sum: 1 } } }
    ]),
    Promise.all(convs.map((c) => Message.findOne({ conversation: c._id }).sort({ _id: -1 }).lean()))
  ]);

  const partnerById = new Map(partners.map((p) => [String(p._id), p]));
  const unreadById = new Map(unreadRows.map((r) => [String(r._id), r.n]));

  return convs.map((conv, i) => {
    const partner = partnerById.get(String(partnerIds[i]));
    return conversationDTO({
      conv,
      partner,
      unread: unreadById.get(String(conv._id)) || 0,
      last: lastMessages[i],
      meId,
      // hidden when the partner turned "show when I am online" off
      online: partner && presence.isOnline(partner._id) && normalizeSettings(partner.settings).showOnline
    });
  });
}

const listConversations = async (req, res) => {
  const convs = await Conversation.find({ participants: req.user._id }).sort({ lastMessageAt: -1 }).limit(100).lean();
  res.json({ conversations: await buildConversations(convs, req.user._id) });
};

// Get-or-create the private conversation between me and one other user
const openConversation = async (req, res) => {
  const meId = String(req.user._id);
  const otherId = String(toObjectId(req.body.userId)); // normalised lowercase hex
  if (otherId === meId) return res.status(400).json({ error: 'You cannot chat with yourself' });
  if (!(await User.exists({ _id: otherId }))) return res.status(404).json({ error: 'User not found' });

  const ids = [meId, otherId].sort();
  const key = ids.join('_');
  let conv = await Conversation.findOne({ participantKey: key });
  let created = false;
  if (!conv) {
    try {
      conv = await Conversation.create({ participants: ids, participantKey: key });
      created = true;
    } catch (err) {
      if (err && err.code === 11000) conv = await Conversation.findOne({ participantKey: key });
      else throw err;
    }
  }

  // Server decides who joins the room (never the browser)
  const io = req.app.get('io');
  if (io) {
    ids.forEach((id) => io.in(`user:${id}`).socketsJoin(room(conv._id)));
    if (created) io.to(`user:${otherId}`).emit('conversation:new', { conversationId: String(conv._id) });
  }

  const [dto] = await buildConversations([conv.toObject()], meId);
  res.status(created ? 201 : 200).json({ conversation: dto });
};

// ---------- messages ----------
const getMessages = async (req, res) => {
  const parsed = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 30, 1), 50);

  const filter = { conversation: req.conversation._id };
  if (req.query.before !== undefined) {
    if (!isObjectId(req.query.before)) return res.status(400).json({ error: 'Invalid cursor' });
    filter._id = { $lt: req.query.before };
  }

  const docs = await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit).reverse();
  res.json({ messages: page.map(messageDTO), hasMore });
};

const sendMessage = async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  const file = req.file; // a TEMPORARY copy on disk (see middleware/upload.js)
  let fileId; // the file's id inside MongoDB, once it is stored
  let result;

  try {
    let attachment;
    if (file) {
      const safeName = sanitizeFileName(file.originalname);
      const ext = path.extname(safeName).slice(1);
      const detected = detectType(await readHead(file.path), ext);
      if (!detected) {
        result = { status: 415, body: { error: 'This file type is not allowed' } };
      } else {
        fileId = await fileStore.saveFile(file.path, {
          name: safeName,
          mime: detected.mime,
          owner: req.user._id,
          conversation: req.conversation._id
        });
        attachment = { fileId, originalName: safeName, mime: detected.mime, size: file.size };
      }
    }

    if (!result && !text && !attachment) result = { status: 400, body: { error: 'Message is empty' } };

    if (!result) {
      // sender and conversation come from the server (login cookie + membership check), never from the body
      const message = await Message.create({
        conversation: req.conversation._id,
        sender: req.user._id,
        text,
        attachment
      });
      fileId = undefined; // the message now owns the file
      await Conversation.updateOne({ _id: req.conversation._id }, { $set: { lastMessageAt: message.createdAt } });

      const dto = messageDTO(message);
      const io = req.app.get('io');
      if (io) io.to(room(req.conversation._id)).emit('message:new', dto);
      result = { status: 201, body: { message: dto } };
    }
  } catch (err) {
    if (fileId) await fileStore.removeFile(fileId); // do not leave an orphan file in MongoDB
    throw err;
  } finally {
    if (file) await removeTempFile(file.filename); // the temporary copy is always deleted
  }

  res.status(result.status).json(result.body);
};

const editMessage = async (req, res) => {
  const msg = req.message;
  if (String(msg.sender) !== String(req.user._id)) {
    return res.status(403).json({ error: 'You can only edit your own messages' });
  }
  if (msg.deletedAt) return res.status(400).json({ error: 'This message was deleted' });

  const text = String(req.body.text || '').trim();
  if (!text && !hasFile(msg.attachment)) return res.status(400).json({ error: 'Message cannot be empty' });

  msg.text = text;
  msg.editedAt = new Date();
  await msg.save();

  const dto = messageDTO(msg);
  const io = req.app.get('io');
  if (io) io.to(room(msg.conversation)).emit('message:edited', dto);
  res.json({ message: dto });
};

// Soft delete: the row stays (so relationships are kept) but text and file are removed.
const deleteMessage = async (req, res) => {
  const msg = req.message;
  if (String(msg.sender) !== String(req.user._id)) {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }
  if (!msg.deletedAt) {
    const att = msg.attachment;
    msg.deletedAt = new Date();
    msg.text = '';
    msg.attachment = undefined;
    await msg.save();
    if (att && att.fileId) await fileStore.removeFile(att.fileId);
    else if (att && att.storedName) await removeLegacyFile(att.storedName);

    const io = req.app.get('io');
    if (io) io.to(room(msg.conversation)).emit('message:deleted', messageDTO(msg));
  }
  res.json({ message: messageDTO(msg) });
};

const markRead = async (req, res) => {
  const readAt = new Date();
  // If this reader turned "read receipts" off, the messages are still marked read for THEM (unread badge),
  // but the sender never sees the blue ticks.
  const sendReceipts = normalizeSettings(req.user.settings).readReceipts;
  const result = await Message.updateMany(
    { conversation: req.conversation._id, sender: { $ne: req.user._id }, readAt: null },
    { $set: { readAt, readHidden: !sendReceipts } }
  );
  if (result.modifiedCount > 0 && sendReceipts) {
    const io = req.app.get('io');
    if (io) {
      io.to(room(req.conversation._id)).emit('message:read', {
        conversationId: String(req.conversation._id),
        readerId: String(req.user._id),
        readAt
      });
    }
  }
  res.json({ ok: true, updated: result.modifiedCount });
};

// ---------- private file download ----------
const asciiName = (n) => n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
const encodeRFC5987 = (n) => encodeURIComponent(n).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Streams a file out of MongoDB. Supports "Range" requests, so videos and audio can be seeked.
function streamFromMongo(req, res, att, headers) {
  const size = att.size;
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.status(416).set('Content-Range', `bytes */${size}`).end();
    return;
  }

  headers['Accept-Ranges'] = 'bytes';
  if (range) {
    res.status(206);
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else {
    headers['Content-Length'] = String(size);
  }
  res.set(headers);

  const stream = fileStore.openStream(att.fileId, range);
  stream.on('error', () => {
    if (res.headersSent) return res.destroy();
    ['Content-Length', 'Content-Range', 'Accept-Ranges'].forEach((h) => res.removeHeader(h));
    res.status(404).json({ error: 'File not found' });
  });
  res.on('close', () => stream.destroy()); // the browser stopped reading
  stream.pipe(res);
}

const downloadAttachment = (req, res) => {
  const msg = req.message; // membership was already checked by loadMessage
  const att = msg.attachment;
  if (msg.deletedAt || !hasFile(att)) return res.status(404).json({ error: 'File not found' });

  // ?download=1 forces a real download (used by the "Download" button); otherwise pictures, video and audio show inline
  const forceDownload = req.query.download === '1';
  const inline = !forceDownload && /^(image|video|audio)\//.test(att.mime);
  const headers = {
    'Content-Type': att.mime, // the verified type, not what the uploader claimed
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName(att.originalName)}"; filename*=UTF-8''${encodeRFC5987(att.originalName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, max-age=3600'
  };

  if (att.fileId) return streamFromMongo(req, res, att, headers);

  // OLD messages (sent before GridFS): the file is in the legacy folder
  res.set(headers);
  res.sendFile(att.storedName, { root: LEGACY_DIR, dotfiles: 'deny', cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
  });
};

module.exports = {
  listConversations,
  openConversation,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  downloadAttachment
};
