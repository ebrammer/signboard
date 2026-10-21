const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const electronBinary = require('electron');
const { createFixtureBoardAt } = require('./helpers/fixtureBoard');

const repoRoot = path.resolve(__dirname, '../..');
const normalizeRoot = (root) => `${root.replace(/\/+$/, '')}/`;

async function withWorkspaceFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-workspace-restoration-'));
  const profile = path.join(root, 'profile');
  const boards = [];
  const apps = [];
  await fs.mkdir(profile);
  try {
    for (let index = 1; index <= 5; index += 1) boards.push(await createFixtureBoardAt(root, `Project ${index}`));
    const untrusted = await createFixtureBoardAt(root, 'Untrusted Project');
    await fs.writeFile(path.join(profile, 'trusted-board-roots.json'), JSON.stringify(boards));
    const persist = async (openBoardRoots = [...boards, untrusted]) => {
      await fs.writeFile(path.join(profile, 'open-boards.json'), JSON.stringify({ openBoardRoots, activeBoardRoot: boards[2] }));
    };
    const launch = async () => {
      const virtualDisplay = process.platform === 'linux' && process.env.SIGNBOARD_PLAYWRIGHT_VIRTUAL_DESKTOP === '1';
      const app = await electron.launch({ executablePath: electronBinary, cwd: repoRoot,
        args: [...(virtualDisplay ? ['--ozone-platform=x11'] : []), '.'],
        env: { ...process.env, SIGNBOARD_USER_DATA_DIR: profile, SIGNBOARD_TEST_DISABLE_FAVICON_FETCH: '1' },
      });
      apps.push(app);
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      return { app, page };
    };
    await run({ root, profile, boards, persist, launch });
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('first launch restores five trusted project boards from persisted workspace when renderer storage is absent', async ({}, testInfo) => {
  await withWorkspaceFixture(async ({ boards, persist, launch }) => {
    await persist();
    const { page } = await launch();
    await expect(page.locator('#boardName')).toHaveText('Project 3');
    await expect(page.locator('#board .card')).toHaveCount(3);
    expect(await page.evaluate(() => getStoredOpenBoards())).toEqual(boards.map(normalizeRoot));
    expect(await page.evaluate(() => getStoredActiveBoard())).toBe(normalizeRoot(boards[2]));
    const persisted = await page.evaluate(() => window.board.getPersistedOpenBoardsState());
    expect(persisted.openBoardRoots).toEqual(boards);
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('.overview-project')).toHaveCount(5);
    await expect(page.locator('.overview-card')).toHaveCount(15);
    await expect(page.locator('#overviewCount')).toHaveText('5 projects · 15 cards');
    await expect(page.locator('#overviewBody')).not.toContainText('Untrusted Project');
    await page.screenshot({ path: testInfo.outputPath('restored-five-projects.png') });
  });
});

test('an explicitly empty renderer workspace stays empty even when persisted snapshot still lists boards', async () => {
  await withWorkspaceFixture(async ({ persist, launch }) => {
    await persist([]);
    const initial = await launch();
    await expect(initial.page.locator('#workspaceViewOverview')).toBeVisible();
    await initial.page.evaluate(() => {
      localStorage.setItem('openBoardPaths', '[]');
      localStorage.setItem('activeBoardPath', '');
      localStorage.setItem('boardPath', '');
    });
    await initial.app.close();
    await persist();
    const { page } = await launch();
    await expect(page.locator('#emptyBoardCallToAction')).toBeVisible();
    expect(await page.evaluate(() => getStoredOpenBoards())).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('openBoardPaths'))).toBe('[]');
    await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#overviewBody')).toContainText('No open projects.');
  });
});
