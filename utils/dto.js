'use strict';
// "DTO" = exactly what we are allowed to send to the browser. Never send whole database documents.

const hasFile = (a) => !!(a && (a.fileId || a.storedName));

const avatarUrl = (u) =>
  `/api/users/${u._id}/avatar?v=${u.updatedAt ? new Date(u.updatedAt).getTime() : 0}`;

// Only for the logged-in user's OWN data
const userSelf = (u) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  phone: u.phone || '',
  avatarUrl: avatarUrl(u)
});

// What OTHER users may see: name and photo only (never email or phone)
const userPublic = (u) => ({ id: String(u._id), name: u.name, avatarUrl: avatarUrl(u) });

const messageDTO = (m) => {
  const deleted = !!m.deletedAt;
  const att = hasFile(m.attachment) ? m.attachment : null;
  return {
    id: String(m._id),
    conversationId: String(m.conversation),
    senderId: String(m.sender),
    text: deleted ? '' : m.text || '',
    deleted,
    edited: !!m.editedAt,
    attachment:
      !deleted && att
        ? { name: att.originalName, mime: att.mime, size: att.size, url: `/api/messages/${m._id}/attachment` }
        : null,
    createdAt: m.createdAt,
    readAt: m.readAt || null
  };
};

const lastMessageDTO = (m, meId) => {
  if (!m) return null;
  const deleted = !!m.deletedAt;
  return {
    text: deleted ? '' : String(m.text || '').slice(0, 80),
    attachmentName: !deleted && hasFile(m.attachment) ? m.attachment.originalName : null,
    deleted,
    mine: String(m.sender) === String(meId),
    createdAt: m.createdAt
  };
};

const conversationDTO = ({ conv, partner, unread, last, meId, online }) => ({
  id: String(conv._id),
  partner: partner ? userPublic(partner) : { id: '', name: 'Deleted user', avatarUrl: '' },
  online: !!online,
  unread: unread || 0,
  lastMessage: lastMessageDTO(last, meId),
  lastMessageAt: conv.lastMessageAt
});

module.exports = { hasFile, userSelf, userPublic, messageDTO, lastMessageDTO, conversationDTO };
