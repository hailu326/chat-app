'use strict';
// Private file storage INSIDE MongoDB (GridFS). Nothing is kept on the server's disk, so files
// survive restarts and re-deploys on hosts that erase their disk (Render, Railway, ...).
// Files are never reachable directly: only through GET /api/messages/:id/attachment (membership check).
const fs = require('fs');
const mongoose = require('mongoose');

let bucket = null;
let bucketDb = null;

function getBucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');
  if (!bucket || bucketDb !== db) {
    bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'private_files' });
    bucketDb = db;
  }
  return bucket;
}

// Copies an already-verified temporary file into MongoDB. Resolves with the GridFS file id.
function saveFile(tempPath, { name, mime, owner, conversation }) {
  return new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(name, {
      metadata: { mime, owner: String(owner), conversation: String(conversation) }
    });
    const input = fs.createReadStream(tempPath);
    input.on('error', (err) => {
      upload.destroy();
      reject(err);
    });
    upload.on('error', reject);
    upload.on('finish', () => resolve(upload.id));
    input.pipe(upload);
  });
}

async function removeFile(id) {
  try {
    await getBucket().delete(id);
  } catch {
    /* already gone: fine */
  }
}

// range = { start, end } (both inclusive) or undefined for the whole file
function openStream(id, range) {
  return getBucket().openDownloadStream(id, range ? { start: range.start, end: range.end + 1 } : undefined);
}

module.exports = { saveFile, removeFile, openStream };
