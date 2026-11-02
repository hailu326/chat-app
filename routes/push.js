'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { pushLimiter } = require('../middleware/rateLimit');
const { validatePushSubscribe, validatePushUnsubscribe } = require('../middleware/validation');
const { getKey, subscribe, unsubscribe } = require('../controllers/pushController');

router.use(authenticate); // every route needs a valid login

router.get('/key', getKey);
router.post('/subscribe', pushLimiter, validatePushSubscribe, subscribe);
router.post('/unsubscribe', pushLimiter, validatePushUnsubscribe, unsubscribe);

module.exports = router;