// Now's grid and detail are projections of source cards, never a second work model.
function syncOverviewNavigation(requestCount) {
  const state = getOverviewState();
  for (const [id, tab] of [['overviewNowTab', 'now'], ['overviewProjectsTab', 'projects'], ['overviewNeedsYouTab', 'needs-you']]) {
    const button = document.getElementById(id);
    button.setAttribute('aria-selected', String(state.tab === tab)); button.tabIndex = state.tab === tab ? 0 : -1;
  }
  const badge = document.getElementById('overviewRequestCount'); badge.textContent = requestCount || ''; badge.hidden = !requestCount;
  document.getElementById('overviewNeedsYouTab').setAttribute('aria-label', `Needs you${requestCount ? `, ${requestCount} requests` : ''}`);
  document.getElementById('overviewTitle').textContent = state.tab === 'now' ? 'Now' : state.tab === 'projects' ? 'Projects' : 'Needs you';
  document.getElementById('overviewSubtitle').textContent = state.tab === 'now' ? 'Keep the big picture close.' : state.tab === 'projects' ? 'Your open projects, in workspace order.' : 'Questions, decisions, and work ready for your review.';
  document.getElementById('overviewBody').setAttribute('aria-labelledby', state.tab === 'now' ? 'overviewNowTab' : state.tab === 'projects' ? 'overviewProjectsTab' : 'overviewNeedsYouTab');
  for (const button of document.querySelectorAll('[data-overview-workspace]')) button.disabled = !window.boardRoot;
}
function selectOverviewTab(tab) {
  const state = getOverviewState(); state.tab = tab; state.selectedProject = ''; renderOverviewProjects();
  document.getElementById(tab === 'now' ? 'overviewNowTab' : tab === 'projects' ? 'overviewProjectsTab' : 'overviewNeedsYouTab').focus({ preventScroll: true });
}
function overviewCurrentCard(project) {
  return project.active[0] || project.blocked[0] || project.lists.flatMap((list) => list.cards).find((card) => !card.isCompletedList && card.coordination.summary) || null;
}
function overviewLatestUpdate(project) {
  const timestamps = [project.brief.updatedAt, ...project.lists.flatMap((list) => list.cards.flatMap((card) => [card.updatedAt, card.coordination.updatedAt]))];
  const latest = timestamps.map((value) => Date.parse(value)).filter(Number.isFinite);
  return latest.length ? new Date(Math.max(...latest)).toISOString() : '';
}
function overviewUpdateLabel(timestamp) {
  if (!timestamp) return 'Update time unavailable';
  const age = Math.max(0, Date.now() - Date.parse(timestamp)), minutes = Math.floor(age / 60000);
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `Updated ${days}d ago` : `Updated ${new Date(timestamp).toLocaleDateString()}`;
}
function overviewTimestamp(project) {
  const timestamp = overviewLatestUpdate(project);
  const time = createOverviewText('time', 'overview-updated', overviewUpdateLabel(timestamp));
  if (timestamp) { time.dateTime = timestamp; time.title = new Date(timestamp).toLocaleString(); }
  return time;
}
function renderOverviewProjectTile(project) {
  const section = document.createElement('section'); section.className = 'overview-project'; section.dataset.boardRoot = project.boardRoot;
  const button = overviewButton('', 'overview-project-title', () => openOverviewProjectDetail(project.boardRoot));
  button.dataset.overviewProject = project.boardRoot; button.dataset.focusKey = `project:${project.boardRoot}`;
  button.setAttribute('aria-label', `Open ${project.boardDisplayName} project`); button.setAttribute('aria-controls', 'overviewProjectDetail');
  button.setAttribute('aria-expanded', String(getOverviewState().selectedProject === project.boardRoot));
  const top = document.createElement('span'); top.className = 'overview-project-top';
  const icon = createOverviewText('span', 'overview-project-icon', ''); icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = window.feather.icons.folder.toSvg({ width: 24, height: 24 }); top.appendChild(icon);
  const signals = document.createElement('span'); signals.className = 'overview-project-signals';
  if (project.requests.length) signals.appendChild(createOverviewText('span', 'overview-signal overview-signal-attention', `${project.requests.length} needs you`));
  if (project.blocked.length) signals.appendChild(createOverviewText('span', 'overview-signal', `${project.blocked.length} blocked`));
  if (!project.requests.length && !project.blocked.length && project.active.length) signals.appendChild(createOverviewText('span', 'overview-signal overview-signal-working', project.active.some((card) => card.hasWorkStatus) ? 'Working' : `${project.active[0].listDisplayName} list`));
  top.appendChild(signals); button.appendChild(top);
  button.appendChild(createOverviewText('span', 'overview-project-name', project.boardDisplayName));
  if (project.brief.goal) button.appendChild(createOverviewText('span', 'overview-goal', project.brief.goal));
  const current = overviewCurrentCard(project), work = document.createElement('span'); work.className = 'overview-current';
  work.append(createOverviewText('span', 'overview-eyebrow', 'Current'), createOverviewText('span', 'overview-current-text', current ? `${current.coordination.summary || current.title}${!current.hasWorkStatus && project.active.includes(current) ? ` (${current.listDisplayName} list)` : ''}` : 'No current work reported.'));
  button.appendChild(work);
  const footer = document.createElement('span'); footer.className = 'overview-project-footer';
  const nextStep = project.brief.nextStep || current?.coordination.nextStep;
  footer.append(createOverviewText('span', 'overview-next-step', nextStep ? `Next: ${nextStep}` : 'Open project'), overviewTimestamp(getOverviewState().projects.find((item) => item.boardRoot === project.boardRoot) || project));
  button.appendChild(footer); section.appendChild(button);
  if (project.error || project.briefError) section.appendChild(createOverviewText('p', 'overview-source-warning', 'Some project files could not be read. Open project for details.'));
  return section;
}
function renderOverviewNeedsPreview(requests, container) {
  const matching = requests.filter((card) => overviewCardMatchesQuery(card, getOverviewState().query));
  if (!matching.length) return;
  const section = document.createElement('section'); section.className = 'overview-needs-preview'; section.setAttribute('aria-label', 'Needs you');
  const header = document.createElement('div'); header.className = 'overview-section-heading';
  const all = overviewButton('View all', 'overview-view-all', () => selectOverviewTab('needs-you')); all.dataset.focusKey = 'view-all-requests'; all.id = 'overviewViewAllRequests';
  header.append(createOverviewText('h3', '', `Needs you · ${matching.length}`), all); section.appendChild(header);
  const items = document.createElement('div'); items.className = 'overview-preview-requests';
  for (const card of matching.slice(0, 2)) {
    const item = document.createElement('section'); item.className = 'overview-request overview-request-preview';
    const context = document.createElement('div'); context.className = 'overview-request-preview-context';
    context.append(createOverviewText('h4', '', card.boardDisplayName), createOverviewText('span', 'overview-signal overview-signal-attention', card.coordination.attention));
    item.append(context, createOverviewText('p', 'overview-request-preview-ask', card.coordination.request || card.title));
    const action = overviewButton('Review request', 'overview-review-request', () => openOverviewCoordinationEditor({ card, reply: true }));
    action.dataset.focusKey = `preview-reply:${card.cardPath}`; item.appendChild(action); items.appendChild(item);
  }
  section.appendChild(items); container.appendChild(section);
}
function renderOverviewRequestQueue(projects, requests, container) {
  const state = getOverviewState(), matching = requests.filter((card) => overviewCardMatchesQuery(card, state.query));
  for (const project of projects.filter((item) => item.error || item.briefError)) container.appendChild(createOverviewText('p', 'overview-source-warning', `${project.boardDisplayName}: Some project files could not be read. Requests may be incomplete.`));
  if (!matching.length) container.appendChild(createOverviewText('p', 'overview-empty', state.query.trim() ? 'No requests match your search.' : 'Nothing needs your attention. Agents can ask a question, request a decision, or send work for review.'));
  for (const card of matching) container.appendChild(renderOverviewRequest(card));
}
function openOverviewProjectDetail(boardRoot) {
  const state = getOverviewState(); state.selectedProject = boardRoot; renderOverviewProjects();
  document.getElementById('overviewDetailBody').scrollTop = 0; document.getElementById('overviewDetailBack').focus({ preventScroll: true });
}
function closeOverviewProjectDetail() {
  const state = getOverviewState(), root = state.selectedProject; state.selectedProject = ''; renderOverviewProjects();
  const target = Array.from(document.querySelectorAll('[data-overview-project]')).find((button) => button.dataset.overviewProject === root) || document.getElementById('overviewSearchInput');
  target.focus({ preventScroll: true });
}
function renderOverviewProjectDetail(projects) {
  const state = getOverviewState(), panel = document.getElementById('overviewProjectDetail'), body = document.getElementById('overviewDetailBody');
  const original = state.projects.find((project) => project.boardRoot === state.selectedProject);
  const project = projects.find((item) => item.boardRoot === state.selectedProject);
  panel.classList.toggle('hidden', !original); document.getElementById('overviewOverlay').classList.toggle('has-project-detail', Boolean(original));
  if (!original) { state.selectedProject = ''; body.replaceChildren(); return; }
  const content = document.createDocumentFragment();
  const title = createOverviewText('h3', 'overview-detail-title', original.boardDisplayName); title.id = 'overviewDetailTitle'; content.appendChild(title);
  if (original.brief.goal) content.appendChild(createOverviewText('p', 'overview-goal', original.brief.goal));
  const current = overviewCurrentCard(original), nextStep = original.brief.nextStep || current?.coordination.nextStep;
  if (current) {
    content.appendChild(createOverviewText('h4', 'overview-detail-section-title', 'Current'));
    content.appendChild(createOverviewText('p', 'overview-detail-current', `${current.coordination.summary || current.title}${!current.hasWorkStatus && original.active.includes(current) ? ` (${current.listDisplayName} list)` : ''}`));
  }
  if (nextStep) content.appendChild(createOverviewText('p', 'overview-next-step', `Next · ${nextStep}`));
  content.appendChild(overviewTimestamp(original));
  const edit = overviewButton('Edit summary', 'overview-edit-summary', () => openOverviewCoordinationEditor({ project: original })); edit.dataset.focusKey = `summary:${original.boardRoot}`; content.appendChild(edit);
  if (original.error || original.briefError) {
    const warning = createOverviewText('p', 'overview-source-warning', `Some project files could not be read. ${original.briefError ? `Project summary: ${original.briefError}` : 'Check folder access. Now will retry automatically.'}`); warning.setAttribute('role', 'status'); content.appendChild(warning);
  }
  if (original.requests.length) {
    content.appendChild(createOverviewText('h4', 'overview-detail-section-title', 'Needs you'));
    for (const card of original.requests.filter((card) => overviewCardMatchesQuery(card, state.query))) content.appendChild(renderOverviewRequest(card));
  }
  content.appendChild(createOverviewText('h4', 'overview-detail-section-title', state.query.trim() ? 'Matching source cards' : 'Source cards'));
  if (!project) content.appendChild(createOverviewText('p', 'overview-empty', 'No cards in this project match your search.'));
  else renderOverviewLists(project, content);
  body.replaceChildren(content);
}
