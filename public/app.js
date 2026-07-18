(() => {
  'use strict';

  const store = {
    activeProjectId: null,
    defaultProjectId: null,
    drawerProjectId: null,
    hydrated: new Set(),
    pendingAnswers: new Map(),
    projects: new Map(),
    readyProjectIds: new Set(),
    strengths: {},
    v2: false,
  };
  const projectState = window.OsmosisProjectState;
  let toastTimer = null;

  const cardArea = document.querySelector('#card-area');
  const treeList = document.querySelector('#tree-list');
  const treeEmpty = document.querySelector('#tree-empty');
  const toast = document.querySelector('#toast');
  const connection = document.querySelector('#connection');
  const modeFooter = document.querySelector('#mode-footer');
  const projectTabs = document.querySelector('#project-tabs');
  const archivedTabs = document.querySelector('#archived-tabs');
  const archivedGroup = document.querySelector('#archived-projects');
  const activityDrawer = document.querySelector('#activity-drawer');
  const activityTitle = document.querySelector('#activity-title');
  const activityList = document.querySelector('#activity-list');

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function emptyProject(projectId) {
    return {
      activities: [],
      cards: [],
      focusedCardId: null,
      hydrated: false,
      project_id: projectId,
      summary: {
        archived: false,
        last_activity_at: null,
        name: 'Project',
        project_id: projectId,
        unanswered_count: 0,
      },
      tree: { meta: {}, nodes: [] },
    };
  }

  function projectFor(projectId) {
    if (!store.projects.has(projectId)) {
      store.projects.set(projectId, emptyProject(projectId));
    }
    return store.projects.get(projectId);
  }

  function activeProject() {
    return store.activeProjectId ? projectFor(store.activeProjectId) : null;
  }

  function updateSummary(summary) {
    if (!summary || typeof summary.project_id !== 'string') {
      return;
    }
    const project = projectFor(summary.project_id);
    project.summary = { ...project.summary, ...summary };
  }

  function replaceSummaries(summaries) {
    for (const summary of Array.isArray(summaries) ? summaries : []) {
      updateSummary(summary);
    }
  }

  function cardById(project, cardId) {
    return project.cards.find((card) => card.card_id === cardId);
  }

  function currentCard(project) {
    const focused = project.focusedCardId && cardById(project, project.focusedCardId);
    if (focused) {
      return focused;
    }
    return project.cards.find((card) => !card.state?.answered) || project.cards.at(-1);
  }

  function nextUnansweredCard(project, excludingCardId) {
    return project.cards.find((card) => !card.state?.answered && card.card_id !== excludingCardId);
  }

  function sourceKind(card) {
    if (card.source?.kind === 'observed-change') return 'observed-change';
    if (card.source?.kind === 'observed-activity' || card.source?.kind === 'observed') return 'observed-activity';
    return 'agent';
  }

  function sourceText(card) {
    if (sourceKind(card) === 'observed-change') return 'Osmosis observed a local Codex change.';
    if (sourceKind(card) === 'observed-activity') return 'Osmosis observed local Codex activity.';
    return card.source?.what_i_did || 'Your agent reported a milestone.';
  }

  function sourceLabel(card) {
    if (sourceKind(card) === 'observed-change') return 'Observed change';
    if (sourceKind(card) === 'observed-activity') return 'Observed activity';
    return 'Reported by agent';
  }

  function sourceLead(card) {
    if (sourceKind(card) === 'observed-change') return 'From a local Codex change:';
    if (sourceKind(card) === 'observed-activity') return 'From local Codex activity:';
    return 'From what your AI just did:';
  }

  function cardSummary(card) {
    const answered = Boolean(card.state?.answered);
    const label = answered ? (card.state.correct ? 'Mastered' : 'Review queued') : 'Waiting';
    const className = answered ? (card.state.correct ? 'mastered' : 'review') : 'waiting';
    const content = `
      <span class="summary-state ${className}">${label}</span>
      <span class="summary-copy">
        <strong>${escapeHtml(card.concept_name)}</strong>
        <span class="summary-source">
          <span class="provenance-label provenance-label--${sourceKind(card)}">${sourceLabel(card)}</span>
          <span class="summary-source-text">${escapeHtml(sourceText(card))}</span>
        </span>
      </span>`;
    return !answered
      ? `<div class="card-summary card-summary--waiting">${content}</div>`
      : `<button class="card-summary" type="button" data-focus-card="${escapeHtml(card.card_id)}">${content}</button>`;
  }

  function renderCards() {
    const project = activeProject();
    if (!project) {
      cardArea.innerHTML = '';
      return;
    }
    const card = currentCard(project);
    if (!card) {
      cardArea.innerHTML = `
        <div class="empty-card">
          <p>Waiting for your first learning signal…</p>
          <span>Osmosis turns a local change or agent report into one focused lesson.</span>
        </div>`;
      return;
    }

    const pending = store.pendingAnswers.get(project.project_id);
    const answered = Boolean(card.state?.answered);
    const selectedIndex = answered ? card.state.chosen_index : pending?.cardId === card.card_id ? pending.index : null;
    const feedback = answered
      ? `<section class="answer-feedback ${card.state.correct ? 'correct' : 'incorrect'}" aria-live="polite">
          <p class="result-label">${card.state.correct ? 'Correct' : 'Not quite'}</p>
          <p>${escapeHtml(card.explanation || '')}</p>
        </section>`
      : '';
    const nextCard = answered ? nextUnansweredCard(project, card.card_id) : null;
    const waiting = project.cards.filter((item) => !item.state?.answered && item.card_id !== card.card_id).length;
    const history = project.cards.filter((item) => item.card_id !== card.card_id).reverse();

    cardArea.innerHTML = `
      <section class="card-feed" aria-label="Lesson card feed">
        <article class="lesson-card">
          <div class="card-topline">
            <p class="card-concept">${escapeHtml(card.concept_name)}</p>
            ${waiting > 0 ? `<p class="queue-badge">${waiting} more waiting</p>` : ''}
          </div>
          <p class="source-line source-line--${sourceKind(card)}">
            <span class="provenance-label provenance-label--${sourceKind(card)}">${sourceLabel(card)}</span>
            <span>${sourceLead(card)} “${escapeHtml(sourceText(card))}”</span>
          </p>
          <p class="lesson-copy">${escapeHtml(card.lesson)}</p>
          <h3>${escapeHtml(card.question)}</h3>
          <div class="answers" aria-label="Answer choices">
            ${card.options.map((option, index) => {
              const selected = selectedIndex === index;
              const answerClass = selected
                ? answered
                  ? card.state.correct ? ' selected correct' : ' selected incorrect'
                  : ' pressed'
                : '';
              const disabled = answered || Boolean(pending);
              return `<button type="button" class="answer-option${answerClass}" data-answer-card="${escapeHtml(card.card_id)}" data-answer-index="${index}" aria-pressed="${selected}" ${disabled ? 'disabled' : ''}>${escapeHtml(option)}</button>`;
            }).join('')}
          </div>
          ${feedback}
          ${nextCard ? '<button class="next-lesson" type="button" data-next-lesson>Continue to next lesson</button>' : ''}
        </article>
        ${history.length ? `<div class="card-history" aria-label="Earlier lessons">${history.map(cardSummary).join('')}</div>` : ''}
      </section>`;

    for (const button of cardArea.querySelectorAll('[data-answer-card]')) {
      button.addEventListener('click', () => void submitAnswer(project.project_id, button.dataset.answerCard, Number(button.dataset.answerIndex)));
    }
    cardArea.querySelector('[data-next-lesson]')?.addEventListener('click', () => {
      project.focusedCardId = nextUnansweredCard(project, card.card_id)?.card_id || null;
      renderCards();
    });
    for (const summary of cardArea.querySelectorAll('[data-focus-card]')) {
      summary.addEventListener('click', () => {
        project.focusedCardId = summary.dataset.focusCard;
        renderCards();
      });
    }
  }

  function strengthFor(conceptId) {
    const direct = Number(store.strengths?.[conceptId]?.strength || 0);
    if (direct) return direct;
    const local = typeof conceptId === 'string' && conceptId.includes(':') ? conceptId.split(':').at(-1) : '';
    return Number(store.strengths?.[local]?.strength || 0);
  }

  function isCarriedOver(project, node, strength) {
    const projectCreatedAt = Date.parse(project.tree.meta?.created_at || '');
    const direct = store.strengths?.[node.concept_id] || (node.concept_id.includes(':') ? store.strengths?.[node.concept_id.split(':').at(-1)] : null);
    const masteredAt = Date.parse(direct?.updated_at || '');
    return strength >= 2 && Number.isFinite(projectCreatedAt) && Number.isFinite(masteredAt) && masteredAt < projectCreatedAt;
  }

  function treeNodeMarkup(project, node, childrenByParent, visited) {
    if (visited.has(node.concept_id)) return '';
    visited.add(node.concept_id);
    const children = childrenByParent.get(node.concept_id) || [];
    const strength = strengthFor(node.concept_id);
    const branch = children.length > 0;
    const carriedOver = !branch && isCarriedOver(project, node, strength);
    const visualState = carriedOver ? 'carried' : strength >= 2 ? 'mastered' : strength >= 1 ? 'learning' : branch ? 'branch' : 'dim';
    const childMarkup = children.map((child) => treeNodeMarkup(project, child, childrenByParent, visited)).join('');
    return `
      <li class="tree-node tree-node--${visualState}${branch ? ' tree-node--branch' : ''}">
        <div class="tree-node-content">
          <span class="tree-node-dot" aria-hidden="true"></span>
          <span class="tree-node-name">${escapeHtml(node.concept_name)}</span>
          ${carriedOver ? '<span class="carried-over-label">carried over</span>' : ''}
        </div>
        ${childMarkup ? `<ol class="tree-children">${childMarkup}</ol>` : ''}
      </li>`;
  }

  function renderTree() {
    const project = activeProject();
    const nodes = Array.isArray(project?.tree?.nodes) ? project.tree.nodes : [];
    treeEmpty.hidden = nodes.length > 0;
    if (!nodes.length) {
      treeEmpty.textContent = stateProvider() === 'none'
        ? 'Your project tree appears when live concept generation is enabled.'
        : 'Waiting for your first live concept report.';
      treeList.innerHTML = '';
      return;
    }
    const nodesById = new Map(nodes.map((node) => [node.concept_id, node]));
    const childrenByParent = new Map();
    const roots = [];
    for (const node of nodes) {
      if (node.parent_id && nodesById.has(node.parent_id) && node.parent_id !== node.concept_id) {
        const children = childrenByParent.get(node.parent_id) || [];
        children.push(node);
        childrenByParent.set(node.parent_id, children);
      } else {
        roots.push(node);
      }
    }
    const visited = new Set();
    let markup = roots.map((node) => treeNodeMarkup(project, node, childrenByParent, visited)).join('');
    markup += nodes.filter((node) => !visited.has(node.concept_id)).map((node) => treeNodeMarkup(project, node, childrenByParent, visited)).join('');
    treeList.innerHTML = markup;
  }

  function summaryTab(project) {
    const summary = project.summary;
    const active = summary.project_id === store.activeProjectId;
    const ready = store.readyProjectIds.has(summary.project_id);
    const waiting = Number(summary.unanswered_count || 0);
    return `<div class="project-tab-wrap">
      <button class="project-tab${active ? ' is-active' : ''}" type="button" role="tab" aria-selected="${active}" data-project-tab="${escapeHtml(summary.project_id)}">
        <span class="project-tab-name">${escapeHtml(summary.name)}</span>
        ${ready ? '<span class="ready-dot" aria-label="New activity"></span>' : ''}
        ${waiting ? `<span class="project-count">${waiting}</span>` : ''}
      </button>
      <button class="project-icon-button" type="button" data-project-activity="${escapeHtml(summary.project_id)}" aria-label="Show activity for ${escapeHtml(summary.name)}">⌁</button>
      ${summary.archived
        ? `<button class="project-icon-button project-icon-button--restore" type="button" data-project-restore="${escapeHtml(summary.project_id)}" aria-label="Restore ${escapeHtml(summary.name)}">↗</button>`
        : `<button class="project-icon-button project-icon-button--archive" type="button" data-project-archive="${escapeHtml(summary.project_id)}" aria-label="Archive ${escapeHtml(summary.name)}">×</button>`}
    </div>`;
  }

  function bindTabActions(container) {
    for (const button of container.querySelectorAll('[data-project-tab]')) {
      button.addEventListener('click', () => selectProject(button.dataset.projectTab));
    }
    for (const button of container.querySelectorAll('[data-project-activity]')) {
      button.addEventListener('click', () => void openActivity(button.dataset.projectActivity));
    }
    for (const button of container.querySelectorAll('[data-project-archive]')) {
      button.addEventListener('click', () => void archiveProject(button.dataset.projectArchive));
    }
    for (const button of container.querySelectorAll('[data-project-restore]')) {
      button.addEventListener('click', () => void restoreProject(button.dataset.projectRestore));
    }
  }

  function renderTabs() {
    const projects = [...store.projects.values()].sort((left, right) => {
      const leftTime = Date.parse(left.summary.last_activity_at || '') || 0;
      const rightTime = Date.parse(right.summary.last_activity_at || '') || 0;
      return rightTime - leftTime || left.summary.name.localeCompare(right.summary.name);
    });
    const active = projects.filter((project) => !project.summary.archived || project.summary.project_id === store.activeProjectId);
    const archived = projects.filter((project) => project.summary.archived && project.summary.project_id !== store.activeProjectId);
    projectTabs.innerHTML = active.map(summaryTab).join('');
    archivedTabs.innerHTML = archived.map(summaryTab).join('');
    archivedGroup.hidden = archived.length === 0;
    bindTabActions(projectTabs);
    bindTabActions(archivedTabs);
  }

  function render() {
    renderTabs();
    renderCards();
    renderTree();
    renderActivity();
  }

  function showToast(message) {
    if (toastTimer) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3_000);
  }

  let provider = 'none';
  function stateProvider() { return provider; }

  function updateConnectionStatus(status) {
    if (status.provider === 'codex' && status.state === 'generating') {
      connection.textContent = 'Generating (this provider is slower).';
      connection.classList.add('live');
      return;
    }
    if (status.state === 'pacing') {
      connection.textContent = 'Spacing lessons…';
      connection.classList.add('live');
      return;
    }
    if (status.state === 'failed') {
      connection.textContent = 'Waiting for next signal';
      connection.classList.remove('live');
      return;
    }
    if (['idle', 'skipped', 'queue-full', 'replay-complete'].includes(status.state)) {
      connection.textContent = 'Live';
      connection.classList.add('live');
    }
  }

  function markActivity(projectId, { ready = true } = {}) {
    const project = projectState?.applyBackgroundActivity
      ? projectState.applyBackgroundActivity(store, projectId, projectFor)
      : projectFor(projectId);
    if (!projectState?.applyBackgroundActivity) {
      project.summary.archived = false;
      project.summary.last_activity_at = new Date().toISOString();
      if (projectId !== store.activeProjectId) store.readyProjectIds.add(projectId);
    }
    if (!ready) store.readyProjectIds.delete(projectId);
  }

  function applySnapshot(projectId, snapshot) {
    const project = projectFor(projectId);
    project.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    project.tree = snapshot.tree || { meta: {}, nodes: [] };
    if (snapshot.strengths && typeof snapshot.strengths === 'object') store.strengths = snapshot.strengths;
    if (snapshot.project) updateSummary(snapshot.project);
    project.hydrated = true;
    store.hydrated.add(projectId);
    if (project.focusedCardId && !cardById(project, project.focusedCardId)) project.focusedCardId = null;
  }

  function applyProjectEvent(type, payload) {
    const projectId = payload?.project_id;
    if (typeof projectId !== 'string') return;
    const project = projectFor(projectId);
    markActivity(projectId);
    if (type === 'card') {
      project.cards = project.cards.filter((card) => card.card_id !== payload.card_id);
      project.cards.push(payload);
      // A project event is intentionally partial. A background channel may
      // already have older cards/tree data that this browser has never seen,
      // so only a full snapshot is allowed to mark it hydrated. Clicking its
      // tab will then fetch the complete channel rather than displaying a
      // misleading one-card fragment.
      project.summary.unanswered_count = project.cards.filter((card) => !card.state?.answered).length;
    } else if (type === 'tree') {
      project.tree = { meta: payload.meta || {}, nodes: Array.isArray(payload.nodes) ? payload.nodes : [] };
    } else if (type === 'strength') {
      const entry = store.strengths[payload.concept_id] || {};
      store.strengths[payload.concept_id] = { ...entry, strength: payload.strength };
    } else if (type === 'snapshot') {
      applySnapshot(projectId, payload);
    } else if (type === 'status') {
      project.activities.push({ ...payload, state: payload.state || 'observed', ts: new Date().toISOString() });
      project.activities = project.activities.slice(-100);
      if (payload.report?.what_i_did && projectId === store.activeProjectId) {
        const observed = payload.report.source === 'observed' || ['observed', 'observed-change', 'observed-activity'].includes(payload.report.source?.kind);
        showToast(observed ? (payload.report.observed_kind === 'change' ? 'Osmosis observed a local change.' : 'Osmosis observed local activity.') : `Codex reported: “${payload.report.what_i_did}”`);
      }
      if (projectId === store.activeProjectId) updateConnectionStatus(payload);
    }
    if (projectId === store.activeProjectId) {
      renderCards();
      renderTree();
      renderActivity();
    }
    renderTabs();
  }

  async function selectProject(projectId) {
    if (typeof projectId !== 'string') return;
    // This function is invoked only by the initial local preference and an
    // explicit user tab click. SSE/background hydration never switches tabs.
    if (projectState?.selectProjectFromUser) projectState.selectProjectFromUser(store, projectId);
    else {
      store.activeProjectId = projectId;
      store.readyProjectIds.delete(projectId);
    }
    try { localStorage.setItem('osmosis.active-project', projectId); } catch {}
    render();
    const project = projectFor(projectId);
    if (project.hydrated) return;
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/snapshot`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Snapshot unavailable');
      const snapshot = await response.json();
      applySnapshot(projectId, snapshot);
      // A late fetch may update its own cache but can never change the active
      // tab selected by the user in the meantime.
      if (store.activeProjectId === projectId) render();
      else renderTabs();
    } catch {
      if (store.activeProjectId === projectId) showToast('Osmosis could not load that project yet.');
    }
  }

  async function submitAnswer(projectId, cardId, index) {
    const project = projectFor(projectId);
    const card = cardById(project, cardId);
    if (!card || card.state?.answered || store.pendingAnswers.has(projectId)) return;
    store.pendingAnswers.set(projectId, { cardId, index });
    project.focusedCardId = cardId;
    renderCards();
    try {
      const response = await fetch(`/answer?project=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, chosen_index: index }),
      });
      if (!response.ok) throw new Error('Answer rejected');
      const result = await response.json();
      card.state = { answered: true, chosen_index: index, correct: result.correct };
      card.explanation = result.explanation;
      store.strengths[card.concept_id] = { ...(store.strengths[card.concept_id] || {}), name: card.concept_name, strength: result.strength };
      project.summary.unanswered_count = Math.max(0, Number(project.summary.unanswered_count || 0) - 1);
      store.pendingAnswers.delete(projectId);
      render();
    } catch {
      store.pendingAnswers.delete(projectId);
      renderCards();
      showToast('Osmosis could not save that answer. Please try again.');
    }
  }

  function activityState(entry) {
    const state = entry.state || 'observed';
    return ['observed', 'waiting', 'suppressed', 'skipped', 'failed', 'delivered'].includes(state) ? state : 'observed';
  }

  function renderActivity() {
    if (!store.drawerProjectId) {
      activityDrawer.hidden = true;
      return;
    }
    const project = projectFor(store.drawerProjectId);
    activityDrawer.hidden = false;
    activityTitle.textContent = `${project.summary.name} · activity`;
    const entries = project.activities.slice(-100).reverse();
    activityList.innerHTML = entries.length
      ? entries.map((entry) => `<li class="activity-entry"><span class="activity-state activity-state--${activityState(entry)}">${escapeHtml(activityState(entry))}</span><span>${escapeHtml(entry.message || entry.reason || entry.event || 'Project activity')}</span></li>`).join('')
      : '<li class="activity-empty">No durable activity yet. Reports and generator outcomes will appear here.</li>';
  }

  async function openActivity(projectId) {
    const project = projectFor(projectId);
    store.drawerProjectId = projectId;
    renderActivity();
    try {
      const response = await fetch(`/ledger?project=${encodeURIComponent(projectId)}&limit=100`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Ledger unavailable');
      const body = await response.json();
      project.activities = Array.isArray(body.entries) ? body.entries : project.activities;
      renderActivity();
    } catch {
      project.activities.push({ event: 'drawer', message: 'Activity history is temporarily unavailable.', state: 'failed', ts: new Date().toISOString() });
      renderActivity();
    }
  }

  async function archiveProject(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST' });
      if (!response.ok) throw new Error('Archive rejected');
      const body = await response.json();
      updateSummary(body.project);
      renderTabs();
    } catch {
      showToast('Osmosis could not archive that project.');
    }
  }

  async function restoreProject(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/unarchive`, { method: 'POST' });
      if (!response.ok) throw new Error('Restore rejected');
      const body = await response.json();
      updateSummary(body.project);
      renderTabs();
    } catch {
      showToast('Osmosis could not restore that project.');
    }
  }

  document.querySelector('#activity-close')?.addEventListener('click', () => {
    store.drawerProjectId = null;
    renderActivity();
  });

  const events = new EventSource('/events');
  events.addEventListener('open', () => {
    connection.textContent = 'Live';
    connection.classList.add('live');
  });
  events.addEventListener('error', () => {
    connection.textContent = 'Reconnecting…';
    connection.classList.remove('live');
  });
  events.addEventListener('snapshot', (event) => {
    if (store.v2) return;
    const snapshot = JSON.parse(event.data);
    const projectId = store.defaultProjectId || 'default';
    applySnapshot(projectId, snapshot);
    if (!store.activeProjectId) store.activeProjectId = projectId;
    render();
  });
  events.addEventListener('snapshot-v2', (event) => {
    const payload = JSON.parse(event.data);
    store.v2 = true;
    store.defaultProjectId = payload.default_project_id;
    // The server deliberately emits a legacy snapshot immediately before the
    // v2 one for one compatibility release. Before its id is known, that
    // legacy payload temporarily lives in a "default" placeholder channel.
    // Remove only that synthetic channel when the real default arrives; never
    // let a transport handoff create a second user-visible project tab.
    if (payload.default_project_id && payload.default_project_id !== 'default') {
      store.projects.delete('default');
      store.hydrated.delete('default');
      store.pendingAnswers.delete('default');
    }
    store.strengths = payload.strengths || store.strengths;
    replaceSummaries(payload.projects);
    const channels = payload.channels || (payload.channel ? { [payload.channel.project_id]: payload.channel } : {});
    for (const [projectId, snapshot] of Object.entries(channels)) applySnapshot(projectId, snapshot);
    let preferred = null;
    try { preferred = localStorage.getItem('osmosis.active-project'); } catch {}
    const initial = preferred && store.projects.has(preferred) ? preferred : payload.active_project_id || payload.default_project_id;
    if (!store.activeProjectId || store.activeProjectId === 'default') store.activeProjectId = initial;
    render();
    if (store.activeProjectId && !projectFor(store.activeProjectId).hydrated) void selectProject(store.activeProjectId);
  });
  events.addEventListener('projects', (event) => {
    const payload = JSON.parse(event.data);
    replaceSummaries(payload.projects);
    renderTabs();
  });
  for (const type of ['card', 'tree', 'strength', 'snapshot', 'status']) {
    events.addEventListener(`project-${type}`, (event) => applyProjectEvent(type, JSON.parse(event.data)));
  }
  // Legacy default-channel events remain useful if a cached browser script
  // reconnects before the v2 snapshot, but v2 listeners own the live wall.
  for (const type of ['card', 'tree', 'strength', 'status']) {
    events.addEventListener(type, (event) => {
      if (store.v2) return;
      const payload = JSON.parse(event.data);
      const projectId = store.defaultProjectId || 'default';
      applyProjectEvent(type, { ...payload, project_id: projectId });
    });
  }

  fetch('/health')
    .then((response) => response.json())
    .then((info) => {
      provider = info.provider || 'none';
      modeFooter.textContent = `${info.mode} · ${info.provider}`;
      if (info.default_project_id && !store.defaultProjectId) store.defaultProjectId = info.default_project_id;
      replaceSummaries(info.projects);
      renderTabs();
    })
    .catch(() => {});
})();
