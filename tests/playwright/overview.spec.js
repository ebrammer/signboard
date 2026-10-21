const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const electronBinary = require('electron');
const { createFixtureBoardAt } = require('./helpers/fixtureBoard');
const cardFrontmatter = require('../../lib/cardFrontmatter');
const boardLabels = require('../../lib/boardLabels');

const repoRoot = path.resolve(__dirname, '../..');
const normalizeRoot = (root) => `${root.replace(/\/+$/, '')}/`;

async function withOverviewApp(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-overview-'));
  let app;
  try {
    const boardA = await createFixtureBoardAt(root, 'Alpha Project');
    const boardB = await createFixtureBoardAt(root, 'Beta Project');
    const settings = await boardLabels.readBoardSettings(boardB);
    await boardLabels.writeBoardSettings(boardB, { ...settings, colorScheme: 'cozy-blush' });
    const customList = path.join(boardB, '001-Waiting on reviewer-stock');
    await fs.rename(path.join(boardB, '001-Doing-stock'), customList);
    const cardPath = path.join(customList, '000-polish-copy-stock.md');
    const source = await cardFrontmatter.readCard(cardPath);
    await cardFrontmatter.writeCard(cardPath, { ...source, body: `${source.body}\n${'Additional source context. '.repeat(200)}\nUnique full notes needle.` });
    await fs.mkdir(path.join(root, 'profile'));
    await fs.writeFile(path.join(root, 'profile', 'trusted-board-roots.json'), JSON.stringify([boardA, boardB]));
    const virtualDisplay = process.platform === 'linux' && process.env.SIGNBOARD_PLAYWRIGHT_VIRTUAL_DESKTOP === '1';
    app = await electron.launch({ executablePath: electronBinary, cwd: repoRoot,
      args: [...(virtualDisplay ? ['--ozone-platform=x11'] : []), '.'],
      env: { ...process.env, SIGNBOARD_USER_DATA_DIR: path.join(root, 'profile'), SIGNBOARD_TEST_DISABLE_FAVICON_FETCH: '1' },
    });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => console.error('Renderer error:', error.message));
    page.on('console', (message) => { if (message.type() === 'error') console.error('Renderer console:', message.text()); });
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(({ boards }) => {
      localStorage.setItem('openBoardPaths', JSON.stringify(boards));
      localStorage.setItem('activeBoardPath', boards[0]);
      localStorage.setItem('boardPath', boards[0]);
    }, { boards: [boardA, boardB].map(normalizeRoot) });
    await page.reload();
    await expect(page.locator('#boardName')).toHaveText('Alpha Project');
    await run({ page, app, root, boardA, boardB, cardPath });
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('Overview preserves custom workflows, searches all projects, edits source cards and refreshes external writes', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardA, boardB, cardPath }) => {
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('.overview-project')).toHaveCount(2);
    await expect(page.locator('.overview-card')).toHaveCount(0);
    // Each project keeps its complete source workflow in its own detail view.
    for (const board of [boardA, boardB]) {
      await page.locator('[data-overview-project]').filter({ hasText: board === boardA ? 'Alpha Project' : 'Beta Project' }).click();
      await expect(page.locator('#overviewProjectDetail')).toBeVisible();
      await page.locator('.overview-completed-toggle').click();
      await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(3);
      await page.locator('#overviewDetailBack').click();
    }
    await page.locator('[data-overview-project]').filter({ hasText: 'Beta Project' }).click();
    await expect(page.locator('.overview-list-title', { hasText: 'Waiting on reviewer' })).toHaveText('Waiting on reviewer · 1');
    await expect(page.locator('#overviewCount')).toHaveText('2 projects · 6 cards');
    await page.screenshot({ path: testInfo.outputPath('overview-populated.png') });
    await page.locator('#overviewSearchInput').fill('Beta reviewer full notes needle');
    await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(1);
    await expect(page.locator('#overviewDetailBody .overview-card')).toContainText('Polish homepage copy');
    await page.locator('#overviewSearchInput').fill('Beta reviewer Tighten');
    await expect(page.locator('.overview-card')).toHaveCount(1);
    await expect(page.locator('.overview-card')).toContainText('Polish homepage copy');
    const overviewBackground = await page.locator('#overviewOverlay').evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.locator('.overview-card-title').click();
    await expect(page.locator('#modalEditCard')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('activeBoardPath'))).toBe(normalizeRoot(boardA));
    expect(await page.evaluate(() => window.boardRoot)).toBe(normalizeRoot(boardB));
    expect(await page.locator('#overviewOverlay').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(overviewBackground);
    await page.locator('#cardEditorTitle').selectText();
    await page.locator('#cardEditorTitle').pressSequentially('Review homepage copy');
    await page.locator('#cardEditorClose').click();
    await expect(page.locator('#modalEditCard')).toBeHidden();
    expect(await page.evaluate(() => window.boardRoot)).toBe(normalizeRoot(boardA));
    await expect(page.locator('#overviewSearchInput')).toHaveValue('Beta reviewer Tighten');
    await expect(page.locator('.overview-card')).toContainText('Review homepage copy');
    expect((await cardFrontmatter.readCard(cardPath)).frontmatter.title).toBe('Review homepage copy');
    const card = await cardFrontmatter.readCard(cardPath);
    await cardFrontmatter.writeCard(cardPath, { ...card, frontmatter: { ...card.frontmatter, title: 'External agent update' } });
    await expect(page.locator('.overview-card')).toContainText('External agent update', { timeout: 15000 });
    await page.locator('#overviewSearchInput').fill('no-such-card');
    await expect(page.locator('#overviewBody')).toContainText('No projects or cards match your search.');
    await page.locator('[data-overview-workspace=table]').click();
    await expect(page.locator('#overviewOverlay')).toBeHidden();
    await expect(page.locator('#workspaceViewTable')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#workspaceViewPlanner').click();
    await expect(page.locator('#plannerOverlay')).toBeVisible();
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#plannerOverlay')).toBeHidden();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('#overviewSearchInput')).toHaveValue('no-such-card');
    await page.locator('#overviewSearchInput').fill('');
    await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(3);
    await page.locator('#overviewDetailBack').click();
    await expect(page.locator('.overview-project')).toHaveCount(2);
  });
});

