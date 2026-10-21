const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const coordination = require('../lib/projectCoordination');
const cards = require('../lib/cardFrontmatter');
const { readBoardSnapshot } = require('../lib/boardSnapshot');

async function childUpdate(kind, root, filePath, revision, value) {
  try {
    const result = kind === 'card'
      ? await coordination.updateCardCoordination(root, filePath, { summary: value }, revision)
      : await coordination.updateProjectBrief(root, { goal: value }, revision);
    process.stdout.write(JSON.stringify({ ok: result.ok }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ code: error.code }));
  }
}

async function testPreloadCoordinationFailures() {
  const exposed = {};
  const calls = [];
  const failure = { ok: false, error: 'Changed since read', details: { code: 'REVISION_CONFLICT', expectedRevision: 'old', currentRevision: 'latest' } };
  const context = vm.createContext({ require: (name) => {
    assert.strictEqual(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      ipcRenderer: { invoke: async (channel, payload) => {
        assert.strictEqual(channel, 'board-call');
        calls.push(payload);
        if (payload.op === 'readProjectBrief') throw new Error('Unreadable brief');
        return failure;
      } },
    };
  } });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../preload.js'), 'utf8'), context);
  for (const [operation, value] of [['updateProjectBrief', { goal: 'Goal' }], ['updateCardCoordination', { summary: 'Summary' }], ['respondToCardRequest', 'Answer']]) {
    const result = await exposed.board[operation]('/board/path', value, 'old');
    assert.strictEqual(result, failure, 'write failures must remain structured data across the bridge');
    assert.strictEqual(result.details.code, 'REVISION_CONFLICT');
    assert.strictEqual(calls.at(-1).op, operation);
    assert.strictEqual(calls.at(-1).args[2], 'old');
  }
  await assert.rejects(exposed.board.readProjectBrief('/board/path'), /Unreadable brief/);
}

