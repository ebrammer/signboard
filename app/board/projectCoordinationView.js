function renderOverviewRequest(card) {
  const request = card.coordination;
  const section = document.createElement('section'); section.className = 'overview-request';
  section.appendChild(createOverviewText('p', 'overview-request-context', `${card.boardDisplayName} · ${card.listDisplayName} · ${request.attention}`));
  const source = overviewButton(card.title, 'overview-request-title', (event) => { event.preventDefault(); event.stopPropagation(); openOverviewSourceCard(card); });
  source.dataset.path = card.cardPath; source.dataset.focusKey = `request-source:${card.cardPath}`; section.appendChild(source);
  section.appendChild(createOverviewText('p', 'overview-request-ask', request.request || 'No request details provided. Open the source card for context.'));
  if (request.summary) section.appendChild(createOverviewText('p', 'overview-request-summary', request.summary));
  section.appendChild(createOverviewText('p', 'overview-next-step', `Next · ${request.nextStep || 'No next step provided'}`));
  section.appendChild(createOverviewText('p', 'overview-request-evidence', `Evidence · ${request.evidence || 'No evidence provided'}`));
  const updatedAt = request.updatedAt || card.updatedAt;
  section.appendChild(createOverviewText('p', 'overview-request-updated', updatedAt ? `Updated ${new Date(updatedAt).toLocaleString()}` : 'Update time unavailable'));
  const actions = document.createElement('div'); actions.className = 'overview-form-actions';
  const reply = overviewButton('Reply', 'overview-reply', () => openOverviewCoordinationEditor({ card, reply: true })); reply.dataset.focusKey = `reply:${card.cardPath}`; actions.appendChild(reply);
  const edit = overviewButton('Edit request', 'overview-coordinate', () => openOverviewCoordinationEditor({ card })); edit.dataset.focusKey = `request-edit:${card.cardPath}`; actions.appendChild(edit);
  section.appendChild(actions); return section;
}
function overviewCoordinationResult(result) {
  if (result && result.ok === false) { const error = new Error(result.error || 'Unable to save.'); error.code = result.details && result.details.code; error.details = result.details; throw error; }
  return result;
}
function overviewEditorField(form, name, label, value, maxLength, options) {
  const wrapper = document.createElement('label'); wrapper.className = 'overview-editor-field';
  wrapper.appendChild(createOverviewText('span', '', label));
  const input = document.createElement(options ? 'select' : 'textarea'); input.name = name; input.setAttribute('aria-label', label);
  if (options) for (const [key, text] of options) { const option = document.createElement('option'); option.value = key; option.textContent = text; input.appendChild(option); }
  else { input.maxLength = maxLength; input.rows = name === 'response' ? 5 : 2; }
  input.value = value || ''; wrapper.appendChild(input); form.appendChild(wrapper); return input;
}
async function openOverviewCoordinationEditor({ project, card, reply = false }) {
  const state = getOverviewState();
  // One editor owns its own snapshot and revision; background snapshots never rebase drafts.
  if (state.editing) return;
  const editor = { project, card, reply, expectedRevision: null, loaded: false };
  state.editing = editor;
  const panel = document.getElementById('overviewCoordinationPanel'); panel.classList.remove('hidden');
  document.getElementById('overviewBody').inert = true;
  const form = document.createElement('form'); form.className = 'overview-coordination-form';
  form.appendChild(createOverviewText('h3', '', project ? `${project.boardDisplayName} summary` : `${reply ? 'Reply to' : 'Coordinate'} ${card.title}`));
  const status = createOverviewText('p', 'overview-editor-status', 'Loading latest…'); status.setAttribute('role', 'status'); form.appendChild(status);
  const fields = document.createElement('div'); form.appendChild(fields);
  const actions = document.createElement('div'); actions.className = 'overview-form-actions';
  const save = overviewButton(reply ? 'Send reply' : 'Save', 'overview-save', () => {}); save.type = 'submit'; save.disabled = true;
  const cancel = overviewButton('Close', 'overview-cancel', () => closeOverviewCoordinationEditor());
  actions.append(save, cancel); form.appendChild(actions); panel.replaceChildren(form);
  setAccessibleModalVisible(panel, true);
  form.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOverviewCoordinationEditor(); } });
  let controls = {};
  const readLatest = async () => project ? window.board.readProjectBrief(project.boardRoot) : window.board.readCard(card.cardPath);
  try {
    const latest = await readLatest(); if (state.editing !== editor) return;
    editor.expectedRevision = latest.revision; editor.loaded = true;
    const values = project ? latest : SignboardProjectCoordination.normalizeCardCoordination(latest.frontmatter);
    if (project) {
      controls.goal = overviewEditorField(fields, 'goal', 'Goal', values.goal, 500);
      controls.nextStep = overviewEditorField(fields, 'nextStep', 'Next step', values.nextStep, 500);
    } else if (reply) {
      fields.appendChild(createOverviewText('p', 'overview-request-ask', values.request || 'This request has no details.'));
      fields.appendChild(createOverviewText('p', 'overview-request-evidence', `Evidence · ${values.evidence || 'No evidence provided'}`));
      if (!values.attention || values.attention === 'none') { status.textContent = 'This card no longer needs a reply. Close to refresh.'; return; }
      controls.response = overviewEditorField(fields, 'response', 'Your reply', '', 4000); controls.response.required = true;
      fields.appendChild(createOverviewText('p', 'overview-editor-hint', 'Sending clears this request and keeps the card in its current list.'));
    } else {
      controls.workStatus = overviewEditorField(fields, 'workStatus', 'Work status', SignboardProjectCoordination.WORK_STATUSES.includes(latest.frontmatter.sb_work_status) ? values.workStatus : '', null,
        [...(!SignboardProjectCoordination.WORK_STATUSES.includes(latest.frontmatter.sb_work_status) ? [['', 'Not reported']] : []), ['idle', 'Idle'], ['working', 'Working'], ['blocked', 'Blocked']]);
      controls.attention = overviewEditorField(fields, 'attention', 'Needs you', values.attention || 'none', null,
        [['none', 'No request'], ['decision', 'Decision'], ['question', 'Question'], ['review', 'Review']]);
      controls.request = overviewEditorField(fields, 'request', 'Request / ask', values.request, 2000);
      controls.nextStep = overviewEditorField(fields, 'nextStep', 'Next step', values.nextStep, 500);
      controls.evidence = overviewEditorField(fields, 'evidence', 'Evidence', values.evidence, 2000);
      controls.summary = overviewEditorField(fields, 'summary', 'Summary', values.summary, 2000);
      if (values.response) fields.appendChild(createOverviewText('p', 'overview-saved-response', `Last reply · ${values.response}`));
      controls.attention.addEventListener('change', () => { controls.request.required = controls.attention.value !== 'none'; });
      controls.request.required = controls.attention.value !== 'none';
    }
    status.textContent = ''; save.disabled = false; Object.values(controls)[0]?.focus();
  } catch (error) { status.textContent = `Could not load: ${error.message}`; }
  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || !editor.loaded || save.disabled) return;
    busy = true; save.disabled = true; status.textContent = 'Saving…';
    const patch = Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]));
    // An absent status is retained as absence. Explicit statuses remain editable.
    if (patch.workStatus === '') delete patch.workStatus;
    try {
      if (project) overviewCoordinationResult(await window.board.updateProjectBrief(project.boardRoot, patch, editor.expectedRevision));
      else if (reply) overviewCoordinationResult(await window.board.respondToCardRequest(card.cardPath, patch.response, editor.expectedRevision));
      else overviewCoordinationResult(await window.board.updateCardCoordination(card.cardPath, patch, editor.expectedRevision));
      if (state.editing !== editor) return;
      closeOverviewCoordinationEditor(); await renderOverviewView();
      announceSignboardStatus(reply ? 'Reply saved. Request cleared.' : 'Coordination saved.');
    } catch (error) {
      status.textContent = error.code === 'REVISION_CONFLICT' ? 'This file changed while you were editing. Your draft is kept. Load the latest context before saving again.' : `Could not save: ${error.message}. Your draft is kept.`;
      if (error.code === 'REVISION_CONFLICT' && !form.querySelector('.overview-load-latest')) {
        const reload = overviewButton('Load latest context', 'overview-load-latest', async () => {
          reload.disabled = true;
          try {
            const latest = await readLatest();
            const values = project ? latest : SignboardProjectCoordination.normalizeCardCoordination(latest.frontmatter);
            let context = form.querySelector('.overview-latest-context');
            if (!context) { context = createOverviewText('p', 'overview-latest-context', ''); fields.appendChild(context); }
            context.textContent = project ? `Latest goal: ${values.goal || '(unset)'}\nLatest next step: ${values.nextStep || '(unset)'}` :
              `Latest request: ${values.request || '(unset)'}\nNext: ${values.nextStep || '(unset)'}\nEvidence: ${values.evidence || '(unset)'}\nStatus: ${values.workStatus || '(unset)'}\nSummary: ${values.summary || '(unset)'}\nReply: ${values.response || '(none)'}`;
            editor.expectedRevision = latest.revision;
            if (reply && (!values.attention || values.attention === 'none')) { status.textContent = 'The request was cleared. Your draft is kept; close to refresh.'; save.disabled = true; }
            else { status.textContent = 'Latest context loaded below. Your draft is kept; review it before saving.'; save.disabled = false; }
          } catch (loadError) { status.textContent = `Could not load latest context: ${loadError.message}. Your draft is kept.`; }
          reload.disabled = false;
        }); actions.appendChild(reload);
      }
      if (error.code !== 'REVISION_CONFLICT') save.disabled = false;
    } finally { busy = false; }
  });
}
function closeOverviewCoordinationEditor() {
  const state = getOverviewState(); state.editing = null; state.signature = '';
  setAccessibleModalVisible(document.getElementById('overviewCoordinationPanel'), false, { restoreFocus: false });
  document.getElementById('overviewBody').inert = false;
  renderOverviewProjects(); document.getElementById('overviewSearchInput').focus();
}
