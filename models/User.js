'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { phoneHashOf } = require('../utils/phone');

const BCRYPT_ROUNDS = 12;

// Same "users" collection and same field names as before (name, email, password, phone, profile),
// so your existing accounts keep working. New field: tokenVersion (used to cancel old logins).
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    // select:false -> the password hash and the avatar are NEVER loaded unless a query asks for them
    password: { type: String, required: true, select: false },
    phone: { type: String, trim: true, maxlength: 20 },
    profile: { type: String, select: false, maxlength: 400000 }, // avatar as a data URL
    tokenVersion: { type: Number, default: 0 },
    // Privacy switches (see utils/settings.js). Old accounts have no values here = the defaults apply.
    settings: {
      readReceipts: { type: Boolean, default: true },
      showOnline: { type: Boolean, default: true },
      showTyping: { type: Boolean, default: true },
      discoverableByPhone: { type: Boolean, default: true }
    },
    // Secret fingerprint of the phone number, used to find contacts (the number itself is not searched)
    phoneHash: { type: String, select: false, index: true }
  },
  { timestamps: true }
);

// Before saving: hash the password if it was set or changed (old accounts are already hashed),
// and refresh the phone fingerprint if the phone number changed.
userSchema.pre('save', async function () {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
  }
  if (this.isModified('phone')) {
    this.phoneHash = phoneHashOf(this.phone) || null;
  }
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
