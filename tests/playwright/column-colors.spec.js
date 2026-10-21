const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const electronBinary = require('electron');
const { createFixtureBoardAt } = require('./helpers/fixtureBoard');
const boardSettings = require('../../lib/boardLabels');
const colors = require('../../shared/columnColors');

// Uses disposable board/profile data and the repository's normal launch gate.
async function openFixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-column-colors-'));
  let app;
  try {
    const boardRoot = await createFixtureBoardAt(temp, 'Column Colors');
    for (const name of ['003-Waiting-stock', '004-Blocked-stock', '005-Doing-abcde']) {
      await fs.mkdir(path.join(boardRoot, name));
    }
    const profile = path.join(temp, 'profile');
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'trusted-board-roots.json'), JSON.stringify([boardRoot]));
    app = await electron.launch({ executablePath: electronBinary, cwd: path.resolve(__dirname, '../..'), args: ['.'],
      env: { ...process.env, SIGNBOARD_USER_DATA_DIR: profile, SIGNBOARD_TEST_DISABLE_FAVICON_FETCH: '1' },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(root => {
      localStorage.setItem('openBoardPaths', JSON.stringify([root]));
      localStorage.setItem('activeBoardPath', root);
      localStorage.setItem('boardPath', root);
    }, `${boardRoot}/`);
    await page.reload();
    await expect(page.locator('#boardName')).toHaveText('Column Colors');
    await expect(page.locator('#board > .list')).toHaveCount(6);
    return { app, page, temp, boardRoot };
  } catch (error) {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
}

function column(page, directoryName) {
  return page.locator('#board > .list').filter({ has: page.locator(`.list-header [data-listpath$="/${directoryName}"]`) });
}

async function headerColor(list) {
  return list.evaluate(el => el.style.getPropertyValue('--column-header-bg'));
}

async function closeFixture(fixture) {
  await fixture.app.close();
  await fs.rm(fixture.temp, { recursive: true, force: true });
}

test('workflow colors, custom persistence, rename, reorder and reset', async () => {
  const fixture = await openFixture();
  const { page, boardRoot } = fixture;
  try {
    for (const [name, expected] of [['000-To-do-stock', '#64748b'], ['001-Doing-stock', '#2563eb'], ['002-Done-stock', '#15803d'], ['003-Waiting-stock', '#b45309'], ['004-Blocked-stock', '#b91c1c']]) {
      expect(await headerColor(column(page, name))).toBe(expected);
    }
    expect((await boardSettings.readBoardSettings(boardRoot)).columnColors).toEqual({});
    const lightBody = await column(page, '001-Doing-stock').evaluate(el => el.style.getPropertyValue('--column-body-bg'));
    await page.evaluate(() => setAppAppearanceMode('dark'));
    expect(await column(page, '001-Doing-stock').evaluate(el => el.style.getPropertyValue('--column-body-bg'))).not.toBe(lightBody);
    expect(await headerColor(column(page, '001-Doing-stock'))).toBe('#2563eb');
    await page.evaluate(() => setAppAppearanceMode('light'));

    const doing = column(page, '001-Doing-stock');
    await doing.getByRole('button', { name: 'List actions for Doing', exact: true }).click();
    const picker = page.getByLabel('Custom column color', { exact: true });
    await picker.evaluate(input => { input.value = '#7c3aed'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('#listActionsPopover')).toBeHidden();
    await expect(doing.getByRole('button', { name: 'List actions for Doing', exact: true })).toBeFocused();
    expect(await headerColor(doing)).toBe(colors.getColumnPalette('#7c3aed').header);
    expect(await headerColor(column(page, '005-Doing-abcde'))).toBe('#2563eb');
    await expect.poll(async () => (await boardSettings.readBoardSettings(boardRoot)).columnColors).toEqual({ 'doing-stock': '#7c3aed' });
    await page.reload();
    await expect(column(page, '001-Doing-stock')).toBeVisible();
    expect(await headerColor(column(page, '001-Doing-stock'))).toBe('#7c3aed');

    const name = column(page, '001-Doing-stock').getByRole('textbox', { name: 'List name' });
    await name.fill('In progress');
    await name.press('Enter');
    const renamed = column(page, '001-In progress-stock');
    await expect(renamed).toBeVisible();
    expect(await headerColor(renamed)).toBe('#7c3aed');
    await renamed.getByRole('button', { name: 'List actions for In progress', exact: true }).click();
    await page.getByRole('button', { name: 'Move list right', exact: true }).click();
    const reordered = column(page, '002-In progress-stock');
    await expect(reordered).toBeVisible();
    expect(await headerColor(reordered)).toBe('#7c3aed');
    await reordered.getByRole('button', { name: 'List actions for In progress', exact: true }).click();
    await page.getByRole('button', { name: 'Use workflow color', exact: true }).click();
    await expect(page.locator('#listActionsPopover')).toBeHidden();
    expect(await headerColor(reordered)).toBe('#2563eb');
    expect((await boardSettings.readBoardSettings(boardRoot)).columnColors).toEqual({});
    await page.reload();
    await expect(column(page, '002-In progress-stock')).toBeVisible();
    expect(await headerColor(column(page, '002-In progress-stock'))).toBe('#2563eb');
  } finally {
    await closeFixture(fixture);
  }
});

test('column controls remain keyboard accessible and failed writes can be retried', async () => {
  const fixture = await openFixture();
  const { page } = fixture;
  try {
    const action = column(page, '001-Doing-stock').getByRole('button', { name: 'List actions for Doing', exact: true });
    await action.click();
    await page.keyboard.press('End');
    await expect(page.getByRole('button', { name: 'Archive this list', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByRole('button', { name: /^Add new card/ })).toBeFocused();
    await page.getByLabel('Custom column color', { exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Use workflow color', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(action).toBeFocused();
    await action.click();
    await page.evaluate(() => {
      const original = persistBoardColumnColor;
      window.__restoreColumnColorSettings = () => { persistBoardColumnColor = original; };
      persistBoardColumnColor = async () => { throw new Error('Fixture disk failure'); };
    });
    await page.getByRole('button', { name: 'Purple column color', exact: true }).click();
    await expect(page.locator('.column-color-error')).toHaveText('Column color could not be saved. Try again.');
    await expect(page.getByRole('button', { name: 'Purple column color', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Purple column color', exact: true })).toBeFocused();
    await page.evaluate(() => window.__restoreColumnColorSettings());
    await page.getByRole('button', { name: 'Purple column color', exact: true }).click();
    await expect(page.locator('#listActionsPopover')).toBeHidden();
    expect(await headerColor(column(page, '001-Doing-stock'))).toBe('#7c3aed');
  } finally {
    await closeFixture(fixture);
  }
});
