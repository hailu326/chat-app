'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

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
    tokenVersion: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Hash the password only when it was set or changed. Old accounts are already hashed.
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
