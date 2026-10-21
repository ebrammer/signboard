const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/board/boardLabels.js'), 'utf8');
const start = source.indexOf('const COLOR_SCHEMES = [');
const end = source.indexOf('\nfunction getColorSchemeById', start);
assert(start >= 0 && end > start);
const schemes = JSON.parse(vm.runInNewContext(`${source.slice(start, end)}; JSON.stringify(COLOR_SCHEMES)`, {}, { timeout: 1000 }));
assert.equal(schemes.length, 51);
assert.equal(new Set(schemes.map(scheme => scheme.id)).size, schemes.length);
const originalIds = new Set(['default', 'lavender', 'harvest', 'olive', 'evergreen', 'rosewood', 'mid-winter', 'cozy-blush', 'coffee']);
const added = schemes.filter(scheme => !originalIds.has(scheme.id));
// The named existing schemes retain their established appearance. These checks guard
// the 42 new contributions against unreadable metadata, links and button text.
assert.equal(added.length, 42);
const keys = Object.keys(schemes[0].light).sort();
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(h => parseInt(h, 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
// The human workspace now uses neutral defaults; deliberate named schemes stay colorful.
const defaultScheme = schemes.find((scheme) => scheme.id === 'default');
const defaultsStart = source.indexOf('const DEFAULT_BOARD_THEME_PALETTES =');
const defaultsEnd = source.indexOf('\nconst BOARD_THEME_STYLE_VAR_MAP', defaultsStart);
const defaults = JSON.parse(vm.runInNewContext(`${source.slice(defaultsStart, defaultsEnd)}; JSON.stringify(DEFAULT_BOARD_THEME_PALETTES)`, {}, { timeout: 1000 }));
for (const mode of ['light', 'dark']) {
  const palette = defaultScheme[mode];
  assert.deepEqual(palette, defaults[mode], `default ${mode} matches renderer fallback tokens`);
  for (const [token, value] of Object.entries(palette)) {
    const channels = token.startsWith('shadow') ? value.match(/[\d.]+/g).slice(0, 3).map(Number) : value.slice(1).match(/../g).map((channel) => parseInt(channel, 16));
    assert.equal(new Set(channels).size, 1, `default.${mode}.${token} must use neutral channels`);
  }
  for (const token of ['text', 'muted', 'accent']) for (const background of ['surface', 'boardBackground']) {
    assert(contrast(palette[token], palette[background]) >= 4.5, `default.${mode}: ${token} on ${background}`);
  }
  assert(contrast(palette.accentText, palette.accent) >= 4.5, `default.${mode}: button text`);
  assert.notEqual(schemes.find((scheme) => scheme.id === 'cozy-blush')[mode].accent, palette.accent, 'a chosen custom palette retains its own accent');
}
for (const scheme of added) for (const mode of ['light', 'dark']) {
  const palette = scheme[mode];
  assert.deepEqual(Object.keys(palette).sort(), keys);
  for (const [key, value] of Object.entries(palette)) {
    assert(key.startsWith('shadow') ? /^rgba\([\d.,\s]+\)$/.test(value) : /^#[0-9a-f]{6}$/i.test(value), `${scheme.id}.${mode}.${key}`);
  }
  for (const token of ['text', 'muted', 'accent']) for (const background of ['surface', 'boardBackground']) {
    assert(contrast(palette[token], palette[background]) >= 4.5, `${scheme.id}.${mode}: ${token} on ${background}`);
  }
  assert(contrast(palette.accentText, palette.accent) >= 4.5, `${scheme.id}.${mode}: button text`);
}
const expectedDefaults = {
  light: {
    boardBackground: '#fafafa', surface: '#ffffff', text: '#171717', muted: '#525252',
    border: '#d4d4d4', accent: '#262626', accentText: '#ffffff',
    shadow: 'rgba(0, 0, 0, .04)', shadowCard: 'rgba(0, 0, 0, .06)',
  },
  dark: {
    boardBackground: '#171717', surface: '#262626', text: '#f5f5f5', muted: '#a3a3a3',
    border: '#525252', accent: '#e5e5e5', accentText: '#171717',
    shadow: 'rgba(0, 0, 0, 0.45)', shadowCard: 'rgba(0, 0, 0, 0.55)',
  },
};
assert.deepEqual(defaults, expectedDefaults, 'defaults use the Tailwind v3.4 Neutral scale');

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testThemeApplication() {
  const styleProperties = new Map();
  let savedSettings = {};
  let editorTheme;
  let appearanceMode = 'light';
  const storage = new Map();
  const context = vm.createContext({
    console,
    document: {
      documentElement: {
        dataset: {},
        style: {
          setProperty: (name, value) => styleProperties.set(name, value),
          removeProperty: (name) => styleProperties.delete(name),
        },
      },
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {
      boardRoot: '/test/board/',
      board: {
        readBoardSettings: async () => savedSettings,
        updateBoardSettings: async () => { throw new Error('Applying a theme must not write board settings.'); },
      },
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    OverType: { setTheme: (theme) => { editorTheme = toPlain(theme); } },
    getAppAppearanceSettings: () => ({ mode: appearanceMode, themeSource: 'signboard' }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/columnColors.js'), 'utf8'), context);
  context.window.SignboardColumnColors = context.SignboardColumnColors;
  vm.runInContext(source, context);
  const themeSource = fs.readFileSync(path.join(__dirname, '../app/ui/theme.js'), 'utf8');
  vm.runInContext(themeSource, context);
  // Exercise the real asynchronous board-load/app-theme path; irrelevant settings
  // rendering is stubbed because these tests do not construct the settings UI.
  vm.runInContext(`
    renderBoardLabelFilterButton = () => {};
    renderBoardLabelFilterPopover = () => {};
    renderBoardThemeSettingsControls = () => {};
    renderBoardGeneralSettingsControls = () => {};
    renderBoardWorkflowSettingsControls = () => {};
    renderBoardExternalPublishedCalendarSettingsControls = () => {};
    renderAppSettingsControls = () => {};
    renderBoardImportControls = () => {};
  `, context);

  function assertAppliedDefaults(message) {
    const palettes = toPlain(context.getBoardThemePalettes());
    assert.deepEqual(palettes, expectedDefaults, message);
    for (const mode of ['light', 'dark']) {
      for (const [token, value] of Object.entries(expectedDefaults[mode])) {
        const cssName = { boardBackground: 'bg', surface: 'bg-card', accentText: 'accent-contrast', shadowCard: 'shadow-card' }[token] || token;
        assert.equal(styleProperties.get(`--sb-${mode}-${cssName}`), value, `${message}: applied ${mode}.${token}`);
      }
    }
    assert.equal(editorTheme.colors.link, expectedDefaults[appearanceMode].accent, `${message}: editor link`);
    assert.equal(editorTheme.colors.bgPrimary, expectedDefaults[appearanceMode].surface, `${message}: editor surface`);
  }

  const defaultSettings = [
    {},
    { colorScheme: 'default' },
    { colorScheme: 'unknown-scheme' },
    { themeOverrides: { light: { boardBackground: 'invalid' }, dark: {} } },
    { themeOverrides: { light: { boardBackground: '#f7f8fa' }, dark: { boardBackground: '#091102' } } },
    { themeOverrides: { light: { boardBackground: '#f7f7f7' }, dark: { boardBackground: '#191919' } } },
    { themeOverrides: { light: { boardBackground: '#fafafa' }, dark: { boardBackground: '#171717' } } },
  ];
  for (const settings of defaultSettings) {
    // Switching from a custom board must also clear its in-memory scheme identity.
    context.applyColorSchemeById('cozy-blush', { renderControls: false });
    savedSettings = settings;
    const beforeLoad = JSON.stringify(savedSettings);
    await context.ensureBoardLabelsLoaded();
    for (const mode of ['light', 'dark']) {
      appearanceMode = mode;
      await context.applyConfiguredAppTheme({ renderBoard: false });
      assertAppliedDefaults(JSON.stringify(settings));
    }
    assert.equal(JSON.stringify(savedSettings), beforeLoad, 'theme resolution leaves stored settings untouched');
    for (const mode of ['light', 'dark']) {
      assert.deepEqual(toPlain(context.getBoardThemePaletteFromSettings(settings, mode)), expectedDefaults[mode]);
      const sourcePill = toPlain(context.getBoardTemporalSourceTheme(settings))[mode];
      assert.equal(sourcePill.accent, expectedDefaults[mode].accent, 'default source pills use the neutral accent');
      for (const value of Object.values(sourcePill)) {
        const channels = value.slice(1).match(/../g).map((channel) => parseInt(channel, 16));
        assert.equal(new Set(channels).size, 1, 'default source pills stay monochrome');
      }
    }
  }

  appearanceMode = 'light';
  savedSettings = { colorScheme: 'cozy-blush' };
  await context.ensureBoardLabelsLoaded();
  await context.applyConfiguredAppTheme({ renderBoard: false });
  const customScheme = schemes.find((scheme) => scheme.id === 'cozy-blush');
  for (const mode of ['light', 'dark']) {
    assert.deepEqual(toPlain(context.getBoardThemePalettes())[mode], customScheme[mode], 'deliberate named scheme is preserved');
    assert.equal(context.getBoardTemporalSourceTheme(savedSettings)[mode].accent, customScheme[mode].accent);
  }
  assert.equal(editorTheme.colors.link, customScheme.light.accent, 'editor uses the chosen scheme');

  savedSettings = {
    colorScheme: 'unknown-scheme',
    themeOverrides: { light: { boardBackground: '#f5e7ff' }, dark: { boardBackground: '#241832' } },
  };
  await context.ensureBoardLabelsLoaded();
  await context.applyConfiguredAppTheme({ renderBoard: false });
  for (const mode of ['light', 'dark']) {
    const expectedCustom = toPlain(context.deriveThemePalette(mode, savedSettings.themeOverrides[mode].boardBackground));
    assert.deepEqual(toPlain(context.getBoardThemePalettes())[mode], expectedCustom, 'deliberate custom background keeps its derived palette');
    assert.deepEqual(toPlain(context.getBoardThemePaletteFromSettings(savedSettings, mode)), expectedCustom);
  }

  // Invalid in-memory scheme IDs also restore a custom override rather than
  // clearing it by treating the invalid ID as the default named scheme.
  context.setBoardColorScheme('unknown-scheme');
  context.restoreCurrentBoardThemeVariables();
  assert.equal(context.getBoardThemePalettes().light.boardBackground, '#f5e7ff');

  for (const mode of ['light', 'dark']) {
    const editorFallback = context.createOverTypeThemeFromPalette(mode === 'light' ? 'lite' : 'dark', null);
    assert.equal(editorFallback.colors.link, expectedDefaults[mode].accent);
    assert.equal(editorFallback.colors.bgPrimary, expectedDefaults[mode].surface);
    assert.equal(editorFallback.colors.text, expectedDefaults[mode].text);
  }
  const originalMix = context.mixHexColors;
  context.mixHexColors = () => 'invalid';
  assert.equal(context.buildOverTypeSelectionColor('lite', 'invalid', 'invalid'), 'rgba(38, 38, 38, 0.34)');
  assert.equal(context.buildOverTypeSelectionColor('dark', 'invalid', 'invalid'), 'rgba(229, 229, 229, 0.44)');
  context.mixHexColors = originalMix;
}

testThemeApplication().then(() => {
  console.log('Tailwind Neutral defaults pass board load, app restore, editor, source-pill, custom-theme, and palette contrast checks.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
