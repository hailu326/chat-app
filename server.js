'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const { Server } = require('socket.io');

const connectDB = require('./config/dbConfig');
const { assertAuthConfig, csrfGuard } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimit');
const attachSockets = require('./socket');
const User = require('./models/User');
const Conversation = require('./models/conversation');
const Message = require('./models/Message');

const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

assertAuthConfig(); // refuse to start without a strong JWT_SECRET

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
// Behind a hosting proxy (Render, Railway ...) we need this so IPs and "Secure" cookies work correctly
if (isProd || process.env.TRUST_PROXY) app.set('trust proxy', 1);

// Security headers. The page may load scripts only from this site (no inline scripts).
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': isProd ? [] : null // http://localhost must keep working in development
      }
    }
  })
);

// Hosting platforms call this to see that the app is alive (no secrets, no database access)
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.json({ limit: '350kb' })); // big enough for a small avatar, small enough to stop abuse

// Same-site check + rate limit for the whole API
app.use('/api', apiLimiter, csrfGuard);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api', require('./routes/messages'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Android reads /.well-known/assetlinks.json to trust the installable Android app (only that folder is allowed)
app.use('/.well-known', express.static(path.join(__dirname, 'public', '.well-known'), { dotfiles: 'allow', index: false }));

// Only the "public" folder is served. The old public /uploads route is gone on purpose.
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore' }));

// Safe errors: the browser never sees stack traces, database details or secrets
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error('Unhandled error:', err.name, err.message); // message only: no request body, no tokens
  res.status(500).json({ error: 'Server error' });
});

// Sockets only carry small events now (files and avatars go through the authenticated REST API)
const io = new Server(server, { maxHttpBufferSize: 1e5 });
app.set('io', io);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.message ? reason.message : 'unknown');
});

// Start only when run as "node server.js". Tests import this file without starting anything.
if (require.main === module) {
  (async () => {
    await connectDB();
    await Promise.all([User.init(), Conversation.init(), Message.init()]); // make sure unique indexes exist
    attachSockets(io);
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })().catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { app, server, io };
