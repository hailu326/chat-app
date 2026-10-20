'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { loginLimiter, loginAccountLimiter, registerLimiter } = require('../middleware/rateLimit');
const { validateRegistration, validateLogin, validateProfileUpdate } = require('../middleware/validation');
const { register, login, logout, logoutAll, getProfile, updateProfile } = require('../controllers/authController');

router.post('/register', registerLimiter, validateRegistration, register);
router.post('/login', loginLimiter, loginAccountLimiter, validateLogin, login);
router.post('/logout', logout);
router.post('/logout-all', authenticate, logoutAll);
router.get('/me', authenticate, getProfile);
router.patch('/me', authenticate, validateProfileUpdate, updateProfile);

module.exports = router;