test('Overview shows missing project and no-open-board states', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardB }) => {
    await page.locator('#workspaceViewOverview').click();
    await fs.rename(boardB, `${boardB}-unavailable`);
    await expect(page.locator('.overview-source-warning')).toContainText('Some project files could not be read', { timeout: 15000 });
    await page.locator('#overviewSearchInput').fill('unmatched');
    await expect(page.locator('.overview-source-warning')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('overview-read-warning.png') });
    await page.evaluate(async () => {
      setStoredOpenBoards([]);
      await renderOverviewView();
    });
    await expect(page.locator('#overviewBody')).toContainText('No open projects.');
    await page.evaluate(async () => {
      setStoredActiveBoard('');
      window.boardRoot = '';
      await renderBoard();
    });
    await page.locator('#overviewCloseButton').click();
    await expect(page.locator('#workspaceViewOverview')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('overview-no-boards-entry.png') });
    await expect(page.locator('#workspaceViewKanban')).toBeHidden();
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#overviewBody')).toContainText('No open projects.');
  });
});

test('Now exposes malformed project briefs and keeps readable source cards available', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardB }) => {
    const malformedPath = path.join(boardB, '000-To-do-stock', '001-malformed-stock.md');
    const malformedBytes = '---\ntitle: [unterminated\n---\nReadable legacy fallback fixture.';
    await fs.writeFile(malformedPath, malformedBytes);
    await fs.writeFile(path.join(boardB, '.signboard-project.md'), '---\nsignboard_project: 1\ngoal: [unterminated\n---\n');
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('.overview-project')).toHaveCount(2);
    await expect(page.locator('.overview-source-warning')).toContainText('Some project files could not be read');
    await page.locator('[data-overview-project]').filter({ hasText: 'Beta Project' }).click();
    await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(3);
    await expect(page.locator('#overviewDetailBody')).toContainText('malformed YAML');
    await expect(page.locator('#overviewDetailBody')).toContainText('Readable legacy fallback fixture.');
    await expect(page.locator('#overviewDetailBody')).toContainText('Plan release notes');
    await expect(page.locator('#overviewDetailBody')).toContainText('Polish homepage copy');
    await page.locator('#overviewSearchInput').fill('unique full notes needle');
    await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(1);
    await expect(page.locator('.overview-source-warning').first()).toBeVisible();
    expect(await fs.readFile(malformedPath, 'utf8')).toBe(malformedBytes);
    await page.screenshot({ path: testInfo.outputPath('now-partial-source-warning.png') });
  });
});