async function run() {
  await testPreloadCoordinationFailures();
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-coordination-'));
  const root = path.join(fixture, 'Board');
  const list = path.join(root, '001-Doing-stock');
  const cardPath = path.join(list, '001-task-abc12.md');
  const briefPath = path.join(root, '.signboard-project.md');
  await fs.mkdir(list, { recursive: true });
  try {
    const initial = '# Legacy card\n\nBody stays intact.\n';
    await fs.writeFile(cardPath, initial);
    assert.deepStrictEqual(coordination.normalizeCardCoordination({}), {
      workStatus: 'idle', attention: 'none', request: '', nextStep: '', evidence: '', summary: '', response: '', updatedAt: '',
    });
    assert.strictEqual(coordination.normalizeCardCoordination({ sb_work_status: {}, sb_attention: 'made-up', sb_request: [], sb_updated_at: 'invalid' }).attention, 'none');
    const beforeRead = await fs.readdir(root);
    assert.deepStrictEqual(await coordination.readProjectBrief(root), { goal: '', nextStep: '', revision: 'missing', updatedAt: '' });
    assert.deepStrictEqual(await fs.readdir(root), beforeRead, 'reading a legacy board must not create a sidecar');
    assert.strictEqual(await fs.readFile(cardPath, 'utf8'), initial);
    const snapshot = await readBoardSnapshot(root, { includeBoardSettings: false });
    assert.strictEqual(snapshot.lists[0].cards[0].revision, (await cards.readCard(cardPath)).revision);
    const lean = await readBoardSnapshot(root, { includeBoardSettings: false, includeTimestamps: false });
    assert.strictEqual(lean.lists[0].cards[0].revision, snapshot.lists[0].cards[0].revision);

    await assert.rejects(coordination.updateProjectBrief(root, { goal: 'Goal' }), { code: 'REVISION_REQUIRED' });
    const created = await coordination.updateProjectBrief(root, { goal: 'Goal', nextStep: 'Next' }, 'missing');
    assert.strictEqual(created.goal, 'Goal');
    assert(created.revision.startsWith('sha256:'));
    let bytes = await fs.readFile(briefPath);
    await assert.rejects(coordination.updateProjectBrief(root, { goal: 'Stale' }, 'missing'), { code: 'REVISION_CONFLICT' });
    assert.deepStrictEqual(await fs.readFile(briefPath), bytes);
    const noOp = await coordination.updateProjectBrief(root, { goal: 'Goal' }, created.revision);
    assert.strictEqual(noOp.updatedAt, created.updatedAt);
    await fs.writeFile(briefPath, '---\nsignboard_project: 1\ngoal: Original\nunknown: [keep, me]\n---\nPersonal notes.\n');
    const custom = await coordination.readProjectBrief(root);
    await coordination.updateProjectBrief(root, { nextStep: 'Follow up' }, custom.revision);
    assert.match(await fs.readFile(briefPath, 'utf8'), /unknown:\n  - keep\n  - me/);
    assert((await fs.readFile(briefPath, 'utf8')).endsWith('Personal notes.\n'));
    for (const raw of ['plain note', '---\nsignboard_project: 2\n---\n', '---\nsignboard_project: 1\ngoal: [\n---\n', '---\nsignboard_project: 1\ngoal: []\n---\n']) {
      await fs.writeFile(briefPath, raw);
      await assert.rejects(coordination.readProjectBrief(root));
      await assert.rejects(coordination.updateProjectBrief(root, { goal: 'Overwrite' }, 'missing'));
      assert.strictEqual(await fs.readFile(briefPath, 'utf8'), raw);
    }
    await fs.unlink(briefPath);
    for (const patch of [{ goal: 'x'.repeat(501) }, { next_step: 'bad API' }, { goal: null }]) {
      await assert.rejects(coordination.updateProjectBrief(root, patch, 'missing'));
    }

    let card = await cards.readCard(cardPath);
    await assert.rejects(coordination.updateCardCoordination(root, cardPath, { summary: 'Missing revision' }), { code: 'REVISION_REQUIRED' });
    for (const patch of [{ attention: 'decision' }, { workStatus: 'done' }, { attention: 'urgent' }, { response: 'Agent answer' }, { sb_response: 'Agent answer' }, { nextStep: 'x'.repeat(501) }, { request: 'x'.repeat(2001) }, { evidence: [] }]) {
      await assert.rejects(coordination.updateCardCoordination(root, cardPath, patch, card.revision));
      assert.strictEqual(await fs.readFile(cardPath, 'utf8'), initial);
    }
    // Explicit idle must be stored so it can override a conventional Doing list.
    let result = await coordination.updateCardCoordination(root, cardPath, { workStatus: 'idle' }, card.revision);
    assert.strictEqual(result.card.frontmatter.sb_work_status, 'idle');
    card = result.card;
    const originalBody = card.body;
    result = await coordination.updateCardCoordination(root, cardPath, { workStatus: 'blocked', attention: 'question', request: 'Which option?', nextStep: 'Apply the answer' }, card.revision);
    assert.strictEqual(result.card.coordination.evidence, '', 'evidence is optional');
    assert.strictEqual(result.card.body, originalBody);
    const requestCard = result.card;
    bytes = await fs.readFile(cardPath);
    await assert.rejects(coordination.updateCardCoordination(root, cardPath, { summary: 'Stale' }, card.revision), { code: 'REVISION_CONFLICT' });
    assert.deepStrictEqual(await fs.readFile(cardPath), bytes);
    await assert.rejects(coordination.respondToCardRequest(root, cardPath, '', requestCard.revision));
    await assert.rejects(coordination.respondToCardRequest(root, cardPath, 'x'.repeat(4001), requestCard.revision));
    result = await coordination.respondToCardRequest(root, cardPath, 'Use option B.', requestCard.revision);
    assert.strictEqual(result.card.coordination.attention, 'none');
    assert.strictEqual(result.card.coordination.workStatus, 'blocked');
    assert.strictEqual(result.card.coordination.request, 'Which option?');
    assert.strictEqual(result.card.body, originalBody);
    assert.strictEqual(path.dirname(cardPath), list);
    result = await coordination.updateCardCoordination(root, cardPath, { summary: 'Applying B', workStatus: 'working' }, result.card.revision);
    assert.strictEqual(result.card.coordination.response, 'Use option B.', 'status/summary updates preserve human response');
    bytes = await fs.readFile(cardPath);
    const unchanged = await coordination.updateCardCoordination(root, cardPath, { summary: 'Applying B' }, result.card.revision);
    assert.strictEqual(unchanged.card.revision, result.card.revision);
    assert.deepStrictEqual(await fs.readFile(cardPath), bytes);
    result = await coordination.updateCardCoordination(root, cardPath, { attention: 'review', request: 'Review the result?' }, result.card.revision);
    assert.strictEqual(result.card.coordination.response, '', 'a new request clears the previous response');
    await cards.updateFrontmatter(cardPath, { custom: { nested: 'preserve' } });
    card = await cards.readCard(cardPath);
    result = await coordination.updateCardCoordination(root, cardPath, { evidence: 'Test passed' }, card.revision);
    assert.deepStrictEqual(result.card.frontmatter.custom, { nested: 'preserve' });
    assert.strictEqual(result.card.body, originalBody);

    // Independent processes share the board/file lock: one stale CAS loses.
    const race = async (kind, revision) => Promise.all(['First', 'Second'].map(async (value) => {
      const child = await execFileAsync(process.execPath, [__filename, '--child', kind, root, cardPath, revision, value]);
      return JSON.parse(child.stdout);
    }));
    let outcomes = await race('card', result.card.revision);
    assert.strictEqual(outcomes.filter((entry) => entry.ok).length, 1);
    assert.strictEqual(outcomes.filter((entry) => entry.code === 'REVISION_CONFLICT').length, 1);
    outcomes = await race('brief', 'missing');
    assert.strictEqual(outcomes.filter((entry) => entry.ok).length, 1);
    assert.strictEqual(outcomes.filter((entry) => entry.code === 'REVISION_CONFLICT').length, 1);

    const outside = path.join(fixture, 'Outside');
    await fs.mkdir(outside);
    const externalFile = path.join(outside, 'private.md');
    await fs.writeFile(externalFile, '---\nsignboard_project: 1\ngoal: Private\n---\n');
    const privateBytes = await fs.readFile(externalFile);
    await fs.unlink(briefPath);
    await fs.symlink(externalFile, briefPath);
    await assert.rejects(coordination.readProjectBrief(root), /outside|regular file/);
    await assert.rejects(coordination.updateProjectBrief(root, { goal: 'Bad' }, 'missing'), /outside|regular file/);
    assert.deepStrictEqual(await fs.readFile(externalFile), privateBytes);
    const escapeCard = path.join(list, '002-escape-abcde.md');
    await fs.symlink(externalFile, escapeCard);
    await assert.rejects(coordination.updateCardCoordination(root, escapeCard, { summary: 'Bad' }, 'missing'), /outside/);
    await fs.unlink(briefPath);
    const rootAlias = path.join(fixture, 'Board alias');
    await fs.symlink(root, rootAlias);
    assert.strictEqual((await coordination.updateProjectBrief(rootAlias, { goal: 'Alias works' }, 'missing')).goal, 'Alias works');
    const dangling = path.join(root, 'missing.md');
    await fs.unlink(briefPath);
    await fs.symlink(dangling, briefPath);
    await assert.rejects(coordination.readProjectBrief(root), /symbolic link/);

    // Exercise the real desktop IPC operation branches with the trusted-root
    // gate isolated from Electron. Canonical validation happens after that gate.
    const mainSource = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
    const start = mainSource.indexOf('async function handleBoardCall(');
    const end = mainSource.indexOf("ipcMain.handle('board-call'", start);
    const context = vm.createContext({
      projectCoordination: coordination,
      requireReadableBoardRoot: (_sender, value) => { assert.strictEqual(value, root); return value; },
      requireWritableBoardRoot: (_sender, value) => { assert.strictEqual(value, root); return value; },
      requireWritablePath: (_sender, value) => value,
      resolveTrustedBoardRootForPath: () => root,
    });
    vm.runInContext(mainSource.slice(start, end), context);
    await assert.rejects(context.handleBoardCall({ sender: {} }, { op: 'readProjectBrief', args: [root] }), /symbolic link/);
    await assert.rejects(context.handleBoardCall({ sender: {} }, { op: 'updateProjectBrief', args: [root, { goal: 'Escape' }, 'missing'] }), /symbolic link/);
    await assert.rejects(context.handleBoardCall({ sender: {} }, { op: 'updateCardCoordination', args: [escapeCard, { summary: 'Escape' }, 'missing'] }), /outside/);
    assert.deepStrictEqual(await fs.readFile(externalFile), privateBytes);
    console.log('Project coordination tests passed (CAS, cross-process races, preservation, bounds, symlinks, desktop IPC).');
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') childUpdate(...process.argv.slice(3)).catch((error) => { console.error(error); process.exitCode = 1; });
else run().catch((error) => { console.error(error); process.exitCode = 1; });
