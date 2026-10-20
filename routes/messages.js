'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { messageLimiter } = require('../middleware/rateLimit');
const { maybeUpload } = require('../middleware/upload');
const { loadConversation, loadMessage } = require('../middleware/conversationAccess');
const {
  validateObjectIdParam,
  validateOpenConversation,
  validateSendMessage,
  validateEditMessage
} = require('../middleware/validation');
const {
  listConversations,
  openConversation,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  downloadAttachment
} = require('../controllers/messageController');

// Every route below needs a valid login
router.use(['/conversations', '/messages'], authenticate);

router.get('/conversations', listConversations);
router.post('/conversations', validateOpenConversation, openConversation);

// ORDER MATTERS here: login -> limit -> valid id -> membership check -> (file upload) -> validation -> action
router.get('/conversations/:id/messages', validateObjectIdParam('id'), loadConversation, getMessages);
router.post(
  '/conversations/:id/messages',
  messageLimiter,
  validateObjectIdParam('id'),
  loadConversation,
  maybeUpload,
  validateSendMessage,
  sendMessage
);
router.post('/conversations/:id/read', validateObjectIdParam('id'), loadConversation, markRead);

router.patch('/messages/:id', messageLimiter, validateObjectIdParam('id'), validateEditMessage, loadMessage, editMessage);
router.delete('/messages/:id', messageLimiter, validateObjectIdParam('id'), loadMessage, deleteMessage);
router.get('/messages/:id/attachment', validateObjectIdParam('id'), loadMessage, downloadAttachment);

module.exports = router;
