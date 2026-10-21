const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../app/board/boardTabs.js'), 'utf8');
function createContext(entries = {}) {
  const storage = new Map(Object.entries(entries));
  let reads = 0;
  const synced = [];
  const context = vm.createContext({
    console,
    localStorage: { getItem: (key) => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    window: { board: {
      getPersistedOpenBoardsState: async () => {
        reads += 1;
        return { ok: true, openBoardRoots: ['/first', '/second'], activeBoardRoot: '/second' };
      },
      syncOpenBoardsState: async (state) => { synced.push(state); },
    } },
    renderBoardTabs: () => {},
  });
  vm.runInContext(source, context);
  context.renderBoardTabs = () => {};
  return { context, storage, synced, reads: () => reads };
}

(async () => {
  let fixture = createContext();
  assert.equal(await fixture.context.restorePersistedWorkspaceIfStorageMissing(), true);
  assert.deepEqual(JSON.parse(fixture.storage.get('openBoardPaths')), ['/first/', '/second/']);
  assert.equal(fixture.storage.get('activeBoardPath'), '/second/');
  assert.equal(fixture.storage.get('boardPath'), '/second/');
  assert.equal(fixture.synced.length, 1, 'publish one complete restored workspace');

  for (const entries of [{ openBoardPaths: '[]' }, { openBoardPaths: '' }, { openBoardPaths: 'invalid' }, { activeBoardPath: '' }, { boardPath: '' }, { activeBoardPath: '/legacy' }]) {
    fixture = createContext(entries);
    assert.equal(await fixture.context.restorePersistedWorkspaceIfStorageMissing(), false);
    assert.equal(fixture.reads(), 0, 'present renderer state wins, including explicit empty or malformed values');
  }
  fixture = createContext({ openBoardPaths: '[]', activeBoardPath: '/stale', boardPath: '/stale' });
  assert.equal(fixture.context.restoreBoardTabs(), '', 'explicit empty board list beats stale active-board keys');
  fixture = createContext({ boardPath: '/legacy' });
  assert.equal(fixture.context.restoreBoardTabs(), '/legacy/', 'preserve legacy single-board storage');

  fixture = createContext();
  fixture.context.window.board.getPersistedOpenBoardsState = async () => {
    fixture.storage.set('openBoardPaths', '[]');
    return { ok: true, openBoardRoots: ['/first'], activeBoardRoot: '/first' };
  };
  assert.equal(await fixture.context.restorePersistedWorkspaceIfStorageMissing(), false, 'an explicit renderer write during IPC wins');
  assert.equal(fixture.storage.get('openBoardPaths'), '[]');
  assert.equal(fixture.synced.length, 0);
  console.log('Workspace restoration regression checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