test('a foreign project source conflict preserves the exact draft, disk bytes and selected detail', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardA, boardB, cardPath }) => {
    await page.locator('#workspaceViewOverview').click();
    await page.locator('[data-overview-project]').filter({ hasText: 'Beta Project' }).click();
    await page.locator('#overviewSearchInput').fill('Beta reviewer Tighten');
    await page.locator('#overviewDetailBody .overview-card-title').click();
    await expect(page.locator('#modalEditCard')).toBeVisible();
    const draft = 'My exact unsaved draft\n\n- Keep this final line.\n';
    await page.evaluate((text) => {
      isApplyingExternalEditorRefresh = true;
      activeCardEditorInstance.setValue(text);
      isApplyingExternalEditorRefresh = false;
    }, draft);
    const source = await cardFrontmatter.readCard(cardPath);
    await cardFrontmatter.writeCard(cardPath, { frontmatter: { ...source.frontmatter, external_custom: 'retain-me' }, body: 'External saved source context' });
    const savedBytes = await fs.readFile(cardPath);
    await page.evaluate(async () => { await enqueueEditorSave(getEditorBodyValue()); });
    await expect(page.locator('#cardEditorSaveConflict')).toBeVisible();
    await expect(page.locator('#cardEditorOverType .overtype-input')).toHaveValue(draft);
    expect(await fs.readFile(cardPath)).toEqual(savedBytes);
    expect(await page.evaluate(async () => {
      try { await switchWorkspaceView('table'); return false; } catch { return true; }
    })).toBe(true);
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('#modalEditCard')).toBeVisible();
    expect(await page.evaluate(() => window.boardRoot)).toBe(normalizeRoot(boardB));
    expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boardA));
    await page.getByRole('button', { name: 'Review saved version', exact: true }).click();
    await expect(page.locator('#cardEditorSaveConflict textarea')).toHaveValue(/External saved source context/);
    await page.screenshot({ path: testInfo.outputPath('now-foreign-source-conflict.png') });
    const merged = `External saved source context\n\n${draft}`;
    await page.locator('#cardEditorOverType .overtype-input').fill(merged);
    await page.getByRole('button', { name: 'Save merged draft', exact: true }).click();
    await expect(page.locator('#cardEditorSaveConflict')).toHaveCount(0);
    const saved = await cardFrontmatter.readCard(cardPath);
    expect(saved.body).toBe(merged);
    expect(saved.frontmatter.external_custom).toBe('retain-me');
    await page.locator('#cardEditorClose').click();
    await expect(page.locator('#modalEditCard')).toBeHidden();
    expect(await page.evaluate(() => window.boardRoot)).toBe(normalizeRoot(boardA));
    await expect(page.locator('#overviewProjectDetail')).toContainText('Beta Project');
    await expect(page.locator('#overviewSearchInput')).toHaveValue('Beta reviewer Tighten');
    await page.locator('#overviewSearchInput').fill('');
    await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(2);
  });
});
