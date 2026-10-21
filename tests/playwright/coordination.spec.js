const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const { createFixtureBoardAt } = require('./helpers/fixtureBoard');
const cardFrontmatter = require('../../lib/cardFrontmatter');
const coordination = require('../../lib/projectCoordination');
const normalizeRoot = (root) => `${root.replace(/\/+$/, '')}/`;
async function withApp(run, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'signboard-coordination-ui-'));
  let app;
  try {
    const boards = [];
    for (let i = 1; i <= count; i++) boards.push(await createFixtureBoardAt(root, `Project ${i}`));
    const profile = path.join(root, 'profile'); await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'trusted-board-roots.json'), JSON.stringify(boards));
    const virtual = process.platform === 'linux' && process.env.SIGNBOARD_PLAYWRIGHT_VIRTUAL_DESKTOP === '1';
    app = await electron.launch({ executablePath: require('electron'), cwd: path.resolve(__dirname, '../..'), args: [...(virtual ? ['--ozone-platform=x11'] : []), '.'],
      env: { ...process.env, SIGNBOARD_USER_DATA_DIR: profile, SIGNBOARD_TEST_DISABLE_FAVICON_FETCH: '1' } });
    const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
    await page.evaluate((roots) => {
      localStorage.setItem('openBoardPaths', JSON.stringify(roots)); localStorage.setItem('activeBoardPath', roots[0]); localStorage.setItem('boardPath', roots[0]);
    }, boards.map(normalizeRoot)); await page.reload();
    await expect(page.locator('#boardName')).toHaveText('Project 1');
    await page.locator('#workspaceViewOverview').click();
    const cardPath = path.join(boards[0], '001-Doing-stock', '000-polish-copy-stock.md');
    await run({ page, boards, cardPath, root });
  } finally { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const panel = (page) => page.locator('#overviewCoordinationPanel');
const update = async (cardPath, patch) => coordination.updateCardCoordination(path.dirname(path.dirname(cardPath)), cardPath, patch, (await cardFrontmatter.readCard(cardPath)).revision);

test('compact projects preserve legacy bytes, fit five rows, edit summaries and coordinate a human reply', async ({}, testInfo) => {
  await withApp(async ({ page, boards, cardPath }) => {
    const before = await fs.readFile(cardPath, 'utf8');
    await expect(page.locator('.overview-project')).toHaveCount(5);
    await expect(page.locator('.overview-card')).toHaveCount(0);
    await expect(page.locator('#overviewBody')).toContainText('No goal set');
    await expect(page.locator('#overviewBody')).toContainText('(Doing list)');
    await page.setViewportSize({ width: 900, height: 800 });
    expect(await page.locator('#overviewBody').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(await fs.readFile(cardPath, 'utf8')).toBe(before);
    await expect(fs.stat(path.join(boards[0], '.signboard-project.md'))).rejects.toThrow();
    await page.screenshot({ path: testInfo.outputPath('compact-five-projects.png') });
    await page.getByRole('button', { name: 'Edit Project 1 summary' }).click();
    await panel(page).getByLabel('Goal', { exact: true }).fill('Make the next release easier to review');
    await panel(page).getByLabel('Next step', { exact: true }).fill('Choose a homepage draft');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('#overviewBody')).toContainText('Make the next release easier to review');
    const brief = await coordination.readProjectBrief(boards[0]); expect(brief.nextStep).toBe('Choose a homepage draft');
    await page.locator('[data-overview-expand]').first().click();
    await page.getByRole('button', { name: 'Coordinate Polish homepage copy', exact: true }).click();
    await panel(page).getByLabel('Work status', { exact: true }).selectOption('blocked');
    await panel(page).getByLabel('Needs you', { exact: true }).selectOption('review');
    await panel(page).getByLabel('Request / ask', { exact: true }).fill('Which homepage draft should we ship?');
    await panel(page).getByLabel('Next step', { exact: true }).fill('Apply your chosen draft');
    await panel(page).getByLabel('Evidence', { exact: true }).fill('Draft A: short; Draft B: detailed. Preview in source notes.');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('.overview-project').first()).toContainText('1 blocked');
    await page.getByRole('tab', { name: 'Needs you' }).click();
    await expect(page.locator('.overview-request')).toHaveCount(1);
    await expect(page.locator('.overview-request')).toContainText('Which homepage draft should we ship?');
    await expect(page.locator('.overview-request')).toContainText('Draft A: short; Draft B: detailed.');
    await page.screenshot({ path: testInfo.outputPath('needs-you-review.png') });
    await page.getByRole('button', { name: 'Polish homepage copy', exact: true }).click();
    await expect(page.locator('#modalEditCard')).toBeVisible();
    await expect(page.locator('#cardEditorTitle')).toHaveText('Polish homepage copy');
    await page.waitForTimeout(150);
    await expect(page.locator('#modalEditCard')).toBeVisible();
    await page.locator('#cardEditorClose').click();
    await expect(page.locator('#modalEditCard')).toBeHidden();
    await expect(page.locator('.overview-request')).toHaveCount(1);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await panel(page).getByLabel('Your reply', { exact: true }).fill('Ship draft A.');
    // Polling must leave input, focus, and revision intact.
    await page.waitForTimeout(3100);
    await expect(panel(page).getByLabel('Your reply', { exact: true })).toHaveValue('Ship draft A.');
    await panel(page).getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(page.locator('.overview-request')).toHaveCount(0);
    await expect(page.locator('#overviewBody')).toContainText('Nothing needs your attention');
    const saved = await cardFrontmatter.readCard(cardPath);
    expect(saved.frontmatter.sb_response).toBe('Ship draft A.'); expect(saved.frontmatter.sb_attention).toBe('none'); expect(saved.frontmatter.sb_work_status).toBe('blocked');
    await fs.stat(cardPath); // replying never moves the source card
    await page.getByRole('tab', { name: 'Projects', exact: true }).click();
    await page.locator('[data-overview-expand]').first().click();
    await page.setViewportSize({ width: 560, height: 800 });
    expect(await page.locator('#overviewOverlay').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('#overviewBody').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('compact-narrow.png') });
    await page.reload(); await page.locator('#workspaceViewOverview').click();
    await expect(page.locator('#overviewBody')).toContainText('Make the next release easier to review');
  }, 5);
});

