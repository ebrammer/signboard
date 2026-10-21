// Overview keeps every source list and card in its existing workflow. Dates and
// completed-list rules never decide whether work appears here.
function getOverviewState() {
  if (!window.__overviewState) {
    window.__overviewState = {
      isOpen: false, initialized: false, query: '', projects: [],
      requestId: 0, lastRefreshAt: 0, refreshPromise: null, signature: '',
    };
  }
  return window.__overviewState;
}

function isOverviewOpen() {
  return getOverviewState().isOpen;
}

function buildOverviewProject(boardRoot, snapshot) {
  const boardDisplayName = snapshot.boardName || getBoardLabelFromPath(boardRoot);
  const lists = snapshot.lists.filter((list) => list.listName !== 'XXX-Archive').map((list) => ({
    listName: list.listName,
    listDisplayName: getBoardListDisplayName(list.listName),
    cards: list.cards.flatMap((record) => {
      const card = getBoardSnapshotCardData(record);
      // Partial snapshots already carry read errors; never invent an empty card.
      if (!card) return [];
      const frontmatter = card.frontmatter || {};
      return [{
        boardRoot, boardDisplayName, listName: list.listName,
        listDisplayName: getBoardListDisplayName(list.listName),
        cardPath: getBoardSnapshotCardPath(list.listPath, record),
        title: String(frontmatter.title || '').trim() || 'Untitled',
        body: String(card.body || ''), start: String(frontmatter.start || ''),
        due: String(frontmatter.due || ''),
      }];
    }),
  }));
  return {
    boardRoot, boardDisplayName, lists,
    error: snapshot.ok === false || Boolean(snapshot.errors && snapshot.errors.length),
    cardCount: lists.reduce((count, list) => count + list.cards.length, 0),
  };
}

function overviewCardMatchesQuery(card, query) {
  const haystack = [card.boardDisplayName, card.listDisplayName, card.title, card.body].join('\n').toLocaleLowerCase();
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    .every((token) => haystack.includes(token));
}

function filterOverviewProjects(projects, query) {
  const searching = Boolean(String(query || '').trim());
  return projects.map((project) => {
    const lists = project.lists.map((list) => ({
      ...list, cards: list.cards.filter((card) => overviewCardMatchesQuery(card, query)),
    })).filter((list) => !searching || list.cards.length > 0);
    return { ...project, lists, visibleCount: lists.reduce((count, list) => count + list.cards.length, 0) };
  }).filter((project) => !searching || project.visibleCount > 0 || project.error);
}

async function readOverviewProject(boardRoot) {
  try {
    const snapshot = await readBoardSnapshotForRender(boardRoot, {
      includeBoardSettings: false, includeTimestamps: false, includeTaskItems: false,
    });
    // The compatibility snapshot fallback returns filenames. Resolve those only;
    // current desktop snapshots already include all card data in one IPC read.
    await Promise.all(snapshot.lists.map(async (list) => {
      list.cards = await Promise.all(list.cards.map(async (record) => {
        if (getBoardSnapshotCardData(record)) return record;
        const cardPath = getBoardSnapshotCardPath(list.listPath, record);
        try { return { cardPath, ...await window.board.readCard(cardPath) }; }
        catch (error) { snapshot.errors.push({ cardPath }); return null; }
      }));
      list.cards = list.cards.filter(Boolean);
    }));
    return buildOverviewProject(boardRoot, snapshot);
  } catch (error) {
    return { boardRoot, boardDisplayName: getBoardLabelFromPath(boardRoot), lists: [], cardCount: 0, error: true };
  }
}

