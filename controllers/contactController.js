'use strict';
const User = require('../models/User');
const { userPublic } = require('../utils/dto');
const { phoneHashOf } = require('../utils/phone');

// The browser sends ONLY phone numbers (never contact names). They are turned into secret fingerprints in memory,
// compared with the fingerprints in the database, and then forgotten. Nothing about the request is saved or logged.
const matchContacts = async (req, res) => {
  const phones = req.body.phones;

  const byHash = new Map(); // fingerprint -> positions in the list the browser sent
  let invalid = 0;
  phones.forEach((p, i) => {
    const h = phoneHashOf(p);
    if (!h) {
      invalid += 1;
      return;
    }
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(i);
  });
  if (byHash.size === 0) return res.json({ matches: [], checked: 0, invalid });

  const users = await User.find({
    _id: { $ne: req.user._id }, // you never find yourself
    phoneHash: { $in: [...byHash.keys()] },
    'settings.discoverableByPhone': { $ne: false } // people who turned this off are invisible here
  })
    .select('name updatedAt +phoneHash')
    .limit(500)
    .lean();

  res.json({
    // only id, name and photo link, never a phone number, email or fingerprint
    matches: users.map((u) => ({ user: userPublic(u), indexes: byHash.get(u.phoneHash) || [] })),
    checked: byHash.size,
    invalid
  });
};

module.exports = { matchContacts };
