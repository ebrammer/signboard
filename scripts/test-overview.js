const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({ window: {}, console, Date, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/projectCoordination.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/board/boardLabels.js'), 'utf8'), context);
for (const file of ['boardSnapshot.js', 'boardViews.js', 'plannerView.js', 'overviewView.js', 'overviewGridView.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/board', file), 'utf8'), context);
}
context.getBoardLabelFromPath = (root) => root.split('/').filter(Boolean).pop();
const plain = (value) => JSON.parse(JSON.stringify(value));
assert.equal(context.getOverviewState().tab, 'projects', 'Projects is the initial workspace overview');
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
const coordinated = context.buildOverviewProject('/research/', { ...snapshot, boardSettings: { workflow: { completedListNames: ['001-Released-stock'] } }, lists: [
  { listName: '000-Doing-stock', listPath: '/research/doing', cards: [
    { frontmatter: { title: 'Legacy active' }, body: '' },
    { frontmatter: { title: 'Explicit idle', sb_work_status: 'idle' }, body: '' },
    { frontmatter: { title: 'Review please', sb_attention: 'review', sb_request: 'Pick the draft', sb_evidence: 'Preview A' }, body: '' },
  ] },
  { listName: '001-Released-stock', listPath: '/research/released', cards: [{ frontmatter: { title: 'Old request', sb_work_status: 'working', sb_attention: 'review', sb_request: 'Skip' }, body: '' }] },
  { listName: '002-Custom working-stock', listPath: '/research/custom', cards: [{ frontmatter: { title: 'Custom is not activity' }, body: '' }] },
] }, { goal: 'Make reading easier', nextStep: 'Review layout' });
assert.equal(coordinated.active.length, 2, 'fallback applies only to conventional Doing/In progress and does not override explicit idle');
assert.equal(coordinated.requests.length, 1, 'completed workflow requests are excluded');
assert.equal(coordinated.lists[1].isCompletedList, true);
assert.equal(context.filterOverviewProjects([coordinated], 'reading easier').length, 1, 'project goal is searchable');
assert.equal(context.filterOverviewProjects([coordinated], 'Preview A')[0].visibleCount, 1, 'request evidence is searchable');
assert.equal(context.filterOverviewProjects([coordinated], 'Old request')[0].visibleCount, 1, 'completed sources remain searchable');
// Search covers original notes beyond any displayed preview and does not mutate source order.
const deepNotes = context.buildOverviewProject('/notes/', { ...snapshot, boardName: 'Notes', lists: [{
  listName: '000-Custom research-stock', listPath: '/notes/custom', cards: [{
    cardPath: '/notes/custom/deep.md', frontmatter: { title: 'Deep source' },
    body: 'Opening paragraph. '.repeat(300) + 'Unique hidden needle at the end.',
  }],
}] });
assert.equal(context.filterOverviewProjects([deepNotes], 'hidden needle')[0].visibleCount, 1);
assert.equal(deepNotes.brief.goal, undefined, 'missing project goals stay absent');
assert.equal(deepNotes.active.length, 0, 'custom workflow does not invent an active status');
assert.equal(deepNotes.requests.length, 0, 'missing coordination does not invent a request');
assert.equal(context.overviewCurrentCard(deepNotes), null, 'missing current summaries remain absent');
assert.equal(context.overviewLatestUpdate(deepNotes), '', 'missing freshness is never fabricated');
const timestamped = context.buildOverviewProject('/timed/', { ...snapshot, lists: [{
  listName: '000-Custom-stock', listPath: '/timed/custom', cards: [{
    frontmatter: { title: 'Explicit summary', sb_summary: 'Reported work' }, body: '',
    timestamps: { updatedAt: '2026-03-01T12:00:00.000Z' },
  }],
}] }, { updatedAt: '2026-02-01T12:00:00.000Z' });
assert.equal(context.overviewCurrentCard(timestamped).coordination.summary, 'Reported work');
assert.equal(context.overviewLatestUpdate(timestamped), '2026-03-01T12:00:00.000Z');
const ordered = [project, deepNotes, { ...coordinated, boardRoot: '/coordinated/' }];
const roots = ordered.map((entry) => entry.boardRoot);
context.filterOverviewProjects(ordered, 'research');
assert.deepEqual(ordered.map((entry) => entry.boardRoot), roots, 'search preserves saved board order');
assert.equal(deepNotes.lists[0].cards[0].body.endsWith('Unique hidden needle at the end.'), true);
const partial = context.buildOverviewProject('/research/', { ...snapshot, errors: [{ path: 'unreadable.md' }] });
assert.equal(partial.error, true);
assert.equal(context.filterOverviewProjects([partial], 'missing')[0].error, true, 'read failures must remain visible during search');
assert.equal(context.normalizeWorkspaceViewId('overview'), 'overview');
context.window.__overviewState = { isOpen: true };
assert.equal(context.getActiveWorkspaceView(), 'overview');

(async () => {
  context.window.board = { readProjectBrief: async () => ({ goal: '', nextStep: '', revision: 'missing' }), readBoardSnapshot: async (root, options) => {
    assert.equal(options.includeBoardSettings, true);
    assert.equal(options.ensureBoardSettings, false, 'Overview reads must not create settings or recreate unavailable project roots');
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
  // If batched snapshots are unavailable, settings reads must stay read-only too.
  context.window.board.readBoardSnapshot = async () => { throw new Error('Snapshot unavailable'); };
  context.window.board.listLists = async () => [];
  context.window.board.getBoardName = async () => 'Read-only fallback';
  let fallbackSettingsReads = 0;
  context.window.board.readBoardSettings = async (root, options) => {
    assert.equal(root, '/readonly/');
    assert.equal(options.ensureFile, false, 'fallback must not create or migrate project settings');
    fallbackSettingsReads += 1;
    return {};
  };
  const readonlyFallback = await context.readBoardSnapshotForRender('/readonly/', { includeBoardSettings: true, ensureBoardSettings: false });
  assert.equal(readonlyFallback.boardName, 'Read-only fallback');
  assert.equal(fallbackSettingsReads, 1);

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
  context.closeBoardLabelFilterPopover = () => {};
  await assert.rejects(context.switchWorkspaceView('table'), /Unsaved conflict/);
  assert.equal(context.isOverviewOpen(), true);
  console.log('Overview regression checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
