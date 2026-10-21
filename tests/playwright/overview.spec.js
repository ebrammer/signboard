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

test('Projects combines the attention preview and project grid with a separate full request queue', async () => {
  await withOverviewApp(async ({ page, boardA, cardPath }) => {
    const requestPaths = [
      path.join(boardA, '000-To-do-stock', '000-plan-release-stock.md'),
      path.join(boardA, '001-Doing-stock', '000-polish-copy-stock.md'),
      cardPath,
    ];
    for (const [index, requestPath] of requestPaths.entries()) {
      const card = await cardFrontmatter.readCard(requestPath);
      await cardFrontmatter.writeCard(requestPath, { ...card, frontmatter: {
        ...card.frontmatter, sb_attention: 'review', sb_request: `Review option ${index + 1}`,
      } });
    }
    await page.locator('#workspaceViewOverview').click();
    const projectsTab = page.locator('#overviewProjectsTab');
    const needsTab = page.locator('#overviewNeedsYouTab');
    await expect(page.locator('.overview-tabs [role=tab]')).toHaveCount(2);
    await expect(page.locator('#overviewNowTab')).toHaveCount(0);
    await expect(projectsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#overviewTitle')).toHaveText('Projects');
    await expect(page.locator('#overviewBody')).toHaveAttribute('aria-labelledby', 'overviewProjectsTab');
    await expect(page.locator('#overviewBody > section').first()).toHaveClass('overview-needs-preview');
    await expect(page.locator('.overview-request-preview')).toHaveCount(2);
    await expect(page.locator('.overview-project')).toHaveCount(2);
    await expect(page.locator('#overviewRequestCount')).toHaveText('3');
    await page.locator('#overviewViewAllRequests').click();
    await expect(needsTab).toBeFocused();
    await expect(needsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#overviewBody .overview-request')).toHaveCount(3);
    await expect(page.locator('.overview-project')).toHaveCount(0);
    await expect(page.locator('#overviewBody')).toHaveAttribute('aria-labelledby', 'overviewNeedsYouTab');
    await needsTab.press('ArrowRight');
    await expect(projectsTab).toBeFocused();
    await expect(page.locator('.overview-request-preview')).toHaveCount(2);
    await projectsTab.press('ArrowLeft');
    await expect(needsTab).toBeFocused();
    await needsTab.press('Home');
    await expect(projectsTab).toBeFocused();
    await projectsTab.press('End');
    await expect(needsTab).toBeFocused();
    await expect(projectsTab).toHaveAttribute('tabindex', '-1');
    await expect(needsTab).toHaveAttribute('tabindex', '0');
    await page.locator('#overviewSearchInput').fill('Review option 3');
    await expect(page.locator('#overviewBody .overview-request')).toHaveCount(1);
    await expect(page.locator('#overviewRequestCount')).toHaveText('3');
    await projectsTab.click();
    await expect(page.locator('.overview-request-preview')).toHaveCount(1);
    await expect(page.locator('.overview-project')).toHaveCount(1);
    await page.locator('#overviewSearchInput').fill('no matching request');
    await expect(page.locator('.overview-needs-preview')).toHaveCount(0);
    await expect(page.locator('#overviewBody')).toContainText('No projects or cards match your search.');
  });
});

test('Overview preserves custom workflows, searches all projects, edits source cards and refreshes external writes', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardA, boardB, cardPath }) => {
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('.overview-project')).toHaveCount(2);
    await expect(page.locator('.overview-card')).toHaveCount(0);
    // Each project keeps its complete source workflow in its own detail view.
    for (const board of [boardA, boardB]) {
      await page.locator(`[data-overview-details="${normalizeRoot(board)}"]`).click();
      await expect(page.locator('#overviewProjectDetail')).toBeVisible();
      await page.locator('.overview-completed-toggle').click();
      await expect(page.locator('#overviewDetailBody .overview-card')).toHaveCount(3);
      await page.locator('#overviewDetailBack').click();
    }
    await page.locator(`[data-overview-details="${normalizeRoot(boardB)}"]`).click();
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
  await withOverviewApp(async ({ page, boardA, boardB }) => {
    await page.locator('#workspaceViewOverview').click();
    await fs.rename(boardB, `${boardB}-unavailable`);
    await expect(page.locator('.overview-source-warning')).toContainText('Some project files could not be read', { timeout: 15000 });
    await page.locator(`[data-overview-project="${normalizeRoot(boardB)}"]`).click();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('#overviewNavigationError')).toBeVisible();
    expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boardA));
    await expect(fs.stat(boardB)).rejects.toThrow();
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

test('Projects exposes malformed project briefs and keeps readable source cards available', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardB }) => {
    const malformedPath = path.join(boardB, '000-To-do-stock', '001-malformed-stock.md');
    const malformedBytes = '---\ntitle: [unterminated\n---\nReadable legacy fallback fixture.';
    await fs.writeFile(malformedPath, malformedBytes);
    await fs.writeFile(path.join(boardB, '.signboard-project.md'), '---\nsignboard_project: 1\ngoal: [unterminated\n---\n');
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('.overview-project')).toHaveCount(2);
    await expect(page.locator('.overview-source-warning')).toContainText('Some project files could not be read');
    await page.locator(`[data-overview-details="${normalizeRoot(boardB)}"]`).click();
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
    await page.locator(`[data-overview-details="${normalizeRoot(boardB)}"]`).click();
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

