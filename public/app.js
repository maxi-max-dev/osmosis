(() => {
  'use strict';

  const projectState = window.OsmosisProjectState;
  const studioState = window.OsmosisStudioState;

  const store = {
    activationProjectId: null,
    activeProjectId: null,
    activations: new Map(),
    auto: new Map(),
    defaultProjectId: null,
    drawerProjectId: null,
    pendingAnswers: new Map(),
    projects: new Map(),
    readyProjectIds: new Set(),
    settings: { global_learning: 'on', lesson_locale: 'en', projects: {} },
    strengths: {},
    studioView: 'now',
  };

  let provider = 'none';
  let toastTimer = null;
  const seenStartupNotices = new Set();

  const cardStage = document.querySelector('#studio-stage');
  const trail = document.querySelector('#learning-trail');
  const trailNote = document.querySelector('#trail-note');
  const toast = document.querySelector('#toast');
  const connection = document.querySelector('#connection');
  const modeFooter = document.querySelector('#mode-footer');
  const projectTabs = document.querySelector('#project-tabs');
  const archivedTabs = document.querySelector('#archived-tabs');
  const archivedGroup = document.querySelector('#archived-projects');
  const activationInbox = document.querySelector('#activation-inbox');
  const studioNav = document.querySelector('#studio-nav');
  const activityDrawer = document.querySelector('#activity-drawer');
  const activityTitle = document.querySelector('#activity-title');
  const activityList = document.querySelector('#activity-list');
  const settingsDialog = document.querySelector('#settings-dialog');
  const settingsContent = document.querySelector('#settings-content');

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function emptyStudio() {
    return {
      current: null,
      next_ready: false,
      waiting: { reason: 'idle', source_provenance: null },
    };
  }

  function emptyProject(projectId) {
    return {
      activities: [],
      cards: [],
      hydrated: false,
      project_id: projectId,
      reviewLoaded: false,
      studio: emptyStudio(),
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

  function activationFor(projectId = store.activeProjectId || store.defaultProjectId) {
    return projectId ? store.activations.get(projectId) || null : null;
  }

  function pendingActivations() {
    return [...store.activations.values()]
      .filter((activation) => activation?.state === 'activation-pending')
      .sort((left, right) => (left.name || '').localeCompare(right.name || '') || left.project_id.localeCompare(right.project_id));
  }

  function activationTargetId() {
    const focused = activationFor(store.activationProjectId);
    if (focused?.state === 'activation-pending') return focused.project_id;
    // On an empty first visit, the startup project should naturally present
    // its activation card. Once a learner has a current tab, new project
    // decisions stay in the inbox until they explicitly open them.
    if (activeProject()) return null;
    const defaultActivation = activationFor(store.defaultProjectId);
    if (defaultActivation?.state === 'activation-pending') return defaultActivation.project_id;
    return pendingActivations()[0]?.project_id || null;
  }

  function focusedActivation() {
    return activationFor(activationTargetId());
  }

  function sourceKind(source) {
    if (source?.kind === 'observed-change') return 'observed-change';
    if (source?.kind === 'observed-activity' || source?.kind === 'observed') return 'observed-activity';
    return 'agent';
  }

  function sourceLabel(source) {
    if (sourceKind(source) === 'observed-change') return 'Observed change';
    if (sourceKind(source) === 'observed-activity') return 'Observed activity';
    return 'Reported by agent';
  }

  function sourceText(source) {
    if (source?.what_i_did) return source.what_i_did;
    if (sourceKind(source) === 'observed-change') return 'Osmosis observed a local Codex change.';
    if (sourceKind(source) === 'observed-activity') return 'Osmosis observed local Codex activity.';
    return 'Your agent reported a milestone.';
  }

  function sourceMarkup(source, { compact = false } = {}) {
    const kind = sourceKind(source);
    return `<span class="provenance-label provenance-label--${kind}">${escapeHtml(sourceLabel(source))}</span>${compact ? '' : `<span class="source-copy">${escapeHtml(sourceText(source))}</span>`}`;
  }

  function updateSummary(summary) {
    if (!summary || typeof summary.project_id !== 'string') return;
    const project = projectFor(summary.project_id);
    project.summary = { ...project.summary, ...summary };
  }

  function replaceSummaries(summaries) {
    for (const summary of Array.isArray(summaries) ? summaries : []) updateSummary(summary);
  }

  function applyActivations(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const activation of values) {
      if (activation && typeof activation.project_id === 'string') {
        store.activations.set(activation.project_id, activation);
      }
    }
  }

  function cardById(project, cardId) {
    return project.cards.find((card) => card?.card_id === cardId) || null;
  }

  function normalizeStudio(snapshot, cards, previous = null) {
    const raw = snapshot?.studio;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Transitional owners may still send an old pointer-only snapshot.
      // Resolve that exact pointer, never a convenient-looking unanswered card:
      // a hidden Next must not replace the answered lesson in the learner's
      // hands while a snapshot is being reconciled.
      const currentId = typeof raw.current_card_id === 'string' ? raw.current_card_id : null;
      const pointerCurrent = currentId ? cards.find((card) => card?.card_id === currentId) || null : null;
      const withPointer = !Object.hasOwn(raw, 'current') && pointerCurrent ? { ...raw, current: pointerCurrent } : raw;
      const normalized = studioState?.normalizeStudioContract
        ? studioState.normalizeStudioContract(withPointer, previous)
        : { ...emptyStudio(), ...withPointer, next_ready: withPointer.next_ready === true || withPointer.next?.ready === true };
      return { ...emptyStudio(), ...normalized };
    }
    // This fallback is only for a pre-Studio legacy snapshot with no Studio
    // payload at all. Once a Studio contract exists, current is never guessed.
    const current = cards.find((card) => !card.state?.answered) || null;
    return { ...emptyStudio(), current };
  }

  function applySnapshot(projectId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const project = projectFor(projectId);
    project.cards = Array.isArray(snapshot.cards) ? snapshot.cards : project.cards;
    project.tree = snapshot.tree || project.tree;
    project.studio = normalizeStudio(snapshot, project.cards, project.studio);
    project.cards = studioState?.mergeStudioCurrent
      ? studioState.mergeStudioCurrent(project.cards, project.studio.current)
      : project.studio.current
        ? [...project.cards.filter((card) => card?.card_id !== project.studio.current.card_id), project.studio.current]
        : project.cards;
    if (snapshot.strengths && typeof snapshot.strengths === 'object') store.strengths = snapshot.strengths;
    if (snapshot.project) updateSummary(snapshot.project);
    project.hydrated = true;
  }

  function applyStudio(projectId, studio) {
    if (!studio || typeof studio !== 'object') return;
    const project = projectFor(projectId);
    project.studio = normalizeStudio({ studio }, project.cards, project.studio);
    project.cards = studioState?.mergeStudioCurrent
      ? studioState.mergeStudioCurrent(project.cards, project.studio.current)
      : project.studio.current
        ? [...project.cards.filter((card) => card?.card_id !== project.studio.current.card_id), project.studio.current]
        : project.cards;
  }

  function statusForActive() {
    const project = activeProject();
    const studio = project?.studio;
    if (store.settings.global_learning === 'paused') return 'Paused';
    if (['preparing', 'queued'].includes(studio?.waiting?.reason)) return provider === 'codex' ? 'Generating · slower' : 'Preparing';
    if (studio?.next_ready) return 'Next is ready';
    return 'Listening';
  }

  function renderConnection() {
    connection.textContent = statusForActive();
    connection.classList.toggle('live', store.settings.global_learning !== 'paused');
    connection.classList.toggle('paused', store.settings.global_learning === 'paused');
    modeFooter.textContent = `${store.settings.global_learning === 'paused' ? 'paused' : 'live'} · ${provider}`;
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

  function strengthFor(conceptId) {
    const direct = Number(store.strengths?.[conceptId]?.strength || 0);
    if (direct) return direct;
    const local = typeof conceptId === 'string' && conceptId.includes(':') ? conceptId.split(':').at(-1) : '';
    return Number(store.strengths?.[local]?.strength || 0);
  }

  function trailItem(card, active) {
    const strength = strengthFor(card.concept_id);
    const answered = Boolean(card.state?.answered);
    const state = active ? 'now' : answered && strength >= 2 ? 'mastered' : answered ? 'review' : 'waiting';
    const caption = active ? 'Now' : answered && strength >= 2 ? 'Learned' : answered ? 'Revisit later' : 'Waiting';
    return `<li class="trail-item trail-item--${state}">
      <span class="trail-dot" aria-hidden="true"></span>
      <div><strong>${escapeHtml(card.concept_name || 'A useful concept')}</strong><span>${escapeHtml(caption)}</span></div>
    </li>`;
  }

  function renderTrail() {
    const project = activeProject();
    if (!project) {
      trail.innerHTML = '<li class="trail-empty">Choose a project to begin a small, living trail.</li>';
      trailNote.textContent = 'Osmosis only keeps learning state for projects you choose to carry.';
      return;
    }
    const current = project.studio?.current;
    const cards = [...project.cards];
    if (current && !cards.some((card) => card.card_id === current.card_id)) cards.push(current);
    cards.sort((left, right) => Date.parse(left.created_at || '') - Date.parse(right.created_at || ''));
    trail.innerHTML = cards.length
      ? cards.slice(-10).map((card) => trailItem(card, card.card_id === current?.card_id)).join('')
      : '<li class="trail-empty">Your trail will begin with the first useful signal from this project.</li>';
    const next = project.studio?.next_ready;
    trailNote.textContent = next
      ? 'One follow-up lesson is ready whenever you are.'
      : 'The route changes with your work; there is no fake curriculum to catch up on.';
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
      button.addEventListener('click', () => void selectProject(button.dataset.projectTab, 'now', { writeHash: true }));
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
    const open = projects.filter((project) => !project.summary.archived || project.summary.project_id === store.activeProjectId);
    const archived = projects.filter((project) => project.summary.archived && project.summary.project_id !== store.activeProjectId);
    projectTabs.innerHTML = open.map(summaryTab).join('');
    archivedTabs.innerHTML = archived.map(summaryTab).join('');
    archivedGroup.hidden = archived.length === 0;
    bindTabActions(projectTabs);
    bindTabActions(archivedTabs);
  }

  function renderActivationInbox() {
    const pending = pendingActivations();
    activationInbox.hidden = pending.length === 0;
    if (pending.length === 0) {
      activationInbox.innerHTML = '';
      return;
    }
    activationInbox.innerHTML = `<div class="activation-inbox-copy"><p class="eyebrow">New project${pending.length === 1 ? '' : 's'}</p><p>${pending.length === 1 ? 'Osmosis is waiting for one project choice.' : `${pending.length} projects are waiting for your choice.`}</p></div>
      <div class="activation-inbox-actions">${pending.map((activation) => `<button class="activation-inbox-button${activation.project_id === activationTargetId() ? ' is-focused' : ''}" type="button" data-activation-open="${escapeHtml(activation.project_id)}"><span>${escapeHtml(activation.name || 'project')}</span>${activation.pending_report_count ? `<small>${activation.pending_report_count} held report${activation.pending_report_count === 1 ? '' : 's'}</small>` : '<small>Choose setup</small>'}</button>`).join('')}</div>`;
    for (const button of activationInbox.querySelectorAll('[data-activation-open]')) {
      button.addEventListener('click', () => {
        store.activationProjectId = button.dataset.activationOpen;
        render();
      });
    }
  }

  function waitingMarkup(waiting) {
    const source = waiting?.source_provenance;
    const provenance = source
      ? `<p class="waiting-source">${sourceMarkup(source)}</p>`
      : '';
    const preparing = waiting?.reason === 'preparing';
    const queued = waiting?.reason === 'queued';
    const message = preparing
      ? 'Preparing a lesson from the latest useful signal.'
      : queued
        ? 'A useful signal is waiting for room in your next lesson.'
        : 'Keep working — Osmosis will prepare the next lesson when it sees a useful signal.';
    return `<article class="waiting-card">
      <span class="waiting-orb" aria-hidden="true"></span>
      <p class="eyebrow">${preparing ? 'Preparing next' : queued ? 'Next signal queued' : 'Listening for useful work'}</p>
      <h3>${escapeHtml(message)}</h3>
      ${provenance}
    </article>`;
  }

  function nextControl(project, current) {
    if (!current?.state?.answered) return '';
    const studio = project.studio || emptyStudio();
    const controlState = studioState?.nextControlState?.(studio)
      || (studio.next_ready ? 'ready' : ['preparing', 'queued'].includes(studio.waiting?.reason) ? 'preparing' : 'idle');
    if (controlState === 'ready') {
      return '<button class="next-lesson" type="button" data-next-lesson>Next lesson <span aria-hidden="true">→</span></button>';
    }
    const waiting = studio.waiting;
    const hasWork = controlState === 'preparing';
    const source = waiting?.source_provenance;
    return `<div class="next-waiting">
      <button class="next-lesson next-lesson--muted" type="button" disabled>${hasWork ? 'Preparing next…' : 'Nothing relevant yet'}</button>
      ${hasWork && source ? `<p>${sourceMarkup(source, { compact: true })}<span>${escapeHtml(sourceText(source))}</span></p>` : ''}
    </div>`;
  }

  function renderNow(project) {
    const activation = activationFor(project.project_id);
    if (store.settings.global_learning === 'paused') {
      return `<article class="waiting-card waiting-card--paused"><p class="eyebrow">Learning paused</p><h3>Osmosis is not capturing or making new lessons right now.</h3><p>Your trail and past lessons are still here whenever you want them.</p></article>`;
    }
    const card = project.studio?.current;
    if (!card) return waitingMarkup(project.studio?.waiting);
    const pending = store.pendingAnswers.get(project.project_id);
    const answered = Boolean(card.state?.answered);
    const selectedIndex = answered ? card.state.chosen_index : pending?.cardId === card.card_id ? pending.index : null;
    const feedback = answered
      ? `<section class="answer-feedback ${card.state.correct ? 'correct' : 'incorrect'}" aria-live="polite">
          <p class="result-label">${card.state.correct ? 'That’s it.' : 'A small correction.'}</p>
          <p>${escapeHtml(card.explanation || '')}</p>
        </section>`
      : '';
    const choices = Array.isArray(card.options) ? card.options.map((option, index) => {
      const selected = selectedIndex === index;
      const resultClass = selected
        ? answered ? (card.state.correct ? ' selected correct' : ' selected incorrect') : ' pressed'
        : '';
      return `<button type="button" class="answer-option${resultClass}" data-answer-card="${escapeHtml(card.card_id)}" data-answer-index="${index}" aria-pressed="${selected}" ${answered || pending ? 'disabled' : ''}>
        <span class="answer-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHtml(option)}</span>
      </button>`;
    }).join('') : '';
    const locale = activation?.lesson_locale === 'zh-CN' ? 'Chinese content arrives in Stage 2' : '';
    return `<article class="lesson-card" aria-label="Current lesson">
      <div class="card-topline"><p class="card-kicker">Now</p><span class="now-status">one question</span></div>
      <p class="card-concept">${escapeHtml(card.concept_name)}</p>
      <p class="source-line source-line--${sourceKind(card.source)}">${sourceMarkup(card.source)}</p>
      <p class="lesson-copy">${escapeHtml(card.lesson)}</p>
      <h3>${escapeHtml(card.question)}</h3>
      <div class="answers" aria-label="Answer choices">${choices}</div>
      ${feedback}
      ${nextControl(project, card)}
      ${locale ? `<p class="locale-note">${escapeHtml(locale)}</p>` : ''}
    </article>`;
  }

  function renderReview(project) {
    const cards = project.cards.filter((card) => card.state?.answered);
    if (!cards.length) {
      return `<article class="waiting-card"><p class="eyebrow">Past lessons</p><h3>Your answered lessons will collect here.</h3><p>There is nothing to revise yet — keep your attention on the work in front of you.</p></article>`;
    }
    return `<section class="review-area" aria-label="Past lessons">
      <header class="review-heading"><p class="eyebrow">Past lessons</p><h3>Revisit the ideas you have already met.</h3></header>
      <ol class="review-list">${[...cards].reverse().map((card) => `<li class="review-card">
        <div><p class="card-concept">${escapeHtml(card.concept_name)}</p><p class="source-line source-line--${sourceKind(card.source)}">${sourceMarkup(card.source)}</p></div>
        <p>${escapeHtml(card.lesson)}</p>
        <p class="review-answer"><strong>${card.state?.correct ? 'Learned' : 'Worth revisiting'}</strong> ${escapeHtml(card.explanation || '')}</p>
      </li>`).join('')}</ol>
    </section>`;
  }

  function renderActivation(activation) {
    const projectName = activation?.name || 'this project';
    const held = Number(activation?.pending_report_count || 0);
    return `<article class="activation-card">
      <p class="eyebrow">First activation</p>
      <h3>Enable Osmosis for ${escapeHtml(projectName)}?</h3>
      <p>This is your call. Until you choose, agent reports${held ? ` (${held} held ${held === 1 ? 'milestone' : 'milestones'})` : ''} wait safely and ambient activity creates no project learning state.</p>
      <form id="activation-form" class="choice-form">
        <fieldset><legend>Learning for this project</legend>
          <label class="choice-row"><input type="radio" name="carry" value="yes" checked><span><strong>Carry this project</strong><small>Keep its lessons and let its knowledge travel with you.</small></span></label>
          <label class="choice-row"><input type="radio" name="carry" value="no"><span><strong>Don’t carry it</strong><small>Leave it out of Osmosis. You can change this later.</small></span></label>
        </fieldset>
        <fieldset><legend>Lesson language</legend>
          <label class="select-label">Language<select name="lesson_locale"><option value="en">English</option><option value="zh-CN">Simplified Chinese</option></select></label>
        </fieldset>
        <fieldset><legend>Capture</legend>
          <label class="choice-row"><input type="radio" name="capture_mode" value="agent-reports-only" checked><span><strong>Agent reports only</strong><small>Lessons begin from explicit milestones.</small></span></label>
          <label class="choice-row"><input type="radio" name="capture_mode" value="experimental-ambient"><span><strong>+ Experimental Ambient Watch</strong><small>May observe local Codex activity when the machine-level switch is on.</small></span></label>
        </fieldset>
        <button class="primary-button" type="submit">Save this choice</button>
        ${activeProject() ? '<button class="activation-later" type="button" data-dismiss-activation>Decide later</button>' : ''}
      </form>
    </article>`;
  }

  function renderNav() {
    const hasProject = Boolean(activeProject()) && !focusedActivation();
    studioNav.hidden = !hasProject;
    if (!hasProject) return;
    for (const button of studioNav.querySelectorAll('[data-studio-view]')) {
      button.classList.toggle('is-active', button.dataset.studioView === store.studioView);
    }
  }

  function renderStage() {
    const pending = focusedActivation();
    if (pending?.state === 'activation-pending') {
      cardStage.innerHTML = renderActivation(pending);
      bindStageActions();
      return;
    }
    const project = activeProject();
    if (!project) {
      cardStage.innerHTML = `<article class="waiting-card"><p class="eyebrow">Learning Studio</p><h3>Open a project with Osmosis to begin.</h3><p>Only projects you choose to carry appear as learning channels.</p></article>`;
      bindStageActions();
      return;
    }
    cardStage.innerHTML = store.studioView === 'review' ? renderReview(project) : renderNow(project);
    bindStageActions();
    scheduleAutoAdvance(project);
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
      ? entries.map((entry) => `<li class="activity-entry"><span class="activity-state activity-state--${escapeHtml(entry.state || 'observed')}">${escapeHtml(entry.state || 'observed')}</span><span>${escapeHtml(entry.message || entry.reason || entry.event || 'Project activity')}</span></li>`).join('')
      : '<li class="activity-empty">No durable activity yet. Reports and generator outcomes will appear here.</li>';
  }

  function render() {
    renderTabs();
    renderActivationInbox();
    renderConnection();
    renderTrail();
    renderNav();
    renderStage();
    renderActivity();
  }

  function showToast(message) {
    if (!message) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3_400);
  }

  function applyNotices(notices) {
    if (!Array.isArray(notices)) return;
    for (const notice of notices) {
      if (!notice || typeof notice.message !== 'string' || !notice.message) continue;
      const key = `${notice.code || 'notice'}:${notice.project_id || ''}`;
      if (seenStartupNotices.has(key)) continue;
      seenStartupNotices.add(key);
      showToast(notice.message);
    }
  }

  function controllerFor(projectId) {
    if (!store.auto.has(projectId)) {
      store.auto.set(projectId, { state: studioState?.createAutoAdvanceState?.() || { enabled: false }, timer: null, setting: false });
    }
    return store.auto.get(projectId);
  }

  function noteInteraction(projectId = store.activeProjectId) {
    if (!projectId) return;
    const controller = controllerFor(projectId);
    window.clearTimeout(controller.timer);
    controller.timer = null;
    studioState?.noteStudioInteraction?.(controller.state);
  }

  function scheduleAutoAdvance(project) {
    const projectId = project?.project_id;
    if (!projectId || store.studioView !== 'now') return;
    const controller = controllerFor(projectId);
    const enabled = activationFor(projectId)?.auto_advance === true;
    if (controller.setting !== enabled) {
      controller.setting = enabled;
      studioState?.setAutoAdvanceEnabled?.(controller.state, enabled);
    }
    const current = project.studio?.current;
    const nextReady = studioState?.autoAdvanceEligible
      ? studioState.autoAdvanceEligible(project.studio)
      : Boolean(project.studio?.next_ready && current?.state?.answered);
    if (nextReady) studioState?.noteNextReady?.(controller.state);
    else studioState?.noteNextUnavailable?.(controller.state);
    window.clearTimeout(controller.timer);
    controller.timer = null;
    const gate = studioState?.autoAdvanceGate?.(controller.state, { nextReady }) || { shouldAdvance: false };
    if (!gate.shouldAdvance && gate.remainingMs !== null && enabled) {
      controller.timer = window.setTimeout(() => void autoAdvance(projectId), gate.remainingMs + 8);
      return;
    }
    if (gate.shouldAdvance && enabled) {
      controller.timer = window.setTimeout(() => void autoAdvance(projectId), 0);
    }
  }

  async function autoAdvance(projectId) {
    // A scheduled timer belongs only to the lesson the learner is currently
    // looking at. Tab, deep-link, and review transitions are interactions;
    // an old project's timer must never advance it in the background.
    const activeNow = studioState?.isActiveNowContext
      ? studioState.isActiveNowContext(store, projectId)
      : store.activeProjectId === projectId && store.studioView === 'now';
    if (!activeNow) return;
    const project = projectFor(projectId);
    const controller = controllerFor(projectId);
    const gate = studioState?.claimAutoAdvance?.(controller.state, {
      nextReady: studioState?.autoAdvanceEligible
        ? studioState.autoAdvanceEligible(project.studio)
        : Boolean(project.studio?.next_ready && project.studio?.current?.state?.answered),
    });
    if (!gate?.shouldAdvance) return;
    await advanceLesson(projectId, { auto: true });
  }

  function bindStageActions() {
    const activationForm = cardStage.querySelector('#activation-form');
    activationForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitActivation(new FormData(activationForm));
    });
    cardStage.querySelector('[data-dismiss-activation]')?.addEventListener('click', () => {
      store.activationProjectId = null;
      render();
    });
    for (const button of cardStage.querySelectorAll('[data-answer-card]')) {
      button.addEventListener('click', () => void submitAnswer(store.activeProjectId, button.dataset.answerCard, Number(button.dataset.answerIndex)));
    }
    cardStage.querySelector('[data-next-lesson]')?.addEventListener('click', () => void advanceLesson(store.activeProjectId));
  }

  async function submitActivation(form) {
    const activation = focusedActivation();
    if (!activation?.project_id) return;
    const payload = {
      auto_advance: false,
      capture_mode: form.get('capture_mode') === 'experimental-ambient' ? 'experimental-ambient' : 'agent-reports-only',
      carry: form.get('carry') !== 'no',
      lesson_locale: form.get('lesson_locale') === 'zh-CN' ? 'zh-CN' : 'en',
    };
    try {
      const response = await fetch(`/activation?project=${encodeURIComponent(activation.project_id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('Activation was rejected');
      const result = await response.json();
      applyActivations(result.activation);
      if (result.project) updateSummary(result.project);
      const hadActiveProject = Boolean(activeProject());
      store.activationProjectId = null;
      if (payload.carry) {
        if (!hadActiveProject) {
          await selectProject(activation.project_id, 'now', { writeHash: true, forceHydrate: true });
        } else {
          showToast(result.released ? 'Your held milestone is becoming a lesson in its project tab.' : 'This project is ready in its tab.');
        }
      } else {
        showToast('This project will stay outside your learning trail.');
      }
      render();
    } catch {
      showToast('Osmosis could not save that choice. Please try again.');
    }
  }

  async function submitAnswer(projectId, cardId, index) {
    const project = projectFor(projectId);
    const card = project.studio?.current || cardById(project, cardId);
    if (!card || card.state?.answered || store.pendingAnswers.has(projectId)) return;
    noteInteraction(projectId);
    store.pendingAnswers.set(projectId, { cardId, index });
    renderStage();
    try {
      const response = await fetch(`/answer?project=${encodeURIComponent(projectId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card_id: cardId, chosen_index: index }),
      });
      if (!response.ok) throw new Error('Answer rejected');
      const result = await response.json();
      const answered = { ...card, state: { answered: true, chosen_index: index, correct: result.correct }, explanation: result.explanation };
      project.studio.current = answered;
      project.cards = project.cards.map((item) => item.card_id === cardId ? answered : item);
      store.strengths[answered.concept_id] = { ...(store.strengths[answered.concept_id] || {}), name: answered.concept_name, strength: result.strength };
      store.pendingAnswers.delete(projectId);
      render();
    } catch {
      store.pendingAnswers.delete(projectId);
      renderStage();
      showToast('Osmosis could not save that answer. Please try again.');
    }
  }

  async function advanceLesson(projectId, { auto = false } = {}) {
    if (!projectId) return;
    if (!auto) noteInteraction(projectId);
    try {
      const project = projectFor(projectId);
      const automaticOptions = auto
        ? {
          auto: true,
          enabled: true,
          ...(Number.isInteger(project.studio?.interaction_token)
            ? { interaction_token: project.studio.interaction_token }
            : {}),
        }
        : {};
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/next`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(automaticOptions),
      });
      if (!response.ok) throw new Error('Next unavailable');
      const result = await response.json();
      if (result.advanced && result.card) {
        if (result.studio) applyStudio(projectId, result.studio);
        else {
          project.studio.current = result.card;
          project.studio.next_ready = false;
          project.cards = studioState?.mergeStudioCurrent
            ? studioState.mergeStudioCurrent(project.cards, result.card)
            : [...project.cards.filter((card) => card.card_id !== result.card.card_id), result.card];
        }
        if (store.activeProjectId === projectId) render();
        return;
      }
      if (result.studio) applyStudio(projectId, result.studio);
      if (result.state === 'answer-required') showToast('Answer the current question first.');
      else if (!auto) showToast(result.state === 'preparing' ? 'Your next lesson is still preparing.' : 'Nothing new is ready yet.');
      if (store.activeProjectId === projectId) render();
    } catch {
      if (!auto) showToast('Osmosis could not open the next lesson yet.');
    }
  }

  async function selectProject(projectId, view = 'now', { writeHash = false, forceHydrate = false } = {}) {
    if (typeof projectId !== 'string') return;
    const targetView = view === 'review' ? 'review' : 'now';
    const previousProjectId = store.activeProjectId;
    const previousView = store.studioView;
    if (previousProjectId && (previousProjectId !== projectId || previousView !== targetView)) {
      noteInteraction(previousProjectId);
    }
    // A tab click is an explicit choice to return to that channel. Do not
    // leave a separate project's activation sheet covering it afterwards.
    store.activationProjectId = null;
    const route = { projectId, view: targetView };
    if (studioState?.selectStudioRouteFromUser) studioState.selectStudioRouteFromUser(store, route);
    else {
      store.activeProjectId = projectId;
      store.studioView = view === 'review' ? 'review' : 'now';
      store.readyProjectIds.delete(projectId);
    }
    if (writeHash) {
      const hash = studioState?.buildStudioRoute?.(route) || `#project=${encodeURIComponent(projectId)}&view=${encodeURIComponent(view)}`;
      if (hash && window.location.hash !== hash) window.history.pushState(null, '', hash);
    }
    const project = projectFor(projectId);
    render();
    if (!forceHydrate && project.hydrated) {
      if (store.studioView === 'review') void loadReview(projectId);
      return;
    }
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/snapshot`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Snapshot unavailable');
      applySnapshot(projectId, await response.json());
      if (store.activeProjectId === projectId) {
        render();
        if (store.studioView === 'review') void loadReview(projectId);
      } else {
        renderTabs();
      }
    } catch {
      if (store.activeProjectId === projectId) showToast('Osmosis could not load that project yet.');
    }
  }

  async function loadReview(projectId) {
    const project = projectFor(projectId);
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/review`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Review unavailable');
      const body = await response.json();
      if (Array.isArray(body.cards)) {
        project.cards = studioState?.mergeStudioCurrent
          ? studioState.mergeStudioCurrent(body.cards, project.studio.current)
          : body.cards;
      }
      project.reviewLoaded = true;
      if (store.activeProjectId === projectId && store.studioView === 'review') renderStage();
    } catch {
      // Keep the local answered history visible if the optional refresh fails.
    }
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
      project.activities.push({ event: 'drawer', message: 'Activity history is temporarily unavailable.', state: 'failed' });
      renderActivity();
    }
  }

  async function archiveProject(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST' });
      if (!response.ok) throw new Error('Archive unavailable');
      updateSummary((await response.json()).project);
      renderTabs();
    } catch { showToast('Osmosis could not archive that project.'); }
  }

  async function restoreProject(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/unarchive`, { method: 'POST' });
      if (!response.ok) throw new Error('Restore unavailable');
      updateSummary((await response.json()).project);
      renderTabs();
    } catch { showToast('Osmosis could not restore that project.'); }
  }

  function renderSettings() {
    const activation = activationFor();
    const paused = store.settings.global_learning === 'paused';
    const projectControls = activation
      ? `<section class="settings-group"><p class="settings-label">${escapeHtml(activation.name || 'This project')}</p>
          <label class="toggle-row"><span><strong>Learning stays with this project</strong><small>${activation.carry ? 'Carried projects have a private Studio trail.' : 'This project is not currently carried.'}</small></span><input id="setting-carry" type="checkbox" ${activation.carry ? 'checked' : ''}></label>
          <label class="select-label">Capture<select id="setting-capture"><option value="agent-reports-only" ${activation.capture_mode === 'agent-reports-only' ? 'selected' : ''}>Agent reports only</option><option value="experimental-ambient" ${activation.capture_mode === 'experimental-ambient' ? 'selected' : ''}>+ Experimental Ambient Watch</option></select></label>
          <label class="toggle-row"><span><strong>Auto-advance</strong><small>Only after a ready Next lesson and a short quiet delay.</small></span><input id="setting-auto" type="checkbox" ${activation.auto_advance ? 'checked' : ''}></label>
        </section>`
      : '<p class="settings-copy">Start Osmosis in a project to choose its learning settings.</p>';
    settingsContent.innerHTML = `<section class="settings-group">
      <p class="settings-label">Global learning</p>
      <label class="toggle-row"><span><strong>${paused ? 'Paused' : 'On'}</strong><small>${paused ? 'No new capture, generation, or delivery.' : 'Osmosis can turn useful work into lessons.'}</small></span><input id="setting-global" type="checkbox" ${paused ? '' : 'checked'}></label>
      <label class="select-label">Lesson language<select id="setting-locale"><option value="en" ${store.settings.lesson_locale === 'en' ? 'selected' : ''}>English</option><option value="zh-CN" ${store.settings.lesson_locale === 'zh-CN' ? 'selected' : ''}>Simplified Chinese</option></select></label>
    </section>${projectControls}<button class="primary-button" id="save-settings" type="button">Save preferences</button>`;
    settingsContent.querySelector('#save-settings')?.addEventListener('click', () => void saveSettings());
  }

  async function saveSettings() {
    const global = settingsContent.querySelector('#setting-global')?.checked ? 'on' : 'paused';
    const locale = settingsContent.querySelector('#setting-locale')?.value === 'zh-CN' ? 'zh-CN' : 'en';
    try {
      const response = await fetch('/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ global_learning: global, lesson_locale: locale }),
      });
      if (!response.ok) throw new Error('Settings unavailable');
      applySettings(await response.json());
      const activation = activationFor();
      if (activation?.project_id) {
        const projectResponse = await fetch(`/projects/${encodeURIComponent(activation.project_id)}/settings`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            auto_advance: Boolean(settingsContent.querySelector('#setting-auto')?.checked),
            capture_mode: settingsContent.querySelector('#setting-capture')?.value === 'experimental-ambient' ? 'experimental-ambient' : 'agent-reports-only',
            carry: Boolean(settingsContent.querySelector('#setting-carry')?.checked),
          }),
        });
        if (projectResponse.ok) {
          const result = await projectResponse.json();
          applyActivations(result.activation);
          if (result.project) updateSummary(result.project);
        }
      }
      settingsDialog.close?.();
      render();
      showToast('Learning preferences saved.');
    } catch { showToast('Osmosis could not save those preferences.'); }
  }

  function applySettings(value) {
    if (!value || typeof value !== 'object') return;
    store.settings = { ...store.settings, ...value };
    applyActivations(value.activation);
    applyActivations(value.activations);
    applyNotices(value.notices);
  }

  function updateConnectionStatus(status) {
    if (status?.provider) provider = status.provider;
    if (status?.state === 'failed') showToast('Osmosis could not make a lesson from that activity. It will wait for the next useful signal.');
    renderConnection();
  }

  function applyProjectEvent(type, payload) {
    const projectId = payload?.project_id;
    if (typeof projectId !== 'string') return;
    const project = projectFor(projectId);
    markActivity(projectId);
    if (type === 'card') {
      project.cards = project.cards.filter((card) => card.card_id !== payload.card_id);
      project.cards.push(payload);
      // A card event is compatibility data, not a command to move the
      // learner's focus. Only the canonical Studio event (or a matching Now
      // id) may replace current; a hidden/late card must never steal Now.
      if (payload.card_id === project.studio?.current?.card_id) project.studio.current = payload;
    } else if (type === 'snapshot') {
      applySnapshot(projectId, payload);
    } else if (type === 'studio') {
      applyStudio(projectId, payload);
    } else if (type === 'strength') {
      if (payload.concept_id) store.strengths[payload.concept_id] = { ...(store.strengths[payload.concept_id] || {}), strength: payload.strength };
    } else if (type === 'status') {
      project.activities.push({ ...payload, state: payload.state || 'observed', ts: new Date().toISOString() });
      project.activities = project.activities.slice(-100);
      if (projectId === store.activeProjectId) updateConnectionStatus(payload);
    }
    if (projectId === store.activeProjectId) render();
    else renderTabs();
  }

  function applyInitialV2(payload) {
    if (!payload || typeof payload !== 'object') return;
    store.defaultProjectId = payload.default_project_id || null;
    replaceSummaries(payload.projects);
    applySettings(payload.settings);
    applyActivations(payload.activation);
    applyActivations(payload.activations);
    applyNotices(payload.notices);
    if (payload.channel?.project_id) applySnapshot(payload.channel.project_id, payload.channel);
    const route = studioState?.parseStudioRoute?.(window.location.hash) || { projectId: null, view: 'now' };
    const desired = route.projectId && store.projects.has(route.projectId)
      ? route.projectId
      : payload.active_project_id && store.projects.has(payload.active_project_id)
        ? payload.active_project_id
        : null;
    if (desired) {
      void selectProject(desired, route.projectId ? route.view : 'now', { writeHash: false });
    } else {
      store.studioView = 'now';
      render();
    }
  }

  function connectEvents() {
    const events = new EventSource('/events');
    events.addEventListener('snapshot', (event) => {
      try {
        const legacy = JSON.parse(event.data);
        if (store.defaultProjectId && store.projects.has(store.defaultProjectId)) applySnapshot(store.defaultProjectId, legacy);
      } catch {}
    });
    events.addEventListener('snapshot-v2', (event) => {
      try { applyInitialV2(JSON.parse(event.data)); } catch {}
    });
    events.addEventListener('projects', (event) => {
      try { replaceSummaries(JSON.parse(event.data).projects); renderTabs(); } catch {}
    });
    events.addEventListener('settings', (event) => {
      try { applySettings(JSON.parse(event.data)); render(); } catch {}
    });
    events.addEventListener('activation', (event) => {
      try { applyActivations(JSON.parse(event.data)); render(); } catch {}
    });
    for (const type of ['card', 'snapshot', 'status', 'strength', 'tree', 'studio']) {
      events.addEventListener(`project-${type}`, (event) => {
        try { applyProjectEvent(type, JSON.parse(event.data)); } catch {}
      });
      events.addEventListener(type, (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload?.project_id) applyProjectEvent(type, payload);
          else if (type === 'status') updateConnectionStatus(payload);
        } catch {}
      });
    }
    events.addEventListener('open', () => { connection.textContent = statusForActive(); connection.classList.add('live'); });
    events.addEventListener('error', () => { connection.textContent = 'Reconnecting…'; connection.classList.remove('live'); });
  }

  document.querySelector('#activity-close').addEventListener('click', () => {
    store.drawerProjectId = null;
    renderActivity();
  });
  document.querySelector('#review-button').addEventListener('click', () => {
    if (store.activeProjectId) void selectProject(store.activeProjectId, 'review', { writeHash: true });
  });
  document.querySelector('#settings-button').addEventListener('click', () => {
    renderSettings();
    if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
    else settingsDialog.setAttribute('open', '');
  });
  studioNav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-studio-view]');
    if (button && store.activeProjectId) {
      noteInteraction(store.activeProjectId);
      void selectProject(store.activeProjectId, button.dataset.studioView, { writeHash: true });
    }
  });
  cardStage.addEventListener('pointerdown', () => noteInteraction(), { passive: true });
  cardStage.addEventListener('keydown', () => noteInteraction());
  window.addEventListener('hashchange', () => {
    const route = studioState?.parseStudioRoute?.(window.location.hash);
    if (route?.projectId && store.projects.has(route.projectId)) void selectProject(route.projectId, route.view, { writeHash: false });
  });

  render();
  connectEvents();
})();
