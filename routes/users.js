'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimit');
const { validateObjectIdParam } = require('../middleware/validation');
const { searchUsers, getUserById, getAvatar } = require('../controllers/userController');

router.use(authenticate); // every user route needs a valid login

router.get('/search', searchLimiter, searchUsers); // must stay above '/:userId'
router.get('/:userId/avatar', validateObjectIdParam('userId'), getAvatar);
router.get('/:userId', validateObjectIdParam('userId'), getUserById);

module.exports = router;
