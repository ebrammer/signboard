const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ window: {}, console, Date, Promise });
for (const file of ['boardSnapshot.js', 'boardViews.js', 'plannerView.js', 'overviewView.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/board', file), 'utf8'), context);
}
context.getBoardLabelFromPath = (root) => root.split('/').filter(Boolean).pop();
const plain = (value) => JSON.parse(JSON.stringify(value));
const snapshot = {
  boardName: 'Research', ok: true, errors: [],
  lists: [
    { listName: '000-Waiting on partner-stock', listPath: '/research/waiting', cards: [
      { cardPath: '/research/waiting/a.md', frontmatter: { title: 'Undated card' }, body: 'Follow up with Ada.' },
    ] },
    { listName: '001-Released-stock', listPath: '/research/released', cards: [
      { cardPath: '/research/released/b.md', frontmatter: { title: 'Already shipped', due: '2026-01-01' }, body: 'Retain history.' },
    ] },
    { listName: '002-Custom empty-stock', listPath: '/research/empty', cards: [] },
    { listName: 'XXX-Archive', listPath: '/research/archive', cards: [
      { cardPath: '/research/archive/x.md', frontmatter: { title: 'Archived' }, body: '' },
    ] },
  ],
};
const project = context.buildOverviewProject('/research/', snapshot);
assert.equal(project.cardCount, 2, 'undated and completed workflow cards remain visible; archive is excluded');
assert.deepEqual(plain(project.lists.map((list) => list.listDisplayName)), ['Waiting on partner', 'Released', 'Custom empty']);
assert.equal(project.lists[0].cards[0].cardPath, '/research/waiting/a.md');
assert.equal(context.filterOverviewProjects([project], '')[0].lists.length, 3, 'empty source lists retain workflow context');
for (const query of ['Research Ada', 'Waiting partner', 'Undated', 'retain history']) {
  assert.equal(context.filterOverviewProjects([project], query)[0].visibleCount, 1, query);
}
assert.equal(context.filterOverviewProjects([project], 'missing').length, 0);
const partial = context.buildOverviewProject('/research/', { ...snapshot, errors: [{ path: 'unreadable.md' }] });
assert.equal(partial.error, true);
assert.equal(context.filterOverviewProjects([partial], 'missing')[0].error, true, 'read failures must remain visible during search');
assert.equal(context.normalizeWorkspaceViewId('overview'), 'overview');
context.window.__overviewState = { isOpen: true };
assert.equal(context.getActiveWorkspaceView(), 'overview');

(async () => {
  context.window.board = { readBoardSnapshot: async (root, options) => {
    assert.equal(options.includeBoardSettings, false);
    if (root === '/missing/') throw new Error('denied');
    return snapshot;
  }, listLists: async () => { throw new Error('denied'); } };
  assert.equal((await context.readOverviewProject('/research/')).cardCount, 2);
  assert.equal((await context.readOverviewProject('/missing/')).error, true);
  context.window.board.readBoardSnapshot = async () => ({
    ok: true, lists: [{ listName: '000-Custom-stock', listPath: '/research/custom', cards: ['a.md', 'bad.md'] }], errors: [],
  });
  context.window.board.readCard = async (cardPath) => {
    if (cardPath.endsWith('bad.md')) throw new Error('denied');
    return { frontmatter: { title: 'Legacy filename record' }, body: 'Body' };
  };
  const fallback = await context.readOverviewProject('/research/');
  assert.equal(fallback.cardCount, 1);
  assert.equal(fallback.error, true);
  assert.equal(fallback.lists[0].cards[0].title, 'Legacy filename record');
  // Rejecting an unsaved editor conflict must not move away from its source board.
  context.window.boardRoot = '/research/';
  context.window.__plannerViewState = { cardContext: { boardRoot: '/original/' }, cardOpenPromise: null };
  context.closeAllModals = async () => { throw new Error('Unsaved conflict'); };
  let restored = 0;
  context.restorePlannerCardContext = async () => { restored += 1; };
  await assert.rejects(context.openPlannerCard({ cardPath: '/research/a.md' }), /Unsaved conflict/);
  assert.equal(restored, 0);
  assert.equal(context.window.boardRoot, '/research/');
  assert.equal(context.window.__plannerViewState.cardContext.boardRoot, '/original/');
  await assert.rejects(context.switchWorkspaceView('table'), /Unsaved conflict/);
  assert.equal(context.isOverviewOpen(), true);
  console.log('Overview regression checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
