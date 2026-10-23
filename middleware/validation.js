'use strict';
const { body, param, validationResult } = require('express-validator');
const fs = require('fs');

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const isObjectId = (v) => typeof v === 'string' && OBJECT_ID.test(v);

// FIX: the old version sent back errors.array() which includes the submitted VALUE
// (a password could be echoed back). Now only the field name and message are returned.
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {}); // remove an already-uploaded file
  res.status(400).json({
    error: 'Validation failed',
    details: errors.array().map((e) => ({ field: e.path, message: e.msg }))
  });
};

// Every rule starts with isString(): objects like {"$ne": null} are rejected -> no NoSQL injection.
const nameRule = (optional = false) => {
  let c = body('name');
  if (optional) c = c.optional();
  return c
    .isString().withMessage('Name must be text').bail()
    .trim()
    .isLength({ min: 2, max: 50 }).withMessage('Name must be 2-50 characters').bail()
    .custom((v) => !/[\u0000-\u001f\u007f<>]/.test(v)).withMessage('Name contains invalid characters');
};

const emailRule = () =>
  body('email')
    .isString().withMessage('Email must be text').bail()
    .trim()
    .toLowerCase()
    .isEmail().withMessage('Please provide a valid email').bail()
    .isLength({ max: 254 }).withMessage('Email is too long');

const passwordRule = (field) =>
  body(field)
    .isString().withMessage('Password must be text').bail()
    .isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters').bail()
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password needs an uppercase letter, a lowercase letter and a number').bail()
    .custom((v) => Buffer.byteLength(v, 'utf8') <= 72).withMessage('Password is too long');

const phoneRule = () =>
  body('phone')
    .optional({ values: 'falsy' })
    .isString().withMessage('Phone must be text').bail()
    .trim()
    .matches(/^\+?[0-9]{7,15}$/).withMessage('Please provide a valid phone number');

// The real image check (magic bytes) happens in the controller; this only limits the size.
const avatarRule = () =>
  body('avatar')
    .optional({ values: 'falsy' })
    .isString().withMessage('Invalid image').bail()
    .isLength({ max: 300000 }).withMessage('Image is too large');

const textRule = () =>
  body('text')
    .optional()
    .isString().withMessage('Message must be text').bail()
    .isLength({ max: 4000 }).withMessage('Message too long (max 4000 characters)');

const validateRegistration = [nameRule(), emailRule(), passwordRule('password'), phoneRule(), avatarRule(), handleValidationErrors];

const validateLogin = [
  emailRule(),
  body('password').isString().withMessage('Password is required').bail().isLength({ min: 1, max: 128 }).withMessage('Password is required'),
  handleValidationErrors
];

const validateProfileUpdate = [
  nameRule(true),
  phoneRule(),
  avatarRule(),
  body('newPassword').optional({ values: 'falsy' }).isString().bail().isLength({ min: 8, max: 72 }).withMessage('Password must be 8-72 characters').bail()
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password needs an uppercase letter, a lowercase letter and a number').bail()
    .custom((v) => Buffer.byteLength(v, 'utf8') <= 72).withMessage('Password is too long'),
  body('currentPassword').optional({ values: 'falsy' }).isString().withMessage('Invalid password').bail().isLength({ max: 128 }),
  handleValidationErrors
];

const validateObjectIdParam = (name) => [param(name).isMongoId().withMessage('Invalid id'), handleValidationErrors];

const validateOpenConversation = [body('userId').isString().bail().isMongoId().withMessage('Invalid user id'), handleValidationErrors];

// Runs after multer, so "text" is available for both JSON and multipart requests
const validateSendMessage = [textRule(), body('text').optional().trim(), handleValidationErrors];

const validateEditMessage = [
  body('text').isString().withMessage('Message must be text').bail().isLength({ max: 4000 }).withMessage('Message too long (max 4000 characters)'),
  body('text').trim(),
  handleValidationErrors
];

// Settings: every field is optional, but when it is present it must be a real true / false
const SETTING_KEYS = ['readReceipts', 'showOnline', 'showTyping', 'discoverableByPhone'];
const validateSettingsUpdate = [
  ...SETTING_KEYS.map((k) => body(k).optional().custom((v) => typeof v === 'boolean').withMessage(`${k} must be true or false`)),
  handleValidationErrors
];

// Contact lookup: a list of 1-300 phone numbers (contact names are never sent)
const validateContactMatch = [
  body('phones').isArray({ min: 1, max: 300 }).withMessage('Send between 1 and 300 phone numbers'),
  body('phones.*').isString().withMessage('Each phone number must be text').bail().isLength({ min: 3, max: 40 }).withMessage('Invalid phone number'),
  handleValidationErrors
];

module.exports = {
  isObjectId,
  handleValidationErrors,
  validateRegistration,
  validateLogin,
  validateProfileUpdate,
  validateObjectIdParam,
  validateOpenConversation,
  validateSendMessage,
  validateEditMessage,
  validateSettingsUpdate,
  validateContactMatch
};
