'use strict';
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Uploads first land in this TEMPORARY folder. The controller checks the file, copies it into
// MongoDB (GridFS) and deletes the temporary copy. Nothing stays here.
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(os.tmpdir(), 'hailacho-chat-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Messages sent BEFORE GridFS have their file in this old folder. It is only read, never written.
const LEGACY_DIR = path.join(__dirname, '..', 'private_uploads');

const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
const STORED_NAME = /^[a-f0-9]{32}$/;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  // Random name, no extension, no user input -> path traversal is impossible
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex'))
});

const uploader = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 5, fieldSize: 20 * 1024, parts: 10 }
});

// Accepts normal JSON messages AND multipart messages (text + one file).
// It must run AFTER authentication and the conversation-membership check.
function maybeUpload(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  uploader.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `File too large (max ${MAX_MB} MB)` : 'Invalid upload' });
    }
    next(err);
  });
}

const removeIn = (dir, name) =>
  STORED_NAME.test(String(name)) ? fs.promises.unlink(path.join(dir, name)).catch(() => {}) : Promise.resolve();
const removeTempFile = (name) => removeIn(UPLOAD_DIR, name);
const removeLegacyFile = (name) => removeIn(LEGACY_DIR, name);

// Clean up temporary files left behind by a crash (older than 1 hour)
function cleanOldTempFiles() {
  fs.promises
    .readdir(UPLOAD_DIR)
    .then((names) =>
      Promise.all(
        names.map(async (n) => {
          const p = path.join(UPLOAD_DIR, n);
          const st = await fs.promises.stat(p).catch(() => null);
          if (st && st.isFile() && Date.now() - st.mtimeMs > 60 * 60 * 1000) await fs.promises.unlink(p).catch(() => {});
        })
      )
    )
    .catch(() => {});
}
cleanOldTempFiles();
setInterval(cleanOldTempFiles, 60 * 60 * 1000).unref();

module.exports = { maybeUpload, removeTempFile, removeLegacyFile, UPLOAD_DIR, LEGACY_DIR, STORED_NAME, MAX_MB };