test('project and request conflicts preserve drafts until latest context is reviewed', async () => {
  await withApp(async ({ page, boards, cardPath }) => {
    await page.getByRole('button', { name: 'Edit Project 1 summary' }).click();
    await panel(page).getByLabel('Goal', { exact: true }).fill('My draft goal');
    await page.evaluate(() => switchWorkspaceView('table'));
    await expect(page.locator('#overviewOverlay')).toBeHidden();
    await expect(page.locator('.workspace-view-dock')).not.toHaveAttribute('inert');
    expect(await page.evaluate(() => getAccessibilityState().activeModal)).toBeNull();
    await page.locator('#workspaceViewOverview').click();
    await expect(panel(page).getByLabel('Goal', { exact: true })).toHaveValue('My draft goal');
    await coordination.updateProjectBrief(boards[0], { goal: 'Agent goal' }, 'missing');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page)).toContainText('Your draft is kept');
    await expect(panel(page).getByLabel('Goal', { exact: true })).toHaveValue('My draft goal');
    await panel(page).getByRole('button', { name: 'Load latest context' }).click();
    await expect(panel(page)).toContainText('Latest goal: Agent goal');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await update(cardPath, { attention: 'decision', request: 'Pick A or B', evidence: 'A is smaller' });
    await page.getByRole('tab', { name: 'Needs you' }).click();
    await expect(page.locator('.overview-request')).toHaveCount(1, { timeout: 15000 });
    await page.getByRole('button', { name: 'Reply', exact: true }).focus();
    await update(cardPath, { summary: 'External refresh while focused' });
    await expect(page.locator('.overview-request')).toContainText('External refresh while focused', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await panel(page).getByLabel('Your reply', { exact: true }).fill('Choose A');
    await update(cardPath, { request: 'Pick B or C', evidence: 'New evidence favors C' });
    await panel(page).getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(panel(page)).toContainText('Your draft is kept');
    await expect(panel(page).getByLabel('Your reply', { exact: true })).toHaveValue('Choose A');
    await panel(page).getByRole('button', { name: 'Load latest context' }).click();
    await expect(panel(page)).toContainText('Pick B or C');
    await expect(panel(page)).toContainText('New evidence favors C');
    await panel(page).getByLabel('Your reply', { exact: true }).fill('Choose C');
    await panel(page).getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    expect((await cardFrontmatter.readCard(cardPath)).frontmatter.sb_response).toBe('Choose C');
  });
});

