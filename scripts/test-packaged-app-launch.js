#!/usr/bin/env node

const { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const expectedBuild = require('../lib/buildInfo').getBuildInfo();
const timeoutMs = 45_000;

function readAppArgument(argv) {
  const appIndex = argv.indexOf('--app');
  if (appIndex < 0 || !argv[appIndex + 1]) {
    return '';
  }
  return path.resolve(repoRoot, argv[appIndex + 1]);
}

function resolveExecutable(appPath) {
  if (process.platform === 'darwin') {
    return path.join(appPath, 'Contents', 'MacOS', packageJson.productName || 'Signboard');
  }
  return appPath;
}

async function checkHeadlessEntrypoints(executablePath, tempRoot) {
  const resources = process.platform === 'darwin'
    ? path.resolve(path.dirname(executablePath), '../Resources')
    : path.join(path.dirname(executablePath), 'resources');
  const appArchive = path.join(resources, 'app.asar');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    SIGNBOARD_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
    SIGNBOARD_DESKTOP_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
    SIGNBOARD_CLI_CONFIG_DIR: path.join(tempRoot, 'cli'),
    SIGNBOARD_MCP_ALLOWED_ROOTS: tempRoot,
    SIGNBOARD_MCP_READ_ONLY: 'true',
  };
  const invoke = (entry, args = []) => execFileSync(executablePath,
    [path.join(appArchive, 'bin', entry), ...args], { env, encoding: 'utf8', timeout: timeoutMs });
  assert.match(invoke('signboard.js', ['--help']), /Signboard CLI/);
  assert(expectedBuild.buildId, 'A current shared build stamp is required before package validation.');
  assert.deepEqual(JSON.parse(invoke('signboard.js', ['--version', '--json'])), expectedBuild);
  const server = JSON.parse(invoke('signboard-mcp-config.js')).mcpServers.signboard;
  assert.equal(server.command, executablePath);
  assert.equal(server.args[0], path.join(appArchive, 'bin/signboard-mcp.js'));
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
  await new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let stderr = ''; let initialized = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged MCP initialization timed out.'));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!output.includes('\n') || initialized) return;
      try {
        const message = JSON.parse(output.slice(0, output.indexOf('\n')));
        assert.equal(message.id, 1);
        assert.equal(message.result?.serverInfo?.version, packageJson.version);
        initialized = true;
        child.stdin.end();
      } catch (error) { child.kill('SIGKILL'); clearTimeout(timer); reject(error); }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (initialized && code === 0) resolve();
      else reject(new Error(`Packaged MCP exited before clean initialization (${code}): ${stderr}`));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packaged-smoke', version: '1' } } }) + '\n');
  });
}

function createRendererFixture(tempRoot, userDataPath) {
  const boards = [
    { name: 'Packaged Alpha', list: '000-Inbox-stock', title: 'Packaged Alpha fixture card' },
    { name: 'Packaged Beta', list: '000-Review-stock', title: 'Packaged Beta fixture card' },
  ].map((board, index) => {
    const root = path.join(tempRoot, board.name);
    const cardPath = path.join(root, board.list, `000-fixture-${index}.md`);
    fs.mkdirSync(path.dirname(cardPath), { recursive: true });
    const content = `---\ntitle: ${board.title}\n---\nIsolated packaged startup fixture ${index}.\n`;
    fs.writeFileSync(cardPath, content, 'utf8');
    return { ...board, root, cardPath, content };
  });
  fs.writeFileSync(path.join(userDataPath, 'trusted-board-roots.json'), JSON.stringify(boards.map(board => board.root)));
  // Deliberately seed the portable desktop snapshot without Chromium localStorage.
  // This reproduces restoring a copied profile from a different file origin.
  fs.writeFileSync(path.join(userDataPath, 'open-boards.json'), JSON.stringify({
    openBoardRoots: boards.map(board => board.root), activeBoardRoot: boards[0].root,
  }));
  return { boards };
}

function assertRendererFixture(marker, fixture) {
  assert.equal(marker.rendererLoaded, true, 'Packaged preload bridges must load.');
  assert.equal(marker.rendererInitialized, true, 'Packaged renderer must finish initialization and restore the fixture board.');
  assert.equal(marker.fixtureBoardVisible, true, 'Restored fixture board/card must be visible.');
  assert.equal(marker.overviewLoaded, true, 'Overview must open through its initialized UI control.');
  assert.equal(marker.restoredBoardRoot, fixture.boards[0].root);
  assert.deepEqual(marker.overviewCardTitles.slice().sort(), fixture.boards.map(board => board.title).sort());
  assert.equal(marker.overviewProjects, fixture.boards.length);
  assert.equal(marker.overviewCards, fixture.boards.length);
}

async function run() {
  const appPath = readAppArgument(process.argv.slice(2));
  if (!appPath) {
    throw new Error('Pass the packaged application path with --app <path>.');
  }

  const executablePath = resolveExecutable(appPath);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Packaged application executable not found: ${executablePath}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signboard-packaged-smoke-'));
  const userDataPath = path.join(tempRoot, 'user-data');
  const markerPath = path.join(userDataPath, 'packaged-smoke-test.json');
  fs.mkdirSync(userDataPath, { recursive: true });
  const fixture = createRendererFixture(tempRoot, userDataPath);

  let stdout = '';
  let stderr = '';
  let child;

  try {
    await checkHeadlessEntrypoints(executablePath, tempRoot);
    const result = await new Promise((resolve, reject) => {
      child = spawn(executablePath, ['--packaged-smoke-test'], {
        env: {
          ...process.env,
          SIGNBOARD_USER_DATA_DIR: userDataPath,
          SIGNBOARD_PACKAGED_SMOKE_FIXTURE: JSON.stringify(fixture),
          SIGNBOARD_TEST_DISABLE_FAVICON_FETCH: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));

      setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill('SIGKILL');
          reject(new Error(`Packaged application did not finish its smoke test within ${timeoutMs}ms.`));
        }
      }, timeoutMs).unref();
    });

    if (result.code !== 0) {
      throw new Error(
        `Packaged application exited with code ${result.code ?? '<none>'}`
        + `${result.signal ? ` (${result.signal})` : ''}.`
      );
    }

    if (!fs.existsSync(markerPath)) {
      throw new Error('Packaged application did not write its renderer-ready smoke-test marker.');
    }

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.version !== packageJson.version) {
      throw new Error(`Packaged version mismatch. Expected ${packageJson.version}, found ${marker.version || '<missing>'}.`);
    }
    if (marker.isPackaged !== true) {
      throw new Error(`Packaged renderer did not report ready: ${JSON.stringify(marker)}`);
    }
    assertRendererFixture(marker, fixture);
    for (const board of fixture.boards) {
      assert.equal(fs.readFileSync(board.cardPath, 'utf8'), board.content, 'Startup/Overview must not rewrite fixture cards.');
    }
    assert.deepEqual(marker.buildInfo, expectedBuild, 'Packaged desktop must match the shared build identity.');

    console.log(`Packaged desktop, CLI, and MCP launch tests passed for Signboard ${marker.version}.`);
  } catch (error) {
    if (stdout.trim()) {
      console.error(`Packaged app stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      console.error(`Packaged app stderr:\n${stderr.trim()}`);
    }
    throw error;
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch((error) => {
  console.error(`Packaged application launch test failed: ${error.message}`);
  process.exit(1);
});

module.exports = { createRendererFixture, assertRendererFixture };
