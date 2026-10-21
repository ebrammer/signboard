const assert = require('assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { withFileTransaction, withBoardTransaction, withBoardRelocationTransaction } = require('../lib/fileTransaction');
const cards = require('../lib/cardFrontmatter');
const { renameManagedDirectory } = require('../lib/directoryRename');
const { importObsidian } = require('../lib/importers');

function client(root, { readOnly = false } = {}) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/signboard-mcp.js')], {
    env: { ...process.env, SIGNBOARD_MCP_ALLOWED_ROOTS: root, SIGNBOARD_MCP_READ_ONLY: String(readOnly) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0, buffer = '', stderr = '';
  const pending = new Map();
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    buffer += data;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message.result || message); }
    }
  });
  child.on('exit', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited: ${stderr}`)); }
    pending.clear();
  });
  return {
    child,
    call(name, args) {
      const nextId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(nextId); reject(new Error(`MCP timeout: ${stderr}`)); }, 15000);
        pending.set(nextId, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
    },
  };
}
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-safe-writes-'));
  const root = path.join(temp, 'Board'), list = '001-Inbox-abcde', other = '002-Done-fghij', file = '001-Legacy-abcde.md';
  const cardPath = path.join(root, list, file);
  const children = [];
  try {
    await fs.mkdir(path.dirname(cardPath), { recursive: true });
    await fs.mkdir(path.join(root, other));
    await fs.writeFile(cardPath, '# Legacy\ncustom: keep me\n**********\n\nOriginal body\n');
    await fs.chmod(cardPath, 0o640);
    const a = client(temp), b = client(temp); children.push(a.child, b.child);
    const args = { boardRoot: root, listName: list, cardFile: file };
    const created = await a.call('signboard_create_card', { boardRoot: root, listName: list, title: 'New safely created card', body: 'New body' });
    assert(!created.isError, JSON.stringify(created));
    assert.match(created.structuredContent.card.revision, /^sha256:/);
    const initial = (await a.call('signboard_read_card', args)).structuredContent.card;
    assert.match(initial.revision, /^sha256:[0-9a-f]{64}$/);
    for (let round = 0; round < 20; round++) {
      const results = await Promise.all([
        a.call('signboard_update_card', { ...args, addNote: `A-${round}` }),
        b.call('signboard_update_card', { ...args, addNote: `B-${round}` }),
      ]);
      assert(results.every(result => !result.isError), JSON.stringify(results));
    }
    const current = await cards.readCard(cardPath);
    for (let round = 0; round < 20; round++) { assert(current.body.includes(`- A-${round}\n`) || current.body.endsWith(`- A-${round}`)); assert(current.body.includes(`- B-${round}\n`) || current.body.endsWith(`- B-${round}`)); }
    assert.equal(current.frontmatter.custom, 'keep me');
    assert(current.frontmatter.signboard_id);
    assert.equal((await fs.stat(cardPath)).mode & 0o777, 0o640);
    const before = await fs.readFile(cardPath);
    const conflict = await a.call('signboard_update_card', { ...args, body: 'stale body', expectedRevision: initial.revision });
    assert.equal(conflict.structuredContent.details.code, 'REVISION_CONFLICT');
    assert.equal(conflict.structuredContent.details.currentRevision, current.revision);
    assert.deepEqual(await fs.readFile(cardPath), before);
    const required = await a.call('signboard_update_card', { ...args, body: 'missing revision' });
    assert.equal(required.structuredContent.details.code, 'REVISION_REQUIRED');
    assert.deepEqual(await fs.readFile(cardPath), before);
    const replaced = await a.call('signboard_update_card', { ...args, body: current.body + '\nMerged body', expectedRevision: current.revision });
    assert(!replaced.isError);
    assert.notEqual(replaced.structuredContent.card.revision, current.revision);
    await assert.rejects(cards.writeCard(cardPath, { frontmatter: current.frontmatter, body: 'Desktop stale draft', expectedRevision: current.revision }), { code: 'REVISION_CONFLICT' });
    const after = await cards.readCard(cardPath);
    assert(after.body.endsWith('Merged body'));
    assert.equal(after.frontmatter.signboard_id, current.frontmatter.signboard_id);
    // Move/update serialize under the same board transaction: either update is
    // included at the destination or the old path is rejected, never recreated.
    const moved = await Promise.all([
      a.call('signboard_move_card', { boardRoot: root, fromListName: list, toListName: other, cardFile: file, newCardFile: file }),
      b.call('signboard_update_card', { ...args, addNote: 'During move' }),
    ]);
    assert(!moved[0].isError, JSON.stringify(moved));
    await assert.rejects(fs.stat(cardPath), { code: 'ENOENT' });
    const destination = await cards.readCard(path.join(root, other, file));
    assert(destination.body.includes('Merged body'));
    if (!moved[1].isError) assert(destination.body.includes('During move'));
    // Per-file CAS also protects direct desktop writes, and failures release locks.
    const target = path.join(temp, 'lock-target');
    await fs.writeFile(`${target}.sb-lock`, '2147483647');
    await withFileTransaction(target, async () => {});
    await fs.writeFile(`${target}.sb-lock`, String(process.pid));
    await assert.rejects(withFileTransaction(target, async () => { throw new Error('must not enter'); }, { timeoutMs: 25 }), { code: 'SIGNBOARD_LOCK_TIMEOUT' });
    await fs.unlink(`${target}.sb-lock`);
    await assert.rejects(withFileTransaction(target, async () => { throw new Error('Action failure'); }), /Action failure/);
    await withFileTransaction(target, async () => {});
    await withBoardTransaction(root, () => withBoardTransaction(root, async () => {}));
    let active = 0;
    await Promise.all(Array.from({ length: 4 }, () => withBoardTransaction(root, async () => {
      assert.equal(active++, 0); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    })));
    // A crashed recovery guard fails closed without stealing an uncertain lock.
    await fs.writeFile(`${target}.sb-lock`, '2147483647');
    await fs.writeFile(`${target}.sb-lock.reap`, '2147483647');
    await assert.rejects(withFileTransaction(target, async () => {}, { timeoutMs: 25 }), { code: 'SIGNBOARD_LOCK_TIMEOUT' });
    await fs.unlink(`${target}.sb-lock`); await fs.unlink(`${target}.sb-lock.reap`);
    const alias = path.join(temp, 'Alias'); await fs.symlink(root, alias);
    let release;
    const held = withBoardTransaction(root, () => new Promise(resolve => { release = resolve; }));
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(withBoardTransaction(alias, async () => {}, { timeoutMs: 25 }), { code: 'SIGNBOARD_LOCK_TIMEOUT' });
    release(); await held;
    // A reserved lock marker must never redirect writes through a symlink.
    const outsideMarker = path.join(temp, 'outside-lock-marker');
    await fs.writeFile(outsideMarker, 'leave untouched');
    await fs.symlink(outsideMarker, path.join(root, '.signboard-write'));
    await withBoardTransaction(root, async () => {});
    await assert.rejects(fs.stat(`${outsideMarker}.sb-lock`), { code: 'ENOENT' });
    await fs.unlink(path.join(root, '.signboard-write'));
    await fs.symlink(outsideMarker, path.join(root, '.signboard-write.sb-lock'));
    await assert.rejects(withBoardTransaction(root, async () => {}), { code: 'SIGNBOARD_INVALID_LOCK' });
    const readOnly = client(temp, { readOnly: true }); children.push(readOnly.child);
    const unauthorized = await readOnly.call('signboard_update_card', { boardRoot: root, listName: other, cardFile: file, addNote: 'Must not lock or write' });
    assert(unauthorized.isError);
    assert.match(unauthorized.structuredContent.error, /read.only/i);
    assert((await fs.lstat(path.join(root, '.signboard-write.sb-lock'))).isSymbolicLink());
    assert.equal(await fs.readFile(outsideMarker, 'utf8'), 'leave untouched');
    await fs.unlink(path.join(root, '.signboard-write.sb-lock'));
    const sourceBoard = path.join(temp, 'Relocation Source');
    const targetBoard = path.join(temp, 'Relocation Target');
    await fs.mkdir(sourceBoard);
    let finishMove;
    const moving = withBoardRelocationTransaction(sourceBoard, targetBoard, async () => {
      await renameManagedDirectory(sourceBoard, sourceBoard, targetBoard);
      assert((await fs.stat(path.join(targetBoard, '.signboard-write.sb-lock'))).isFile());
      await withBoardTransaction(targetBoard, async () => {});
      await new Promise(resolve => { finishMove = resolve; });
    });
    while (!finishMove) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(withBoardTransaction(targetBoard, async () => {}, { timeoutMs: 25 }), { code: 'SIGNBOARD_LOCK_TIMEOUT' });
    // Reusing the source path must not let cleanup remove another owner's lock.
    await fs.mkdir(sourceBoard);
    const reusedLock = path.join(sourceBoard, '.signboard-write.sb-lock');
    await fs.writeFile(reusedLock, String(process.pid));
    finishMove(); await moving;
    assert.equal(await fs.readFile(reusedLock, 'utf8'), String(process.pid));
    await fs.unlink(reusedLock);
    await assert.rejects(fs.stat(path.join(targetBoard, '.signboard-write.sb-lock')), { code: 'ENOENT' });
    await withBoardTransaction(targetBoard, async () => {});
    await assert.rejects(withBoardRelocationTransaction(sourceBoard, path.join(temp, 'Rollback Target'), async () => {
      const rollback = path.join(temp, 'Rollback Target');
      await fs.rename(sourceBoard, rollback);
      await fs.rename(rollback, sourceBoard);
      throw new Error('Rollback complete');
    }), /Rollback complete/);
    await withBoardTransaction(sourceBoard, async () => {});
    const importRoot = path.join(temp, 'Import Source Board');
    const importDestination = path.join(temp, 'Import Moved Board');
    const importSource = path.join(temp, 'Imported Roadmap.md');
    await fs.mkdir(importRoot);
    await fs.writeFile(importSource, '---\nkanban-plugin: board\n---\n\n## Inbox\n\n- [ ] Imported task\n');
    let relocateImport;
    const importMove = withBoardRelocationTransaction(importRoot, importDestination, async () => {
      await new Promise(resolve => { relocateImport = resolve; });
      await renameManagedDirectory(importRoot, importRoot, importDestination);
    });
    while (!relocateImport) await new Promise(resolve => setTimeout(resolve, 1));
    let importSettled = false;
    const waitingImport = importObsidian({ boardRoot: importRoot, sourcePaths: [importSource] })
      .then(result => { importSettled = true; return { result }; }, error => { importSettled = true; return { error }; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(importSettled, false, 'CLI import must wait for the relocation owner');
    relocateImport(); await importMove;
    assert.equal((await waitingImport).error.code, 'ENOENT');
    await assert.rejects(fs.stat(importRoot), { code: 'ENOENT' });
    const imported = await importObsidian({ boardRoot: importDestination, sourcePaths: [importSource] });
    assert.equal(imported.cardsCreated, 1);
    const renamed = await a.call('signboard_rename_board', { boardRoot: root, newBoardName: 'Renamed Board' });
    assert(!renamed.isError, JSON.stringify(renamed));
    const renamedRoot = renamed.structuredContent.newBoardRoot;
    await assert.rejects(fs.stat(path.join(renamedRoot, '.signboard-write.sb-lock')), { code: 'ENOENT' });
    const afterRename = await b.call('signboard_update_card', { boardRoot: renamedRoot, listName: other, cardFile: file, addNote: 'After board rename' });
    assert(!afterRename.isError, JSON.stringify(afterRename));
    const movedParent = path.join(temp, 'New Parent'); await fs.mkdir(movedParent);
    const boardMoved = await a.call('signboard_move_board', { boardRoot: renamedRoot, targetParentRoot: movedParent });
    assert(!boardMoved.isError, JSON.stringify(boardMoved));
    const afterBoardMove = await b.call('signboard_update_card', { boardRoot: boardMoved.structuredContent.newBoardRoot, listName: other, cardFile: file, addNote: 'After board move' });
    assert(!afterBoardMove.isError, JSON.stringify(afterBoardMove));
    console.log('Safe card update tests passed (20 rounds, two independent MCP processes; revisions, moves, legacy metadata, permissions, lock recovery and failures).');
  } finally {
    await Promise.all(children.map(async child => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } }));
    await fs.rm(temp, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { client };
