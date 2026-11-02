'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { iceLimiter } = require('../middleware/rateLimit');
const { getIce } = require('../controllers/callController');

router.use(authenticate); // every call route needs a valid login

router.get('/ice', iceLimiter, getIce);

module.exports = router;