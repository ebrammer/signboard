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
    await expect(page.locator('.overview-card')).toHaveCount(6);
    await expect(page.locator('.overview-list-title', { hasText: 'Waiting on reviewer' })).toHaveText('Waiting on reviewer · 1');
    await expect(page.locator('#overviewCount')).toHaveText('2 projects · 6 cards');
    await page.screenshot({ path: testInfo.outputPath('overview-populated.png') });
    await page.locator('#overviewSearchInput').fill('Beta reviewer Tighten');
    await expect(page.locator('.overview-card')).toHaveCount(1);
    await expect(page.locator('.overview-card')).toContainText('Polish homepage copy');
    const overviewBackground = await page.locator('#overviewOverlay').evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.locator('.overview-card').click();
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
    await expect(page.locator('#overviewBody')).toContainText('No cards match your search.');
    await page.locator('#workspaceViewTable').click();
    await expect(page.locator('#overviewOverlay')).toBeHidden();
    await expect(page.locator('#workspaceViewTable')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#workspaceViewPlanner').click();
    await expect(page.locator('#plannerOverlay')).toBeVisible();
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#plannerOverlay')).toBeHidden();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('#overviewSearchInput')).toHaveValue('no-such-card');
    await page.locator('#overviewSearchInput').fill('');
    await expect(page.locator('.overview-card')).toHaveCount(6);
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
