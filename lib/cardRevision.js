const { createHash } = require('crypto');
function cardRevision(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
function assertCardRevision(currentRevision, expectedRevision, { required = false } = {}) {
  const missing = typeof expectedRevision !== 'string' || !expectedRevision.trim();
  if (missing && !required) return;
  if (!missing && expectedRevision === currentRevision) return;
  const error = new Error(missing
    ? 'Whole-card body replacement requires expectedRevision from a fresh card read. Read the card, merge your changes, then retry.'
    : 'Card changed since it was read. Read the card again, merge your changes with the latest content, then retry using its revision.');
  error.code = missing ? 'REVISION_REQUIRED' : 'REVISION_CONFLICT';
  error.details = { code: error.code, expectedRevision: expectedRevision || null, currentRevision, retryable: true, action: 'Read the card again and merge changes before retrying with its revision.' };
  throw error;
}
module.exports = { cardRevision, assertCardRevision };
