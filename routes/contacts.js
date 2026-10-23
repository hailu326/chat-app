'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { contactsLimiter } = require('../middleware/rateLimit');
const { validateContactMatch } = require('../middleware/validation');
const { matchContacts } = require('../controllers/contactController');

router.use(authenticate); // every contacts route needs a valid login

router.post('/match', contactsLimiter, validateContactMatch, matchContacts);

module.exports = router;
