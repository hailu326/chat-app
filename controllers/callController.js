'use strict';
const { buildIceServers } = require('../utils/callIce');

// The network helpers a call needs (with short-lived TURN passwords when a TURN relay is configured)
const getIce = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await buildIceServers({ userId: String(req.user._id) }));
};

module.exports = { getIce };