test('completed workflow requests stay out of Needs you and completed sources remain searchable', async () => {
  await withApp(async ({ page, boards, cardPath }) => {
    const done = path.join(boards[0], '002-Done-stock', '000-ship-beta-stock.md');
    await update(done, { attention: 'review', request: 'Historical request', workStatus: 'working' });
    // Preserve custom lists rather than guessing their activity or completion.
    const custom = path.join(boards[0], '003-Waiting on partner-stock'); await fs.mkdir(custom);
    const customCard = path.join(custom, '000-custom-stock.md');
    await cardFrontmatter.writeCard(customCard, { frontmatter: { title: 'Partner research' }, body: 'Undated context' });
    await update(customCard, { attention: 'question', request: 'Who is our partner?', evidence: 'Research notes' });
    await page.getByRole('tab', { name: 'Needs you' }).click();
    await expect(page.locator('.overview-request')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.overview-request')).toContainText('Who is our partner?');
    await expect(page.locator('.overview-request')).not.toContainText('Historical request');
    await page.getByRole('tab', { name: 'Projects', exact: true }).click();
    await page.locator('[data-overview-expand]').click();
    await expect(page.locator('.overview-card')).toHaveCount(3);
    await expect(page.locator('.overview-list-title', { hasText: 'Waiting on partner' })).toBeVisible();
    await page.getByRole('button', { name: 'Show completed · 1' }).click();
    await expect(page.locator('.overview-card')).toHaveCount(4);
    await page.getByRole('button', { name: 'Hide completed · 1' }).click();
    await page.locator('#overviewSearchInput').fill('Historical request');
    await expect(page.locator('.overview-card')).toHaveCount(1);
    await expect(page.locator('.overview-card')).toContainText('Ship beta');
    await page.locator('#overviewSearchInput').fill('Research notes');
    await expect(page.locator('.overview-card')).toHaveCount(1);
    await expect(page.locator('.overview-card')).toContainText('Partner research');
    expect((await cardFrontmatter.readCard(cardPath)).frontmatter.sb_attention).toBeUndefined();
  });
});

test('Overview controls follow light and dark palettes and long requests fit narrow windows', async ({}, testInfo) => {
  await withApp(async ({ page, cardPath }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    for (const mode of ['light', 'dark']) {
      await page.evaluate(async (mode) => { await setAppAppearanceMode(mode); syncOverviewBoardTheme(); }, mode);
      const colors = await page.evaluate(() => {
        const input = getComputedStyle(document.getElementById('overviewSearchInput'));
        const card = getComputedStyle(document.querySelector('.overview-project'));
        return { inputBg: input.backgroundColor, inputText: input.color, cardBg: card.backgroundColor, cardText: card.color };
      });
      expect(colors.inputBg).toBe(colors.cardBg);
      expect(colors.inputText).toBe(colors.cardText);
      await page.screenshot({ path: testInfo.outputPath(`overview-${mode}-desktop.png`) });
    }
    await update(cardPath, { attention: 'review', request: 'Review the narrow window layout',
      nextStep: 'Review the complete instructions before confirming. '.repeat(8), evidence: 'https://example.test/' + 'long-path-'.repeat(80) });
    await page.getByRole('tab', { name: 'Needs you' }).click();
    await expect(page.locator('.overview-request')).toHaveCount(1, { timeout: 15000 });
    await page.setViewportSize({ width: 560, height: 800 });
    expect(await page.locator('#overviewBody').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.overview-request .overview-next-step').evaluate(el => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('overview-dark-narrow-request.png') });
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(panel(page).getByLabel('Your reply')).toBeVisible();
    const actions = await panel(page).evaluate(el => {
      const save = getComputedStyle(el.querySelector('.overview-save'));
      const close = getComputedStyle(el.querySelector('.overview-cancel'));
      return { saveBg: save.backgroundColor, closeBg: close.backgroundColor };
    });
    expect(actions.saveBg).not.toBe(actions.closeBg);
    await page.screenshot({ path: testInfo.outputPath('overview-dark-narrow-reply.png') });
  });
});
