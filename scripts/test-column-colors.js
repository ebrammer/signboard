const assert = require('assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const vm = require('vm');
const colors = require('../shared/columnColors');
const settings = require('../lib/boardLabels');
const { renameManagedDirectory } = require('../lib/directoryRename');
const { duplicateBoard } = require('../lib/boardDuplication');
const { reorderListDirectories } = require('../lib/cardOrdering');

function luminance(hex) {
  const linear = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

async function testNormalizationSaveRace(temp) {
  const board = path.join(temp, 'Normalization race');
  await fs.mkdir(board);
  const settingsPath = path.join(board, 'board-settings.md');
  await settings.updateBoardSettings(board, { columnColors: { 'doing-stock': '#ff0000' } });
  const raw = (await fs.readFile(settingsPath, 'utf8')).replace('#ff0000', '#FF0000');
  await fs.writeFile(settingsPath, raw);
  const originalRead = fs.readFile;
  const originalLink = fs.link;
  let releaseRead;
  let capturedRead;
  let lockContended;
  const paused = new Promise((resolve) => { capturedRead = resolve; });
  const resume = new Promise((resolve) => { releaseRead = resolve; });
  const contention = new Promise((resolve) => { lockContended = resolve; });
  let pauseNextRead = true;
  let reader;
  let writer;
  try {
    // A strict read-only request normalizes its result without a lock or write.
    fs.link = async () => { throw new Error('Read-only settings must not acquire a lock.'); };
    assert.equal((await settings.readBoardSettings(board, { ensureFile: false })).columnColors['doing-stock'], '#ff0000');
    assert.equal(await originalRead(settingsPath, 'utf8'), raw);
    fs.link = async (...args) => {
      try {
        return await originalLink(...args);
      } catch (error) {
        if (path.basename(String(args[1])) === '.signboard-write.sb-lock' && error.code === 'EEXIST') lockContended();
        throw error;
      }
    };
    fs.readFile = async (...args) => {
      const content = await originalRead(...args);
      if (pauseNextRead && String(args[0]) === settingsPath) {
        pauseNextRead = false;
        capturedRead();
        await resume;
      }
      return content;
    };
    reader = settings.readBoardSettings(board);
    await paused;
    writer = settings.updateBoardSettings(board, { columnColor: { listName: '000-Doing-stock', color: '#00ff00' } });
    // With a lock the writer waits. Without one it finishes before the stale read resumes.
    await Promise.race([contention, writer]);
    releaseRead();
    await Promise.all([reader, writer]);
    assert.equal((await settings.readBoardSettings(board)).columnColors['doing-stock'], '#00ff00', 'normalizing reads must not overwrite a newer column color save');
  } finally {
    releaseRead();
    await Promise.allSettled([reader, writer]);
    fs.readFile = originalRead;
    fs.link = originalLink;
  }
}

async function run() {
  const { normalizeColumnIdentity: identity, normalizeColumnColors: normalize, getColumnColor: color, getColumnPalette: palette } = colors;
  assert.equal(identity('003-Doing-abc12'), 'doing-abc12');
  assert.equal(identity('1000-To-do-stock'), 'to-do-stock');
  assert.equal(identity('  ON HOLD  '), 'on hold');
  assert.equal(identity('Review'), 'review');
  assert.equal(identity('constructor'), '');
  assert.equal(identity('../Doing'), '');
  assert.equal(identity(null), '');
  assert.deepEqual(normalize(JSON.parse('{"Doing-abc12":"ABC","waiting":"#aBcDeF","bad":"red","__proto__":"#000","constructor":"#fff","prototype":"#fff","../bad":"#fff"}')), {
    'doing-abc12': '#aabbcc', waiting: '#abcdef',
  });
  assert.deepEqual(normalize([]), {});
  assert.deepEqual(normalize(Object.create({ doing: '#ff0000' })), {});
  for (const name of ['To-do', 'Backlog', 'Something', 'Inactive', 'Unblocked', 'Preview']) assert.equal(color(name), '#64748b', name);
  for (const name of ['Doing', 'In-progress', 'Active']) assert.equal(color(name), '#2563eb', name);
  for (const name of ['Waiting', 'Review', 'On-hold']) assert.equal(color(name), '#b45309', name);
  assert.equal(color('Blocked'), '#b91c1c');
  assert.equal(color('Blocked review'), '#b91c1c');
  assert.equal(color('Active review'), '#b45309');
  assert.equal(color('Doing', {}, true), '#15803d');
  assert.equal(color('Done', {}, false), '#64748b', 'workflow decides completion, including ignored Done lists');
  assert.equal(color('003-Done-abc12', { 'done-abc12': '#123456' }, true), '#123456', 'custom colors also apply to completed lists');
  assert.equal(color('1000-Doing-abc12', { 'doing-abc12': 'ABC' }), '#aabbcc');
  const sameNameColors = normalize({ 'doing-abcde': '#f00', 'doing-fghij': '#0f0' });
  assert.deepEqual(sameNameColors, { 'doing-abcde': '#ff0000', 'doing-fghij': '#00ff00' });
  assert.equal(color('003-Doing-abcde', sameNameColors), '#ff0000');
  assert.equal(color('000-Doing-fghij', sameNameColors), '#00ff00');
  assert.equal(color('000-Blocked-review'), '#b91c1c', 'directory suffix is excluded from type detection');
  assert.equal(color('000-Backlog-Doing'), '#64748b', 'generated suffix never becomes a workflow keyword');

  for (const base of ['#ffffff', '#ffff00', '#00ff00', '#ff0000', '#000000', '#123456', '#64748b', '#2563eb', '#15803d', '#b45309', '#b91c1c']) {
    for (const dark of [false, true]) {
      const result = palette(base, dark);
      for (const value of Object.values(result)) assert.match(value, /^#[a-f0-9]{6}$/);
      assert.equal(result.headerText, '#ffffff');
      assert(1.05 / (luminance(result.header) + 0.05) >= 4.5, `${base} header contrast`);
      if (1.05 / (luminance(base) + 0.05) >= 4.5) assert.equal(result.header, base, 'readable chosen shades stay unchanged');
      if (dark) assert(1.05 / (luminance(result.body) + 0.05) >= 4.5, `${base} dark body contrast`);
      else assert((luminance(result.body) + 0.05) / (luminance('#171717') + 0.05) >= 4.5, `${base} light body contrast`);
    }
  }
  assert.notEqual(palette('#2563eb', true).body, palette('#2563eb').body);
  const browser = vm.createContext({ window: {} });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../shared/columnColors.js'), 'utf8'), browser);
  assert.equal(browser.SignboardColumnColors.getColumnColor('Doing'), '#2563eb');

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-column-colors-'));
  const originalRename = fs.rename;
  try {
    await testNormalizationSaveRace(temp);
    const numericBoard = path.join(temp, 'Numeric titles');
    const numericList = '001-2026-Planning-stock';
    await fs.mkdir(path.join(numericBoard, numericList), { recursive: true });
    await fs.mkdir(path.join(numericBoard, '000-Other-stock'));
    await settings.updateBoardSettings(numericBoard, { columnColor: { listName: numericList, color: '#123abc' } });
    await settings.updateBoardSettings(numericBoard, { colorScheme: 'custom' });
    assert.deepEqual((await settings.readBoardSettings(numericBoard)).columnColors, { '2026-planning-stock': '#123abc' }, 'numeric title prefix remains in persisted canonical identity');
    const reorderedNumeric = await reorderListDirectories(numericBoard, [path.join(numericBoard, numericList), path.join(numericBoard, '000-Other-stock')]);
    assert.equal(color(reorderedNumeric[0].listDirectoryName, (await settings.readBoardSettings(numericBoard)).columnColors), '#123abc', 'numeric title color follows reorder');
    const renamedNumeric = '000-2027-Planning-stock';
    await renameManagedDirectory(numericBoard, reorderedNumeric[0].listPath, path.join(numericBoard, renamedNumeric));
    assert.deepEqual((await settings.readBoardSettings(numericBoard)).columnColors, { '2027-planning-stock': '#123abc' }, 'numeric title override migrates only its ordering prefix during rename');
    assert.equal(color(renamedNumeric, (await settings.readBoardSettings(numericBoard)).columnColors), '#123abc');
    const repeatedBoard = path.join(temp, 'Repeated names');
    await fs.mkdir(path.join(repeatedBoard, '000-Doing-abcde'), { recursive: true });
    await fs.mkdir(path.join(repeatedBoard, '001-Doing-fghij'));
    await Promise.all([
      settings.updateBoardSettings(repeatedBoard, { columnColor: { listName: '000-Doing-abcde', color: '#f00' } }),
      settings.updateBoardSettings(repeatedBoard, { columnColor: { listName: '001-Doing-fghij', color: '#0f0' } }),
    ]);
    assert.deepEqual((await settings.readBoardSettings(repeatedBoard)).columnColors, sameNameColors, 'same display names save independent overrides');
    const board = path.join(temp, 'Board');
    const doing = '001-Doing-abc12';
    const todo = '000-To-do-stock';
    await fs.mkdir(path.join(board, doing), { recursive: true });
    await fs.mkdir(path.join(board, todo));
    const cardFile = '000-Card-abcde.md';
    const originalCard = '---\ntitle: Card\ncustom: preserved\n---\nKeep this body.\n';
    await fs.writeFile(path.join(board, doing, cardFile), originalCard);
    const settingsPath = path.join(board, 'board-settings.md');
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, {});
    assert(!(await fs.readFile(settingsPath, 'utf8')).includes('columnColors:'), 'empty overrides omitted');
    await settings.updateBoardSettings(board, { columnColors: { 'doing-abc12': '#F80', 'to-do-stock': '123456' } });
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'doing-abc12': '#ff8800', 'to-do-stock': '#123456' });
    assert((await fs.readFile(settingsPath, 'utf8')).includes('columnColors:'), 'custom colors serialized');
    const unnormalized = (await fs.readFile(settingsPath, 'utf8')).replace('  doing-abc12:', '  Doing-abc12:').replace('#ff8800', '#FF8800');
    await fs.writeFile(settingsPath, unnormalized);
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'doing-abc12': '#ff8800', 'to-do-stock': '#123456' });
    const normalizedRaw = await fs.readFile(settingsPath, 'utf8');
    assert(!normalizedRaw.includes('Doing-abc12:') && !normalizedRaw.includes('#FF8800'), 'read normalization persists canonical keys and hex');
    await settings.updateBoardLabels(board, [{ id: 'one', name: 'One', colorLight: '#abc', colorDark: '#123' }]);
    await settings.updateBoardThemeOverrides(board, { light: { boardBackground: '#fff' } });
    await settings.updateBoardSettings(board, { workflow: { autoDetectCompletedLists: false } });
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'doing-abc12': '#ff8800', 'to-do-stock': '#123456' });
    await Promise.all([
      settings.updateBoardSettings(board, { columnColor: { listName: doing, color: '#369' } }),
      settings.updateBoardSettings(board, { columnColor: { listName: todo, color: '#789' } }),
      settings.updateBoardSettings(board, { colorScheme: 'custom' }),
    ]);
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'doing-abc12': '#336699', 'to-do-stock': '#778899' });
    await assert.rejects(settings.updateBoardSettings(board, { columnColor: { listName: doing, color: 'bad color' } }), /Invalid column color/);
    await assert.rejects(settings.updateBoardSettings(board, { columnColor: { listName: '__proto__', color: '#fff' } }), /Invalid column color list/);

    const renamed = '001-Working-abc12';
    await settings.updateBoardSettings(board, { columnColor: { listName: renamed, color: '#112233' } });
    const beforeCollision = await fs.readFile(settingsPath, 'utf8');
    await assert.rejects(renameManagedDirectory(board, path.join(board, doing), path.join(board, renamed)), /Column color already exists/);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), beforeCollision);
    await fs.access(path.join(board, doing));
    await assert.rejects(fs.access(path.join(board, renamed)));
    await settings.updateBoardSettings(board, { columnColor: { listName: renamed, color: null } });
    const before = await fs.readFile(settingsPath, 'utf8');
    fs.rename = async (from, to) => {
      if (from.endsWith('.tmp') && to === settingsPath) throw new Error('injected settings failure');
      return originalRename(from, to);
    };
    await assert.rejects(renameManagedDirectory(board, path.join(board, doing), path.join(board, renamed)), /injected settings failure/);
    fs.rename = originalRename;
    assert.equal(await fs.readFile(settingsPath, 'utf8'), before);
    assert.equal(await fs.readFile(path.join(board, doing, cardFile), 'utf8'), originalCard, 'settings failure rolls card metadata back too');
    await fs.access(path.join(board, doing));
    await assert.rejects(fs.access(path.join(board, renamed)));
    await renameManagedDirectory(board, path.join(board, doing), path.join(board, renamed));
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'working-abc12': '#336699', 'to-do-stock': '#778899' });
    const reorderResult = await reorderListDirectories(board, [path.join(board, renamed), path.join(board, todo)]);
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'working-abc12': '#336699', 'to-do-stock': '#778899' });
    assert.equal(color(reorderResult[0].listDirectoryName, (await settings.readBoardSettings(board)).columnColors), '#336699');
    const duplicate = await duplicateBoard({ sourceBoardRoot: board, destinationParentPath: temp, boardName: 'Copy' });
    assert.deepEqual((await settings.readBoardSettings(duplicate.boardRoot)).columnColors, { 'working-abc12': '#336699', 'to-do-stock': '#778899' });
    await settings.updateBoardSettings(board, { columnColor: { listName: reorderResult[0].listDirectoryName, color: null } });
    assert.deepEqual((await settings.readBoardSettings(board)).columnColors, { 'to-do-stock': '#778899' });
    await settings.updateBoardSettings(board, { columnColors: {} });
    assert(!(await fs.readFile(settingsPath, 'utf8')).includes('columnColors:'));
    console.log('Column color tests passed.');
  } finally {
    fs.rename = originalRename;
    await fs.rm(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Column color tests failed.');
  console.error(error);
  process.exitCode = 1;
});
