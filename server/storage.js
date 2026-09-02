const crypto = require('crypto');

// Attachments used to be embedded as base64 `dataUrl` strings directly inside
// the (encrypted) project JSON blob. That meant every project save/load
// moved the full attachment bytes through Postgres and through Node's
// encrypt/decrypt path, even when nothing about the attachment changed —
// and it's the single biggest contributor to per-project blob size at scale.
//
// This module moves the actual bytes to S3-compatible object storage
// (Railway Buckets, AWS S3, or anything else that speaks the S3 API) and
// leaves only a lightweight reference — id, name, size, content type — in
// the project blob. Encryption at rest is still enforced: objects are
// encrypted client-side (inside this module) with the same envelope scheme
// as everything else in crypto.js, then uploaded as opaque ciphertext, so
// the object storage provider never sees plaintext file contents either.
//
// Gracefully disabled (falls back to the old inline-dataUrl behavior) if
// S3_* env vars aren't configured, so this doesn't break local dev or a
// deployment that hasn't set up a bucket yet.

const dataCrypto = require('./crypto');

const BUCKET = process.env.S3_BUCKET;
const configured = Boolean(BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);

let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, s3;

if (configured) {
  try {
    ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
    s3 = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined, // set for Railway Buckets / non-AWS providers
      forcePathStyle: Boolean(process.env.S3_ENDPOINT), // most S3-compatible providers need this
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    console.log(`Attachment storage: using S3-compatible bucket "${BUCKET}".`);
  } catch (err) {
    console.warn('S3_* env vars are set but @aws-sdk packages failed to load — attachments will stay inline.', err.message);
  }
} else {
  console.log('Attachment storage: S3_* env vars not set — attachments stay inline in the project blob (fine for small scale).');
}

function isEnabled() {
  return configured && Boolean(s3);
}

// Uploads one attachment's bytes (already-decoded Buffer). Reuses the exact
// same encryptField()/decryptField() envelope used for every other row in
// this app (see crypto.js) rather than inventing a separate buffer-crypto
// path — the ciphertext token already self-describes its key version, so
// there's nothing extra to track here. Returns the lightweight reference to
// store in the project blob instead of the raw dataUrl.
async function uploadAttachment({ projectId, name, contentType, buffer }) {
  const key = `attachments/${projectId}/${crypto.randomUUID()}`;
  const token = dataCrypto.encryptField(buffer.toString('base64'), `attachment:${projectId}:${key}`);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: token,
    ContentType: 'text/plain', // the object body is our own ciphertext envelope, not the real file
  }));
  return { storageKey: key, name, contentType, sizeBytes: buffer.length };
}

// Downloads + decrypts one attachment back to a Buffer, for the download
// route to stream to the browser.
async function downloadAttachment({ projectId, storageKey }) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }));
  const chunks = [];
  for await (const chunk of obj.Body) chunks.push(chunk);
  const token = Buffer.concat(chunks).toString('utf8');
  const base64 = dataCrypto.decryptField(token, `attachment:${projectId}:${storageKey}`);
  return Buffer.from(base64, 'base64');
}

async function deleteAttachment(storageKey) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }));
}

module.exports = { isEnabled, uploadAttachment, downloadAttachment, deleteAttachment };