test('project tiles open the chosen Kanban while Show details stays in Projects and the header stays compact', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardA, boardB, cardPath }) => {
    const sourceBytes = await fs.readFile(cardPath);
    // Give the destination a remembered Table view before returning to another project.
    await page.evaluate(async (root) => { await switchToBoardPath(root); await switchWorkspaceView('table'); }, normalizeRoot(boardB));
    await expect(page.locator('.board-table-view')).toBeVisible();
    await page.evaluate((root) => switchToBoardPath(root), normalizeRoot(boardA));
    await expect(page.locator('#boardName')).toHaveText('Alpha Project');
    await page.locator('#workspaceViewOverview').click();
    const main = page.locator(`[data-overview-project="${normalizeRoot(boardB)}"]`);
    const details = page.locator(`[data-overview-details="${normalizeRoot(boardB)}"]`);
    await expect(page.locator('.overview-project [data-overview-project]')).toHaveCount(2);
    await expect(page.locator('.overview-project [data-overview-details]')).toHaveCount(2);
    await expect(page.locator('.overview-project button button')).toHaveCount(0);
    expect(await main.evaluate((element) => element.tagName)).toBe('BUTTON');
    expect(await details.evaluate((element) => element.tagName)).toBe('BUTTON');
    expect(await details.evaluate((element) => { const main = element.closest('.overview-project').querySelector('[data-overview-project]'); return !main.contains(element) && !element.contains(main); })).toBe(true);
    for (const width of [1000, 560]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.locator('#overviewSubtitle')).toHaveCount(0);
      const header = await page.locator('.overview-header').boundingBox();
      const title = await page.locator('#overviewTitle').boundingBox();
      const search = await page.locator('#overviewSearchInput').boundingBox();
      expect(header.height).toBeLessThanOrEqual(64);
      expect(title.y).toBeGreaterThanOrEqual(header.y);
      expect(title.y + title.height).toBeLessThanOrEqual(header.y + header.height);
      expect(search.y).toBeGreaterThanOrEqual(header.y);
      expect(search.y + search.height).toBeLessThanOrEqual(header.y + header.height);
      expect(await page.locator('#overviewOverlay').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`now-thin-header-${width}.png`) });
    }
    await details.focus();
    await details.press('Enter');
    await expect(page.locator('#overviewProjectDetail')).toBeVisible();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    expect(await page.evaluate(() => window.boardRoot)).toBe(normalizeRoot(boardA));
    expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boardA));
    await page.locator('#overviewDetailBack').click();
    await expect(details).toBeFocused();
    await main.click();
    await expect(page.locator('#overviewOverlay')).toBeHidden();
    await expect(page.locator('#boardName')).toHaveText('Beta Project');
    await expect(page.locator('#workspaceViewKanban')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.board-table-view')).toHaveCount(0);
    await expect(page.locator('#board .card')).toHaveCount(3);
    await expect(page.locator('#board')).toContainText('Waiting on reviewer');
    expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boardB));
    expect(await page.evaluate(() => getActiveBoardView())).toBe('kanban');
    for (const view of ['table', 'planner']) {
      await page.locator(view === 'table' ? '#workspaceViewTable' : '#workspaceViewPlanner').click();
      await expect(page.locator(view === 'table' ? '.board-table-view' : '#plannerOverlay')).toBeVisible();
      await page.locator('#workspaceViewOverview').click();
      await main.focus();
      await main.press(view === 'table' ? 'Enter' : 'Space');
      await expect(page.locator('#overviewOverlay')).toBeHidden();
      await expect(page.locator('#plannerOverlay')).toBeHidden();
      await expect(page.locator('#workspaceViewKanban')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#board .card')).toHaveCount(3);
      expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boardB));
      expect(await page.evaluate(() => getActiveBoardView())).toBe('kanban');
    }
    expect(await fs.readFile(cardPath)).toEqual(sourceBytes);
    await page.screenshot({ path: testInfo.outputPath('project-tile-kanban-narrow.png') });
  });
});

test('a failed same-project Kanban render restores Projects with a visible error and supports retry', async ({}, testInfo) => {
  await withOverviewApp(async ({ page, boardA }) => {
    await page.locator('#workspaceViewTable').click();
    await expect(page.locator('.board-table-view')).toBeVisible();
    await page.locator('#workspaceViewOverview').click();
    await page.evaluate(() => {
      window.__nowOriginalRenderBoard = renderBoard;
      window.__nowRenderAttempts = 0;
      renderBoard = async () => { window.__nowRenderAttempts += 1; throw new Error('Synthetic Kanban render failure'); };
    });
    const main = page.locator(`[data-overview-project="${normalizeRoot(boardA)}"]`);
    await main.click();
    await expect(page.locator('#overviewOverlay')).toBeVisible();
    await expect(page.locator('#overviewNavigationError')).toBeVisible();
    await expect(page.locator('#overviewNavigationError')).toContainText('This project could not be opened.');
    expect(await page.evaluate(() => window.__nowRenderAttempts)).toBe(1);
    expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boardA));
    // The error survives a snapshot refresh until a deliberate retry.
    await page.evaluate(() => renderOverviewView());
    await expect(page.locator('#overviewNavigationError')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('now-kanban-render-error.png') });
    await page.evaluate(() => {
      renderBoard = async (...args) => { window.__nowRenderAttempts += 1; return window.__nowOriginalRenderBoard(...args); };
    });
    await main.click();
    await expect(page.locator('#overviewOverlay')).toBeHidden();
    await expect(page.locator('#workspaceViewKanban')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#board .card')).toHaveCount(3);
    expect(await page.evaluate(() => window.__nowRenderAttempts)).toBe(2);
    await page.evaluate(() => { renderBoard = window.__nowOriginalRenderBoard; delete window.__nowOriginalRenderBoard; });
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#overviewNavigationError')).toBeHidden();
  });
});