function createOverviewText(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function renderOverviewProjects() {
  if (!isOverviewOpen()) return;
  const state = getOverviewState();
  const body = document.getElementById('overviewBody');
  const count = document.getElementById('overviewCount');
  if (!body) return;
  const projects = filterOverviewProjects(state.projects, state.query);
  const total = state.projects.reduce((sum, project) => sum + project.cardCount, 0);
  const visible = projects.reduce((sum, project) => sum + project.visibleCount, 0);
  if (count) count.textContent = `${state.projects.length} project${state.projects.length === 1 ? '' : 's'} · ${state.query.trim() ? `${visible} of ${total}` : total} cards`;
  const signature = JSON.stringify([state.query, state.projects]);
  if (signature === state.signature) return;
  state.signature = signature;
  const scrollTop = body.scrollTop;
  const focusedPath = body.contains(document.activeElement) ? document.activeElement.dataset.path : '';
  const content = document.createDocumentFragment();
  if (state.projects.length === 0) {
    content.appendChild(createOverviewText('p', 'overview-empty', 'No open projects. Open a board to see its work here.'));
  } else if (projects.length === 0) {
    content.appendChild(createOverviewText('p', 'overview-empty', 'No cards match your search.'));
  }
  for (const project of projects) {
    const section = document.createElement('section');
    section.className = 'overview-project';
    section.dataset.boardRoot = project.boardRoot;
    const heading = createOverviewText('h3', 'overview-project-title', project.boardDisplayName);
    const projectCount = createOverviewText('span', 'overview-project-count', `${project.visibleCount} card${project.visibleCount === 1 ? '' : 's'}`);
    heading.appendChild(projectCount);
    section.appendChild(heading);
    if (project.error) {
      const warning = createOverviewText('p', 'overview-source-warning', 'Some project files could not be read. Check folder access. Overview will retry automatically.');
      warning.setAttribute('role', 'status');
      section.appendChild(warning);
    }
    if (project.lists.length === 0 && !project.error) {
      section.appendChild(createOverviewText('p', 'overview-empty-list', state.query.trim() ? 'No cards match your search.' : 'This project has no lists.'));
    }
    const listsContainer = document.createElement('div');
    listsContainer.className = 'overview-lists';
    section.appendChild(listsContainer);
    for (const list of project.lists) {
      const listSection = document.createElement('section');
      listSection.className = 'overview-list';
      listSection.appendChild(createOverviewText('h4', 'overview-list-title', `${list.listDisplayName} · ${list.cards.length}`));
      const cards = document.createElement('div');
      cards.className = 'overview-cards';
      if (list.cards.length === 0) cards.appendChild(createOverviewText('p', 'overview-empty-list', 'No cards in this list.'));
      for (const card of list.cards) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'overview-card';
        button.dataset.path = card.cardPath;
        button.setAttribute('aria-label', `${card.title}, ${card.boardDisplayName}, ${card.listDisplayName}`);
        button.appendChild(createOverviewText('span', 'overview-card-title', card.title));
        const preview = card.body.replace(/\s+/g, ' ').trim();
        if (preview) button.appendChild(createOverviewText('span', 'overview-card-preview', preview.slice(0, 180)));
        const dates = [card.start && `Start ${card.start}`, card.due && `Due ${card.due}`].filter(Boolean).join(' · ');
        if (dates) button.appendChild(createOverviewText('span', 'overview-card-dates', dates));
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPlannerCard(card).catch((error) => {
            console.error('Failed to open Overview card.', error);
            if (!isModalOpen('modalEditCard')) {
              announceSignboardStatus('This card could not be opened. Check folder access and try again.');
            }
          });
        });
        cards.appendChild(button);
      }
      listSection.appendChild(cards);
      listsContainer.appendChild(listSection);
    }
    content.appendChild(section);
  }
  body.replaceChildren(content);
  body.scrollTop = scrollTop;
  if (focusedPath) {
    const target = Array.from(body.querySelectorAll('.overview-card')).find((card) => card.dataset.path === focusedPath);
    if (target) target.focus({ preventScroll: true });
  }
}

async function renderOverviewView() {
  const state = getOverviewState();
  if (!state.isOpen) return;
  if (state.refreshPromise) return state.refreshPromise;
  const requestId = ++state.requestId;
  state.lastRefreshAt = Date.now();
  state.refreshPromise = (async () => {
    const projects = await Promise.all(getStoredOpenBoards().map(readOverviewProject));
    if (!state.isOpen || requestId !== state.requestId) return;
    state.projects = projects;
    renderOverviewProjects();
  })().finally(() => { state.refreshPromise = null; });
  return state.refreshPromise;
}

// The existing watcher owns one active board. Poll batched snapshots only while
// Overview is visible so changes in every other open project also appear.
async function refreshOverviewIfDue() {
  const state = getOverviewState();
  if (!state.isOpen || Date.now() - state.lastRefreshAt < 2500) return;
  await renderOverviewView();
}

function syncOverviewBoardTheme() {
  const overlay = document.getElementById('overviewOverlay');
  const planner = document.getElementById('plannerOverlay');
  if (!overlay || !planner) return;
  for (const property of Object.values(PLANNER_CARD_THEME_PROPERTIES)) {
    const value = planner.style.getPropertyValue(property);
    if (value) overlay.style.setProperty(property, value);
    else overlay.style.removeProperty(property);
  }
}

async function openOverviewView() {
  await closeAllModals({ key: 'Escape' }, { skipRerender: true });
  if (typeof closePlannerView === 'function' && isPlannerOpen()) closePlannerView({ restoreFocus: false });
  const state = getOverviewState();
  state.isOpen = true;
  state.signature = '';
  const overlay = document.getElementById('overviewOverlay');
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('overview-open');
  syncOverviewBoardTheme();
  syncWorkspaceViewDockState();
  await renderOverviewView();
  document.getElementById('overviewSearchInput').focus();
  return true;
}

function closeOverviewView(options = {}) {
  const state = getOverviewState();
  state.isOpen = false;
  state.requestId += 1;
  const overlay = document.getElementById('overviewOverlay');
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('overview-open');
  syncWorkspaceViewDockState();
  if (options.restoreFocus !== false) document.getElementById('workspaceViewOverview').focus();
}

function initializeOverviewControls() {
  const state = getOverviewState();
  if (state.initialized) return;
  const input = document.getElementById('overviewSearchInput');
  input.addEventListener('input', () => {
    state.query = input.value;
    renderOverviewProjects();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const first = document.querySelector('#overviewBody .overview-card');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  document.getElementById('overviewCloseButton').addEventListener('click', () => closeOverviewView());
  state.initialized = true;
}
