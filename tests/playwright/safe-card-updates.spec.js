const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const electronBinary = require('electron');
const { createFixtureBoardAt } = require('./helpers/fixtureBoard');
const cards = require('../../lib/cardFrontmatter');
const { client } = require('../../scripts/test-safe-card-updates');
const { once } = require('events');

// Isolated board/profile only. The repository local-GUI permission gate applies.
test('stale editor save retains its draft and merges after reviewing the saved card', async ({}, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-editor-conflict-'));
  let app, agent;
  try {
    const board = await createFixtureBoardAt(temp, 'Conflict Board');
    const cardPath = path.join(board, '000-To-do-stock', '000-plan-release-stock.md');
    const profile = path.join(temp, 'profile');
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'trusted-board-roots.json'), JSON.stringify([board]));
    app = await electron.launch({ executablePath: electronBinary, cwd: path.resolve(__dirname, '../..'), args: ['.'],
      env: { ...process.env, SIGNBOARD_USER_DATA_DIR: profile, SIGNBOARD_TEST_DISABLE_FAVICON_FETCH: '1' },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(root => {
      localStorage.setItem('openBoardPaths', JSON.stringify([root]));
      localStorage.setItem('activeBoardPath', root); localStorage.setItem('boardPath', root);
    }, `${board}/`);
    await page.reload();
    await expect(page.locator('#boardName')).toHaveText('Conflict Board');
    // The mutation dispatcher must accept list-order arrays as well as paths.
    const reordered = await page.evaluate(async () => window.board.reorderLists((await window.board.listLists(window.boardRoot)).map(name => window.boardRoot + name)));
    expect(reordered.ok).toBe(true);
    await page.evaluate(async file => { await toggleEditCardModal(file); }, cardPath);
    await expect(page.locator('#modalEditCard')).toBeVisible();
    // Make the draft dirty synchronously, then write externally before enqueueing
    // its save. This reproduces the read/save race without timing the debounce.
    await page.evaluate(() => {
      isApplyingExternalEditorRefresh = true;
      activeCardEditorInstance.setValue('My unsaved draft');
      isApplyingExternalEditorRefresh = false;
    });
    const before = await cards.readCard(cardPath);
    await cards.writeCard(cardPath, { frontmatter: { ...before.frontmatter, external_custom: 'preserve' }, body: 'Agent note on disk' });
    agent = client(temp);
    const external = await agent.call('signboard_update_card', { boardRoot: board, listName: '000-To-do-stock', cardFile: '000-plan-release-stock.md', title: 'Agent changed title', due: '2030-05-01', addNote: 'MCP addition' });
    expect(external.isError).toBeFalsy();
    const savedBytes = await fs.readFile(cardPath);
    await page.evaluate(async () => { await enqueueEditorSave(getEditorBodyValue()); });
    await expect(page.locator('#cardEditorSaveConflict')).toBeVisible();
    await expect(page.locator('#cardEditorOverType .overtype-input')).toHaveValue('My unsaved draft');
    expect(await fs.readFile(cardPath)).toEqual(savedBytes);
    expect(await page.evaluate(async () => {
      try { await flushEditorSaveIfNeeded(); return false; } catch { return true; }
    })).toBe(true);
    await expect(page.locator('#modalEditCard')).toBeVisible();
    await page.getByRole('button', { name: 'Review saved version', exact: true }).click();
    await expect(page.locator('#cardEditorSaveConflict textarea')).toHaveValue(/Agent note on disk/);
    await testInfo.attach('retained-draft-conflict', { body: await page.screenshot(), contentType: 'image/png' });
    await page.locator('#cardEditorOverType .overtype-input').fill('Agent note on disk\n\n## Notes\n\n- MCP addition\n\nMy unsaved draft');
    await page.getByRole('button', { name: 'Save merged draft', exact: true }).click();
    await expect(page.locator('#cardEditorSaveConflict')).toHaveCount(0);
    const merged = await cards.readCard(cardPath);
    expect(merged.body).toBe('Agent note on disk\n\n## Notes\n\n- MCP addition\n\nMy unsaved draft');
    expect(merged.frontmatter.title).toBe('Agent changed title');
    expect(merged.frontmatter.due).toBe('2030-05-01');
    await expect(page.locator('#cardEditorCardDatesDisplay')).toContainText('May 1');
    await expect(page.locator('#cardEditorTitle')).toHaveText('Agent changed title');
    expect(merged.frontmatter.external_custom).toBe('preserve');
    // A metadata-only disk update must not bless a stale metadata snapshot just
    // because the editor body still equals the saved body.
    const baseline = await page.evaluate(() => activeEditorDiskState.revision);
    await page.evaluate(() => { document.getElementById('cardEditorTitle').textContent = 'My next title'; });
    const metadata = await agent.call('signboard_update_card', { boardRoot: board, listName: '000-To-do-stock', cardFile: '000-plan-release-stock.md', due: '2031-05-01' });
    expect(metadata.isError).toBeFalsy();
    await page.evaluate(async file => { await refreshEditorRevisionAfterMetadata(file); }, cardPath);
    expect(await page.evaluate(() => activeEditorDiskState.revision)).toBe(baseline);
    await page.evaluate(async () => { await enqueueEditorSave(getEditorBodyValue()); });
    await expect(page.locator('#cardEditorSaveConflict')).toBeVisible();
    expect((await cards.readCard(cardPath)).frontmatter.due).toBe('2031-05-01');
    await page.getByRole('button', { name: 'Review saved version', exact: true }).click();
    await expect(page.locator('#cardEditorSaveConflict textarea')).toHaveValue(/2031-05-01/);
    await page.getByRole('button', { name: 'Save merged draft', exact: true }).click();
    await expect(page.locator('#cardEditorSaveConflict')).toHaveCount(0);
    expect((await cards.readCard(cardPath)).frontmatter.title).toBe('My next title');
    expect((await cards.readCard(cardPath)).frontmatter.due).toBe('2031-05-01');
    await page.locator('#cardEditorClose').click();
    await expect(page.locator('#modalEditCard')).toBeHidden();
    // A removed/moved saved path cannot be reread; users can deliberately
    // discard their retained draft and leave the editor without writing it.
    await page.evaluate(async file => { await toggleEditCardModal(file); }, cardPath);
    await page.evaluate(() => {
      isApplyingExternalEditorRefresh = true;
      activeCardEditorInstance.setValue('Draft for deleted path');
      isApplyingExternalEditorRefresh = false;
    });
    const keptPath = cardPath + '.kept';
    await fs.rename(cardPath, keptPath);
    const kept = await fs.readFile(keptPath);
    await page.evaluate(async () => { await enqueueEditorSave(getEditorBodyValue()); });
    await expect(page.locator('#cardEditorSaveConflict')).toBeVisible();
    await expect(page.locator('#cardEditorOverType .overtype-input')).toHaveValue('Draft for deleted path');
    await page.getByRole('button', { name: 'Discard draft and close', exact: true }).click();
    await expect(page.locator('#modalEditCard')).toBeHidden();
    expect(await fs.readFile(keptPath)).toEqual(kept);
    await expect.poll(async () => { try { await fs.access(cardPath); return true; } catch { return false; } }).toBe(false);
  } finally {
    if (agent && agent.child.exitCode === null) { agent.child.kill(); await once(agent.child, 'exit'); }
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
