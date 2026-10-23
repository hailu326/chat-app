'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { validateSettingsUpdate } = require('../middleware/validation');
const { getSettings, updateSettings } = require('../controllers/settingsController');

router.use(authenticate); // only logged-in users, and only their OWN settings

router.get('/', getSettings);
router.patch('/', validateSettingsUpdate, updateSettings);

module.exports = router;
