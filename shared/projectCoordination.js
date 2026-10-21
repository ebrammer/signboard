(function initializeProjectCoordination(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.SignboardProjectCoordination = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProjectCoordination() {
  const WORK_STATUSES = Object.freeze(['idle', 'working', 'blocked']);
  const ATTENTION_TYPES = Object.freeze(['none', 'decision', 'question', 'review']);
  const CARD_FIELDS = Object.freeze({
    workStatus: 'sb_work_status', attention: 'sb_attention', request: 'sb_request',
    nextStep: 'sb_next_step', evidence: 'sb_evidence', summary: 'sb_summary',
    response: 'sb_response', updatedAt: 'sb_updated_at',
  });
  const LIMITS = Object.freeze({ goal: 500, nextStep: 500, request: 2000, evidence: 2000, summary: 2000, response: 4000 });
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  function normalizeCardCoordination(frontmatter) {
    const source = object(frontmatter);
    const result = {
      workStatus: WORK_STATUSES.includes(source.sb_work_status) ? source.sb_work_status : 'idle',
      attention: ATTENTION_TYPES.includes(source.sb_attention) ? source.sb_attention : 'none',
    };
    for (const key of ['request', 'nextStep', 'evidence', 'summary', 'response']) {
      result[key] = text(source[CARD_FIELDS[key]], LIMITS[key]);
    }
    const timestamp = source.sb_updated_at;
    result.updatedAt = typeof timestamp === 'string' && timestamp.trim() && Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString() : '';
    return result;
  }
  function normalizeProjectBrief(value) {
    const source = object(value);
    return { goal: text(source.goal, LIMITS.goal), nextStep: text(source.nextStep === undefined ? source.next_step : source.nextStep, LIMITS.nextStep) };
  }
  return { WORK_STATUSES, ATTENTION_TYPES, CARD_FIELDS, LIMITS, normalizeCardCoordination, normalizeProjectBrief };
});
