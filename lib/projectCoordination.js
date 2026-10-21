const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { atomicWriteFile } = require('./atomicFile');
const { withBoardTransaction, withFileTransaction } = require('./fileTransaction');
const { cardRevision, assertCardRevision } = require('./cardRevision');
const { assertAllowedPath, isInside } = require('./allowedPaths');
const cardFrontmatter = require('./cardFrontmatter');
const { readCardWithTimestamps } = require('./cardTimestamps');
const helpers = require('../shared/projectCoordination');
const { CARD_FIELDS, LIMITS, WORK_STATUSES, ATTENTION_TYPES, normalizeCardCoordination, normalizeProjectBrief } = helpers;
const PROJECT_FILE_NAME = '.signboard-project.md';
const PROJECT_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function validatePatch(patch, keys, label) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(patch)) {
    if (!keys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}.`);
    if (typeof patch[key] !== 'string') throw new Error(`${key} must be a string.`);
    if (LIMITS[key] && patch[key].length > LIMITS[key]) throw new Error(`${key} must be at most ${LIMITS[key]} characters.`);
  }
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value.trim()]));
}

function assertCoordinationRevision(currentRevision, expectedRevision, subject) {
  try {
    assertCardRevision(currentRevision, expectedRevision, { required: true });
  } catch (error) {
    if (!error.details) throw error;
    error.message = error.code === 'REVISION_REQUIRED'
      ? `Saving ${subject} requires expectedRevision from a fresh read.`
      : `${subject} changed since it was read. Read it again and merge your changes before retrying.`;
    error.details.action = `Read ${subject} again and merge changes before retrying with its revision.`;
    throw error;
  }
}

async function validateBoardRoot(boardRoot) {
  if (typeof boardRoot !== 'string' || !path.isAbsolute(boardRoot)) throw new Error('An absolute boardRoot is required.');
  const resolved = await fs.realpath(boardRoot);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('boardRoot must be a directory.');
  return resolved;
}

async function projectPath(boardRoot) {
  const root = await validateBoardRoot(boardRoot);
  const filePath = path.join(root, PROJECT_FILE_NAME);
  await assertAllowedPath([root], filePath, 'Project brief');
  // A sidecar is owned by its board. Do not replace a symlink or adopt a linked
  // document as Signboard data, even if it currently points inside the board.
  const entry = await fs.lstat(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Project brief must be a regular file inside its board.');
  return { root, filePath };
}

async function cardPathInBoard(boardRoot, cardPath) {
  const root = await validateBoardRoot(boardRoot);
  if (typeof cardPath !== 'string' || !path.isAbsolute(cardPath) || !cardPath.endsWith('.md')) throw new Error('An absolute Markdown cardPath is required.');
  const resolved = await assertAllowedPath([root], cardPath, 'Card');
  if (!isInside(root, resolved) || path.dirname(path.dirname(resolved)) !== root || !(await fs.stat(resolved)).isFile()) {
    throw new Error('Card must be in a list directly inside its board.');
  }
  return { root, filePath: resolved };
}

function parseProjectFile(raw) {
  const match = raw.toString('utf8').match(PROJECT_FRONTMATTER);
  let frontmatter;
  try {
    frontmatter = match && yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  } catch {
    throw new Error('Project brief has malformed YAML; repair it before saving.');
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter) || frontmatter.signboard_project !== 1) {
    throw new Error('Project brief is unrecognized; expected signboard_project: 1 frontmatter.');
  }
  for (const key of ['goal', 'next_step']) {
    if (frontmatter[key] !== undefined && typeof frontmatter[key] !== 'string') throw new Error(`Project brief ${key} must be a string.`);
  }
  return { frontmatter, body: raw.toString('utf8').slice(match[0].length) };
}

async function readProjectState(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { frontmatter: { signboard_project: 1 }, body: '', brief: { goal: '', nextStep: '', revision: 'missing', updatedAt: '' } };
  }
  const parsed = parseProjectFile(raw);
  const stat = await fs.stat(filePath);
  return { ...parsed, brief: { ...normalizeProjectBrief(parsed.frontmatter), revision: cardRevision(raw), updatedAt: stat.mtime.toISOString() } };
}

async function readProjectBrief(boardRoot) {
  const { filePath } = await projectPath(boardRoot);
  return (await readProjectState(filePath)).brief;
}

async function updateProjectBrief(boardRoot, patch, expectedRevision) {
  const cleaned = validatePatch(patch, ['goal', 'nextStep'], 'project patch');
  const root = await validateBoardRoot(boardRoot);
  return withBoardTransaction(root, async () => {
    const { filePath } = await projectPath(root);
    return withFileTransaction(filePath, async () => {
      const current = await readProjectState(filePath);
      assertCoordinationRevision(current.brief.revision, expectedRevision, 'project details');
      const next = { ...current.brief, ...cleaned };
      if (next.goal === current.brief.goal && next.nextStep === current.brief.nextStep) return { ok: true, ...current.brief };
      const frontmatter = { ...current.frontmatter };
      if (Object.hasOwn(cleaned, 'goal')) frontmatter.goal = cleaned.goal;
      if (Object.hasOwn(cleaned, 'nextStep')) frontmatter.next_step = cleaned.nextStep;
      const content = `---\n${yaml.dump(frontmatter, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1 })}---\n${current.body}`;
      await atomicWriteFile(filePath, content, 'utf8');
      return { ok: true, ...(await readProjectState(filePath)).brief };
    });
  });
}

function applyCoordinationPatch(frontmatter, patch) {
  const cleaned = validatePatch(patch, ['workStatus', 'attention', 'request', 'nextStep', 'evidence', 'summary'], 'coordination patch');
  if (Object.hasOwn(cleaned, 'workStatus') && !WORK_STATUSES.includes(cleaned.workStatus)) throw new Error('workStatus must be idle, working, or blocked.');
  if (Object.hasOwn(cleaned, 'attention') && !ATTENTION_TYPES.includes(cleaned.attention)) throw new Error('attention must be none, decision, question, or review.');
  const current = normalizeCardCoordination(frontmatter);
  const next = { ...current, ...cleaned };
  if (next.attention !== 'none' && !next.request) throw new Error('A request is required when attention is decision, question, or review.');
  const changed = Object.keys(cleaned).some((key) => cleaned[key] !== frontmatter[CARD_FIELDS[key]]);
  if (!changed) return { frontmatter, changed: false };
  const result = { ...frontmatter };
  for (const [key, value] of Object.entries(cleaned)) result[CARD_FIELDS[key]] = value;
  if (next.attention !== 'none' && (next.attention !== current.attention || next.request !== current.request)) result.sb_response = '';
  result.sb_updated_at = new Date().toISOString();
  return { frontmatter: result, changed: true };
}

async function mutateCard(boardRoot, cardPath, expectedRevision, mutate) {
  const { root, filePath } = await cardPathInBoard(boardRoot, cardPath);
  return withBoardTransaction(root, () => withFileTransaction(filePath, async () => {
    await cardPathInBoard(root, filePath);
    const current = await readCardWithTimestamps(filePath);
    assertCoordinationRevision(current.revision, expectedRevision, 'card coordination');
    const next = mutate(current.frontmatter);
    if (next.changed) await cardFrontmatter.writeCard(filePath, { frontmatter: next.frontmatter, body: current.body, expectedRevision: current.revision });
    const card = next.changed ? await readCardWithTimestamps(filePath) : current;
    return { ok: true, card: { ...card, coordination: normalizeCardCoordination(card.frontmatter) } };
  }));
}

async function updateCardCoordination(boardRoot, cardPath, patch, expectedRevision) {
  return mutateCard(boardRoot, cardPath, expectedRevision, (frontmatter) => applyCoordinationPatch(frontmatter, patch));
}

async function respondToCardRequest(boardRoot, cardPath, response, expectedRevision) {
  const cleaned = validatePatch({ response }, ['response'], 'response').response;
  if (!cleaned) throw new Error('A response is required.');
  return mutateCard(boardRoot, cardPath, expectedRevision, (frontmatter) => {
    const current = normalizeCardCoordination(frontmatter);
    if (current.attention === 'none' || !current.request) throw new Error('This card has no pending request. Refresh before responding.');
    return { changed: true, frontmatter: { ...frontmatter, sb_attention: 'none', sb_response: cleaned, sb_updated_at: new Date().toISOString() } };
  });
}

module.exports = { ...helpers, PROJECT_FILE_NAME, readProjectBrief, updateProjectBrief, updateCardCoordination, respondToCardRequest, applyCoordinationPatch };
