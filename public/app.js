(() => {
  'use strict';

  const projectState = window.OsmosisProjectState;
  const projectLabels = window.OsmosisProjectLabels;
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
    settings: { global_learning: 'on', lesson_locale: 'en', ui_locale: 'zh-CN', mascot_enabled: true, local_conversation_titles: false, projects: {} },
    strengths: {},
    studioView: 'now',
    conversationTitles: new Map(),
    celebration: null,
  };

  let provider = 'none';
  let toastTimer = null;
  const seenStartupNotices = new Set();
  const celebratedAnswerEpisodes = new Set();

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
  const activityPipeline = document.querySelector('#activity-pipeline');
  const activeConversation = document.querySelector('#active-conversation');

  const copy = {
    'zh-CN': {
      activity: '活动', agent: '智能体汇报', agent_copy: '智能体汇报了一个里程碑。',
      archive: '归档', archive_error: '暂时无法归档这个项目。', archive_hint: '保留，绝不删除', archived_projects: '已归档项目',
      auto_advance: '自动进入下一课', auto_advance_copy: '仅在下一课就绪且短暂停顿后自动进入。',
      capture: '捕捉方式', carry: '让学习随项目保留', carried_copy: '已保留的项目拥有私密的学习轨迹。',
      change: '观察到的改动', change_copy: 'Osmosis 观察到了本地 Codex 改动。',
      choose_project: '打开一个带有 Osmosis 的项目，即可开始。', close: '关闭',
      connection_error: '正在重新连接…', current_lesson: '当前课程', decide_later: '稍后决定',
      dont_carry: '不保留这个项目', dont_carry_copy: '不把它纳入 Osmosis，之后仍可修改。',
      enable_project: '要为 {project} 启用 Osmosis 吗？',
      experimental_ambient: '+ 实验性 Ambient Watch', experimental_ambient_copy: '机器级开关开启时，可能观察本地 Codex 活动。',
      first_activation: '首次启用', global_learning: '全局学习', idle_copy: '继续工作吧；看到有用活动后，Osmosis 会准备下一课。',
      language: '课程语言', learning_off: '已暂停', learning_on: '已开启', learning_paused: '学习已暂停',
      no_activity: '还没有持久化活动。汇报与生成结果会显示在这里。', no_new_lesson: '暂时没有新的相关课程',
      now: '现在', observed_activity: '观察到的活动', observed_activity_copy: 'Osmosis 观察到了本地 Codex 活动。',
      past_lessons: '学过的课', preparing: '正在备课', preparing_next: '正在准备下一课…',
      project_activity: '{project} · 活动', project_outside: '这个项目将保持在学习轨迹之外。',
      reports_only: '仅智能体汇报', reports_only_copy: '课程从明确的里程碑开始。',
      review_empty: '答过的课程会收集在这里。', review_empty_copy: '现在没有需要复习的内容，把注意力留给眼前的工作就好。',
      review_heading: '复习你已经遇见过的想法。', review_lessons: '复习学过的课',
      save: '保存偏好', save_choice: '保存这个选择', saved: '学习偏好已保存。',
      settings: '设置', settings_error: '暂时无法保存这些偏好。', settings_title: '把 Osmosis 调成你的节奏',
      source_agent: '智能体汇报', source_observed_activity: '观察到的活动', source_observed_change: '观察到的改动',
      stage2: '中文课程内容将在第二阶段到来。', trail_empty: '第一条有用活动会在这里开始你的轨迹。',
      trail_note: '路线会随工作改变；这里没有虚构的课程进度要追。', trail_next: '一节后续课程已准备好，随时等你。',
      uncarried_copy: '这个项目目前没有被保留。', waiting: '等待有用活动', warmup: '即时热身', warmup_copy: '根据刚刚的本地操作准备',
      warmup_feedback: '这是一张即时热身，不会写入掌握度或课程记录。', why_no_card: '为什么还没有卡片？',
      yes_carry: '保留这个项目', yes_carry_copy: '留下它的课程，让知识可以带到下一个项目。',
      you_got_it: '答对了。', correction: '再想一想。', learned: '已学会', revisit: '以后复习', waiting_short: '等待中', now_short: '现在',
      activity_id: '观察编号', answer_choices: '答案选项', focused_question: '一题专注练习', lesson_ready: '课程已就绪', next_lesson: '下一课', one_small_question: '一题小练习', reason: '原因',
      warmup_replaced_refreshed: '这张热身题已被同一活动的正式课程替换。', warmup_replaced_reconnecting: '这张热身题已被替换；页面会在重新连接后更新。',
      ui_language: '界面语言', mascot: '桌伴', mascot_copy: '让小渗在角落陪你观察学习活动。',
      local_titles: '显示本地对话标题', local_titles_copy: '默认关闭；开启后只在本机保存简短标题，可随时关闭并清除。',
      active_conversation: '当前对话：{title}',
      archived_tabs: '已归档项目', close_activity: '关闭活动', close_settings: '关闭设置',
      preferences: '学习偏好', project_activity_drawer: '项目活动', project_channels: '项目频道', trail_intro: '工作里浮现过的想法，会安静地留在这里；这不是一门需要赶进度的课。',
      trail_title: '你的学习轨迹', studio_label: '学习工作台', studio_title: '一次只学一件有用的事。', while_agent_works: '趁智能体在工作',
    },
    en: {
      activity: 'Activity', agent: 'Reported by agent', agent_copy: 'Your agent reported a milestone.',
      archive: 'Archive', archive_error: 'Osmosis could not archive that project.', archive_hint: 'kept, never deleted', archived_projects: 'Archived projects',
      auto_advance: 'Auto-advance', auto_advance_copy: 'Only after a ready Next lesson and a short quiet delay.',
      capture: 'Capture', carry: 'Keep learning with this project', carried_copy: 'Carried projects have a private Studio trail.',
      change: 'Observed change', change_copy: 'Osmosis observed a local Codex change.',
      choose_project: 'Open a project with Osmosis to begin.', close: 'Close',
      connection_error: 'Reconnecting…', current_lesson: 'Current lesson', decide_later: 'Decide later',
      dont_carry: 'Don’t carry this project', dont_carry_copy: 'Leave it out of Osmosis. You can change this later.',
      enable_project: 'Enable Osmosis for {project}?',
      experimental_ambient: '+ Experimental Ambient Watch', experimental_ambient_copy: 'May observe local Codex activity when the machine-level switch is on.',
      first_activation: 'First activation', global_learning: 'Global learning', idle_copy: 'Keep working; Osmosis will prepare the next lesson when it sees something useful.',
      language: 'Lesson language', learning_off: 'Paused', learning_on: 'On', learning_paused: 'Learning paused',
      no_activity: 'No durable activity yet. Reports and generator outcomes will appear here.', no_new_lesson: 'Nothing relevant yet',
      now: 'Now', observed_activity: 'Observed activity', observed_activity_copy: 'Osmosis observed local Codex activity.',
      past_lessons: 'Past lessons', preparing: 'Preparing', preparing_next: 'Preparing the next lesson…',
      project_activity: '{project} · activity', project_outside: 'This project will stay outside your learning trail.',
      reports_only: 'Agent reports only', reports_only_copy: 'Lessons begin from explicit milestones.',
      review_empty: 'Your answered lessons will collect here.', review_empty_copy: 'There is nothing to revise yet — keep your attention on the work in front of you.',
      review_heading: 'Revisit the ideas you have already met.', review_lessons: 'Review past lessons',
      save: 'Save preferences', save_choice: 'Save this choice', saved: 'Learning preferences saved.',
      settings: 'Settings', settings_error: 'Osmosis could not save those preferences.', settings_title: 'Make Osmosis yours',
      source_agent: 'Reported by agent', source_observed_activity: 'Observed activity', source_observed_change: 'Observed change',
      stage2: 'Chinese lesson content arrives in Stage 2.', trail_empty: 'Your trail will begin with the first useful signal from this project.',
      trail_note: 'The route changes with your work; there is no fake curriculum to catch up on.', trail_next: 'One follow-up lesson is ready whenever you are.',
      uncarried_copy: 'This project is not currently carried.', waiting: 'Waiting for useful activity', warmup: 'Instant warmup', warmup_copy: 'Prepared from the local action just observed',
      warmup_feedback: 'This is an instant warmup; it never changes mastery or lesson history.', why_no_card: 'Why no card?',
      yes_carry: 'Carry this project', yes_carry_copy: 'Keep its lessons and let its knowledge travel with you.',
      you_got_it: 'That’s it.', correction: 'A small correction.', learned: 'Learned', revisit: 'Revisit later', waiting_short: 'Waiting', now_short: 'Now',
      activity_id: 'Activity ID', answer_choices: 'Answer choices', focused_question: 'One focused question', lesson_ready: 'Lesson ready', next_lesson: 'Next lesson', one_small_question: 'One small question', reason: 'Reason',
      warmup_replaced_refreshed: 'This warmup was replaced by the full lesson from the same activity.', warmup_replaced_reconnecting: 'This warmup was replaced. The page will update when it reconnects.',
      ui_language: 'Interface language', mascot: 'Desk buddy', mascot_copy: 'Let Xiao Shen keep a quiet eye on learning activity.',
      local_titles: 'Show local conversation titles', local_titles_copy: 'Off by default; when enabled, short titles stay only on this device and clear when turned off.',
      active_conversation: 'Active conversation: {title}',
      archived_tabs: 'Archived projects', close_activity: 'Close activity', close_settings: 'Close settings',
      preferences: 'Learning preferences', project_activity_drawer: 'Project activity', project_channels: 'Project channels', trail_intro: 'Ideas that surface while you work can rest quietly here; this is not a course you need to rush through.',
      trail_title: 'Your learning trail', studio_label: 'Learning Studio', studio_title: 'Learn one useful thing at a time.', while_agent_works: 'While your agent works',
    },
  };

  function uiLocale() {
    return store.settings.ui_locale === 'en' ? 'en' : 'zh-CN';
  }

  function t(key, values = {}) {
    const phrase = copy[uiLocale()][key] || copy['zh-CN'][key] || key;
    return phrase.replace(/\{([a-z_]+)\}/g, (_, name) => String(values[name] ?? ''));
  }

  function refreshStaticCopy() {
    document.documentElement.lang = uiLocale();
    document.title = uiLocale() === 'en' ? 'Osmosis — Learning Studio' : 'Osmosis｜学习工作台';
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll('[data-i18n-aria]')) {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    }
  }

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
      now: { kind: null, card_ref: null },
      current: null,
      current_warmup: null,
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
        name: uiLocale() === 'en' ? 'Project' : '项目',
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
    if (sourceKind(source) === 'observed-change') return t('source_observed_change');
    if (sourceKind(source) === 'observed-activity') return t('source_observed_activity');
    return t('source_agent');
  }

  function sourceText(source) {
    if (source?.what_i_did) return source.what_i_did;
    if (sourceKind(source) === 'observed-change') return t('change_copy');
    if (sourceKind(source) === 'observed-activity') return t('observed_activity_copy');
    return t('agent_copy');
  }

  function sourceMarkup(source, { compact = false } = {}) {
    const kind = sourceKind(source);
    const title = store.settings.local_conversation_titles === true
      && typeof source?.conversation_id === 'string'
      ? store.conversationTitles.get(source.conversation_id)
      : null;
    return `<span class="provenance-label provenance-label--${kind}">${escapeHtml(sourceLabel(source))}</span>${title ? `<span class="conversation-badge" title="${escapeHtml(title)}">${escapeHtml(title)}</span>` : ''}${compact ? '' : `<span class="source-copy">${escapeHtml(sourceText(source))}</span>`}`;
  }

  function studioProgress(value) {
    const described = studioState?.describeProgress?.(value, uiLocale());
    if (described) return described;
    if (!value || typeof value !== 'object') return null;
    const phase = value.phase === 'preparing' || value.phase === 'observed' ? value.phase : null;
    const observationId = typeof value.observation_id === 'string' ? value.observation_id.trim() : '';
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    if (!phase || !observationId || !reason) return null;
    const preparing = phase === 'preparing';
    return {
      phase,
      observation_id: observationId,
      reason,
      badge: preparing ? t('preparing') : t('observed_activity'),
      title: preparing
        ? (uiLocale() === 'en' ? 'Preparing a lesson from observed agent activity.' : '正在根据已观察到的智能体活动准备课程。')
        : (uiLocale() === 'en' ? 'Observed an agent performing local development work.' : '已观察到智能体正在进行本地开发操作。'),
      detail: preparing
        ? (uiLocale() === 'en' ? 'Preparing a full lesson from this activity.' : '正在根据这次观察准备正式课程。')
        : (uiLocale() === 'en' ? 'This activity passed the instant-warmup check.' : '这次观察已通过即时热身检查。'),
    };
  }

  function progressMarkup(value, { compact = false } = {}) {
    const progress = studioProgress(value);
    if (!progress) return '';
    const trace = progress.observation_id.slice(0, 12);
    return `<section class="progress-phase progress-phase--${escapeHtml(progress.phase)}" data-observation-id="${escapeHtml(progress.observation_id)}" data-progress-reason="${escapeHtml(progress.reason)}" aria-live="polite">
      <p class="eyebrow">${escapeHtml(progress.badge)}</p>
      ${compact ? '' : `<h3>${escapeHtml(progress.title)}</h3>`}
      <p>${escapeHtml(progress.detail)}</p>
      <small>${escapeHtml(t('activity_id'))}: ${escapeHtml(trace)} · ${escapeHtml(t('reason'))}: ${escapeHtml(progress.reason)}</small>
    </section>`;
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

  function isWarmupCard(card) {
    return Boolean(card && typeof card === 'object' && (
      card.kind === 'warmup' || (typeof card.warmup_id === 'string' && card.warmup_id)
    ));
  }

  function realCards(cards) {
    return (Array.isArray(cards) ? cards : []).filter((card) => card && !isWarmupCard(card));
  }

  function studioNowKind(studio) {
    return studio?.now?.kind === 'warmup' || studio?.now?.kind === 'real'
      ? studio.now.kind
      : null;
  }

  function currentWarmup(project) {
    const warmup = studioNowKind(project?.studio) === 'warmup' ? project.studio.current_warmup || null : null;
    return warmup?.warmup_id === project?.studio?.now?.card_ref ? warmup : null;
  }

  function normalizeStudio(snapshot, cards, previous = null) {
    const raw = snapshot?.studio;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Transitional owners may still send an old pointer-only snapshot.
      // Resolve that exact pointer, never a convenient-looking unanswered card:
      // a hidden Next must not replace the answered lesson in the learner's
      // hands while a snapshot is being reconciled.
      const currentId = raw.now?.kind === 'real' && typeof raw.now.card_ref === 'string'
        ? raw.now.card_ref
        : typeof raw.current_card_id === 'string' ? raw.current_card_id : null;
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
    return {
      ...emptyStudio(),
      now: current ? { kind: 'real', card_ref: current.card_id } : { kind: null, card_ref: null },
      current,
    };
  }

  function applySnapshot(projectId, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const project = projectFor(projectId);
    project.cards = Array.isArray(snapshot.cards) ? realCards(snapshot.cards) : project.cards;
    project.tree = snapshot.tree || project.tree;
    project.studio = normalizeStudio(snapshot, project.cards, project.studio);
    project.cards = studioState?.mergeStudioCurrent
      ? studioState.mergeStudioCurrent(project.cards, project.studio.current, project.studio.now)
      : studioNowKind(project.studio) === 'real' && project.studio.current
        ? [...project.cards.filter((card) => card?.card_id !== project.studio.current.card_id), project.studio.current]
        : project.cards;
    if (snapshot.strengths && typeof snapshot.strengths === 'object') store.strengths = snapshot.strengths;
    if (snapshot.project) updateSummary(snapshot.project);
    project.hydrated = true;
    void refreshConversationTitles();
  }

  function applyStudio(projectId, studio) {
    if (!studio || typeof studio !== 'object') return;
    const project = projectFor(projectId);
    project.studio = normalizeStudio({ studio }, project.cards, project.studio);
    project.cards = studioState?.mergeStudioCurrent
      ? studioState.mergeStudioCurrent(project.cards, project.studio.current, project.studio.now)
      : studioNowKind(project.studio) === 'real' && project.studio.current
        ? [...project.cards.filter((card) => card?.card_id !== project.studio.current.card_id), project.studio.current]
        : project.cards;
  }

  function statusForActive() {
    const project = activeProject();
    const studio = project?.studio;
    const progress = studioProgress(studio?.progress);
    if (store.settings.global_learning === 'paused') return t('learning_paused');
    if (progress?.phase === 'preparing') return t('preparing');
    if (progress?.phase === 'observed') return t('observed_activity');
    if (['preparing', 'queued'].includes(studio?.waiting?.reason)) return t('preparing');
    if (studio?.next_ready) return t('lesson_ready');
    return t('waiting');
  }

  function presentationForActive() {
    const raw = activeProject()?.studio?.presentation;
    return studioState?.describePresentation?.(raw, uiLocale()) || {
      epoch_id: null,
      phase: 'idle',
      stable_id: null,
      reason: 'idle',
      label: t('waiting'),
      detail: t('idle_copy'),
    };
  }

  function renderPipeline() {
    if (!activityPipeline) return;
    const presentation = presentationForActive();
    const order = ['observed', 'preparing', 'card-ready'];
    const labels = {
      observed: ['👁', t('observed_activity')],
      preparing: ['🍳', t('preparing')],
      'card-ready': ['🎴', t('lesson_ready')],
    };
    const activeIndex = order.indexOf(presentation.phase);
    activityPipeline.innerHTML = `<div class="pipeline-mascot" id="pipeline-mascot" aria-hidden="true"></div><div class="pipeline-steps">${order.map((phase, index) => {
      const state = phase === presentation.phase ? ' is-active' : activeIndex > index ? ' is-complete' : '';
      return `<span class="pipeline-step pipeline-step--${phase}${state}" data-pipeline-phase="${phase}"><b>${labels[phase][0]}</b><span>${escapeHtml(labels[phase][1])}</span></span>`;
    }).join('<i class="pipeline-arrow" aria-hidden="true">→</i>')}</div><p class="pipeline-detail" data-presentation-id="${escapeHtml(presentation.stable_id || '')}">${escapeHtml(presentation.detail || t('idle_copy'))}</p>`;
    const mascotState = window.OsmosisMascot?.stateForPresentation?.(presentation.phase)
      || (presentation.phase === 'observed' ? 'observing' : presentation.phase === 'preparing' ? 'preparing' : 'idle');
    const celebrationEpisode = store.celebration?.project_id === store.activeProjectId
      ? store.celebration.episode
      : null;
    window.OsmosisMascot?.mount?.(activityPipeline.querySelector('#pipeline-mascot'), {
      enabled: store.settings.mascot_enabled !== false,
      celebrationEpisode,
      state: mascotState,
    });
  }

  function celebrateCorrectAnswer(projectId, cardId) {
    if (typeof projectId !== 'string' || !projectId || typeof cardId !== 'string' || !cardId) return;
    const episode = `answer:${projectId}:${cardId}`;
    if (celebratedAnswerEpisodes.has(episode)) return;
    celebratedAnswerEpisodes.add(episode);
    if (celebratedAnswerEpisodes.size > 128) {
      celebratedAnswerEpisodes.delete(celebratedAnswerEpisodes.values().next().value);
    }
    store.celebration = { project_id: projectId, episode };
    window.setTimeout?.(() => {
      if (store.celebration?.episode !== episode) return;
      store.celebration = null;
      if (store.activeProjectId === projectId) renderPipeline();
    }, 1_300);
  }

  function conversationIds() {
    const ids = new Set();
    for (const project of store.projects.values()) {
      for (const card of [...project.cards, project.studio?.current].filter(Boolean)) {
        if (typeof card?.source?.conversation_id === 'string') ids.add(card.source.conversation_id);
      }
    }
    return [...ids].slice(0, 40);
  }

  async function refreshConversationTitles() {
    if (store.settings.local_conversation_titles !== true) {
      store.conversationTitles.clear();
      return;
    }
    const missing = conversationIds().filter((id) => !store.conversationTitles.has(id));
    if (missing.length === 0) return;
    try {
      const query = missing.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      const response = await fetch(`/conversation-titles?${query}`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload?.enabled !== true || !payload.titles || typeof payload.titles !== 'object') return;
      for (const [id, title] of Object.entries(payload.titles)) {
        if (typeof title === 'string') store.conversationTitles.set(id, title);
      }
      render();
    } catch {
      // Local labels are an optional layer; the Studio remains complete
      // without them and never exposes a raw session fallback.
    }
  }

  function renderActiveConversation() {
    if (!activeConversation) return;
    const source = activeProject()?.studio?.current?.source;
    const title = store.settings.local_conversation_titles === true
      && typeof source?.conversation_id === 'string'
      ? store.conversationTitles.get(source.conversation_id)
      : null;
    activeConversation.hidden = !title;
    activeConversation.textContent = title ? t('active_conversation', { title }) : '';
  }

  function renderConnection() {
    connection.textContent = statusForActive();
    connection.classList.toggle('live', store.settings.global_learning !== 'paused');
    connection.classList.toggle('paused', store.settings.global_learning === 'paused');
    modeFooter.textContent = `${store.settings.global_learning === 'paused' ? t('learning_off') : (uiLocale() === 'en' ? 'Live' : '实时')} · ${provider}`;
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
    const caption = active ? t('now_short') : answered && strength >= 2 ? t('learned') : answered ? t('revisit') : t('waiting_short');
    return `<li class="trail-item trail-item--${state}">
      <span class="trail-dot" aria-hidden="true"></span>
      <div><strong>${escapeHtml(card.concept_name || (uiLocale() === 'en' ? 'A useful concept' : '一个有用的概念'))}</strong><span>${escapeHtml(caption)}</span></div>
    </li>`;
  }

  function renderTrail() {
    const project = activeProject();
    if (!project) {
      trail.innerHTML = `<li class="trail-empty">${escapeHtml(t('choose_project'))}</li>`;
      trailNote.textContent = uiLocale() === 'en' ? 'Osmosis only keeps learning state for projects you choose to carry.' : 'Osmosis 只会为你选择保留的项目保存学习状态。';
      return;
    }
    const current = studioNowKind(project.studio) === 'real' ? project.studio?.current : null;
    const cards = realCards(project.cards);
    if (current && !cards.some((card) => card.card_id === current.card_id)) cards.push(current);
    cards.sort((left, right) => Date.parse(left.created_at || '') - Date.parse(right.created_at || ''));
    trail.innerHTML = cards.length
      ? cards.slice(-10).map((card) => trailItem(card, card.card_id === current?.card_id)).join('')
      : `<li class="trail-empty">${escapeHtml(t('trail_empty'))}</li>`;
    const next = project.studio?.next_ready;
    trailNote.textContent = next
      ? t('trail_next')
      : t('trail_note');
  }

  function projectDisplayNames(projects) {
    if (projectLabels?.displayNames) {
      return projectLabels.displayNames(projects, { fallback: uiLocale() === 'en' ? 'Project' : '项目' });
    }
    const names = new Map();
    const groups = new Map();
    for (const project of projects) {
      const key = String(project.summary.name || (uiLocale() === 'en' ? 'Project' : '项目'));
      const group = groups.get(key) || [];
      group.push(project);
      groups.set(key, group);
    }
    for (const [name, group] of groups) {
      group.sort((left, right) => left.summary.project_id.localeCompare(right.summary.project_id));
      group.forEach((project, index) => {
        names.set(project.summary.project_id, group.length > 1 ? `${name} ·${index + 1}` : name);
      });
    }
    return names;
  }

  function summaryTab(project, displayName) {
    const summary = project.summary;
    const active = summary.project_id === store.activeProjectId;
    const ready = store.readyProjectIds.has(summary.project_id);
    const waiting = Number(summary.unanswered_count || 0);
    const tooltipId = projectLabels?.tooltipId?.(summary.project_id)
      || `project-tooltip-${String(summary.project_id).replaceAll(/[^A-Za-z0-9_-]/g, '')}`;
    const fullPath = typeof summary.root === 'string' && summary.root ? summary.root : displayName;
    const accessiblePath = projectLabels?.accessiblePath?.(fullPath, displayName, uiLocale())
      || (uiLocale() === 'en' ? `Full path: ${fullPath}` : `完整路径：${fullPath}`);
    return `<div class="project-tab-wrap">
      <button class="project-tab${active ? ' is-active' : ''}" type="button" role="tab" aria-selected="${active}" aria-describedby="${escapeHtml(tooltipId)}" title="${escapeHtml(fullPath)}" data-project-tab="${escapeHtml(summary.project_id)}">
        <span class="project-tab-name">${escapeHtml(displayName)}</span><span class="sr-only" id="${escapeHtml(tooltipId)}">${escapeHtml(accessiblePath)}</span>
        ${ready ? `<span class="ready-dot" aria-label="${escapeHtml(uiLocale() === 'en' ? 'New activity' : '有新活动')}"></span>` : ''}
        ${waiting ? `<span class="project-count">${waiting}</span>` : ''}
      </button>
      <button class="project-icon-button" type="button" data-project-activity="${escapeHtml(summary.project_id)}" aria-label="${escapeHtml(uiLocale() === 'en' ? `Show activity for ${displayName}` : `查看 ${displayName} 的活动`)}">⌁</button>
      ${summary.archived
        ? `<button class="project-icon-button project-icon-button--restore" type="button" data-project-restore="${escapeHtml(summary.project_id)}" aria-label="${escapeHtml(uiLocale() === 'en' ? `Restore ${displayName}` : `恢复 ${displayName}`)}">↗</button>`
        : `<button class="project-icon-button project-icon-button--archive" type="button" data-project-archive="${escapeHtml(summary.project_id)}" aria-label="${escapeHtml(uiLocale() === 'en' ? `Archive ${displayName}` : `归档 ${displayName}`)}">×</button>`}
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
    const displayNames = projectDisplayNames(projects);
    const open = projects.filter((project) => !project.summary.archived || project.summary.project_id === store.activeProjectId);
    const archived = projects.filter((project) => project.summary.archived && project.summary.project_id !== store.activeProjectId);
    projectTabs.innerHTML = open.map((project) => summaryTab(project, displayNames.get(project.summary.project_id) || project.summary.name)).join('');
    archivedTabs.innerHTML = archived.map((project) => summaryTab(project, displayNames.get(project.summary.project_id) || project.summary.name)).join('');
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
    const inboxTitle = uiLocale() === 'en' ? `New project${pending.length === 1 ? '' : 's'}` : '新项目';
    const inboxCopy = uiLocale() === 'en'
      ? pending.length === 1 ? 'Osmosis is waiting for one project choice.' : `${pending.length} projects are waiting for your choice.`
      : pending.length === 1 ? '有一个项目在等你决定是否保留。' : `有 ${pending.length} 个项目在等你决定是否保留。`;
    activationInbox.innerHTML = `<div class="activation-inbox-copy"><p class="eyebrow">${escapeHtml(inboxTitle)}</p><p>${escapeHtml(inboxCopy)}</p></div>
      <div class="activation-inbox-actions">${pending.map((activation) => `<button class="activation-inbox-button${activation.project_id === activationTargetId() ? ' is-focused' : ''}" type="button" data-activation-open="${escapeHtml(activation.project_id)}"><span>${escapeHtml(activation.name || (uiLocale() === 'en' ? 'project' : '项目'))}</span>${activation.pending_report_count ? `<small>${activation.pending_report_count}${uiLocale() === 'en' ? ` held report${activation.pending_report_count === 1 ? '' : 's'}` : ' 条暂存汇报'}</small>` : `<small>${uiLocale() === 'en' ? 'Choose setup' : '选择设置'}</small>`}</button>`).join('')}</div>`;
    for (const button of activationInbox.querySelectorAll('[data-activation-open]')) {
      button.addEventListener('click', () => {
        store.activationProjectId = button.dataset.activationOpen;
        render();
      });
    }
  }

  function waitingMarkup(studio) {
    const waiting = studio?.waiting || studio;
    const progress = studioProgress(studio?.progress);
    const source = waiting?.source_provenance;
    const provenance = source
      ? `<p class="waiting-source">${sourceMarkup(source)}</p>`
      : '';
    const preparing = waiting?.reason === 'preparing';
    const queued = waiting?.reason === 'queued';
    const message = preparing
      ? (uiLocale() === 'en' ? 'Preparing a lesson from the newest useful activity.' : '正在根据最新的有用活动准备课程。')
      : queued
        ? (uiLocale() === 'en' ? 'Observed activity is waiting for a usable Next slot.' : '已观察到的活动正在等待下一课的可用位置。')
        : t('idle_copy');
    if (progress) {
      return `<article class="waiting-card waiting-card--progress">
        <span class="waiting-orb" aria-hidden="true"></span>
        ${progressMarkup(progress)}
        ${provenance}
      </article>`;
    }
    return `<article class="waiting-card">
      <span class="waiting-orb" aria-hidden="true"></span>
      <p class="eyebrow">${escapeHtml(preparing ? t('preparing') : queued ? (uiLocale() === 'en' ? 'Activity queued' : '活动已排队') : t('waiting'))}</p>
      <h3>${escapeHtml(message)}</h3>
      ${provenance}
    </article>`;
  }

  function nextControl(project, current, { warmup = false } = {}) {
    if (!current?.state?.answered) return '';
    const studio = project.studio || emptyStudio();
    const controlState = studioState?.nextControlState?.(studio)
      || (studio.next_ready ? 'ready' : ['preparing', 'queued'].includes(studio.waiting?.reason) ? 'preparing' : 'idle');
    if (controlState === 'ready') {
      return `<button class="next-lesson" type="button" data-next-lesson>${escapeHtml(t('next_lesson'))} <span aria-hidden="true">→</span></button>`;
    }
    const waiting = studio.waiting;
    const hasWork = controlState === 'preparing';
    const source = waiting?.source_provenance;
    if (warmup) {
      return `<div class="next-waiting">
        <button class="next-lesson next-lesson--muted" type="button" disabled>${hasWork ? t('preparing_next') : t('no_new_lesson')}</button>
      </div>`;
    }
    return `<div class="next-waiting">
        <button class="next-lesson next-lesson--muted" type="button" disabled>${hasWork ? t('preparing_next') : t('no_new_lesson')}</button>
        ${hasWork && source ? `<p>${sourceMarkup(source, { compact: true })}<span>${escapeHtml(sourceText(source))}</span></p>` : ''}
      </div>`;
  }

  function renderWarmupNow(project, card) {
    const pending = store.pendingAnswers.get(project.project_id);
    const answered = Boolean(card.state?.answered);
    const selectedIndex = answered ? card.state.chosen_index : pending?.cardId === card.warmup_id ? pending.index : null;
    const feedback = answered
      ? `<section class="answer-feedback ${card.state.correct ? 'correct' : 'incorrect'}" aria-live="polite">
          <p class="result-label">${escapeHtml(card.state.correct ? t('you_got_it') : t('correction'))}</p>
          <p>${escapeHtml(card.explanation || '')}</p>
          <p>${escapeHtml(t('warmup_feedback'))}</p>
        </section>`
      : '';
    const warmupLabels = uiLocale() === 'en' ? ['A', 'B', 'C'] : ['甲', '乙', '丙'];
    const choices = Array.isArray(card.options) ? card.options.map((option, index) => {
      const selected = selectedIndex === index;
      const resultClass = selected
        ? answered ? (card.state.correct ? ' selected correct' : ' selected incorrect') : ' pressed'
        : '';
      return `<button type="button" class="answer-option${resultClass}" data-answer-card="${escapeHtml(card.warmup_id)}" data-answer-index="${index}" aria-pressed="${selected}" ${answered || pending ? 'disabled' : ''}>
        <span class="answer-letter">${warmupLabels[index] || (uiLocale() === 'en' ? 'Option' : '选项')}</span><span>${escapeHtml(option)}</span>
      </button>`;
    }).join('') : '';
    return `<article class="lesson-card lesson-card--warmup" aria-label="${escapeHtml(t('warmup'))}">
      <div class="card-topline"><p class="card-kicker">${escapeHtml(t('warmup'))}</p><span class="now-status">${escapeHtml(t('one_small_question'))}</span></div>
      <p class="card-concept">${escapeHtml(card.title || card.concept_name || (uiLocale() === 'en' ? 'A concept you just used' : '刚刚用到的概念'))}</p>
      <p class="source-line source-line--observed-activity"><span class="provenance-label provenance-label--observed-activity">${escapeHtml(t('observed_activity'))}</span><span class="source-copy">${escapeHtml(t('warmup_copy'))}</span></p>
      ${progressMarkup(project.studio?.progress, { compact: true })}
      <p class="lesson-copy">${escapeHtml(card.lesson || '')}</p>
      <h3>${escapeHtml(card.question || '')}</h3>
      <div class="answers" aria-label="${escapeHtml(t('answer_choices'))}">${choices}</div>
      ${feedback}
      ${nextControl(project, card, { warmup: true })}
    </article>`;
  }

  function renderNow(project) {
    const activation = activationFor(project.project_id);
    if (store.settings.global_learning === 'paused') {
      return `<article class="waiting-card waiting-card--paused"><p class="eyebrow">${escapeHtml(t('learning_paused'))}</p><h3>${escapeHtml(uiLocale() === 'en' ? 'Osmosis is not capturing or making new lessons right now.' : 'Osmosis 现在不会捕捉活动或制作新课程。')}</h3><p>${escapeHtml(uiLocale() === 'en' ? 'Your trail and past lessons are still here whenever you want them.' : '你的轨迹和学过的课程仍然在这里。')}</p></article>`;
    }
    const warmup = currentWarmup(project);
    if (warmup) return renderWarmupNow(project, warmup);
    const card = project.studio?.current;
    if (!card) return waitingMarkup(project.studio);
    const pending = store.pendingAnswers.get(project.project_id);
    const answered = Boolean(card.state?.answered);
    const selectedIndex = answered ? card.state.chosen_index : pending?.cardId === card.card_id ? pending.index : null;
    const feedback = answered
      ? `<section class="answer-feedback ${card.state.correct ? 'correct' : 'incorrect'}" aria-live="polite">
          <p class="result-label">${escapeHtml(card.state.correct ? t('you_got_it') : t('correction'))}</p>
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
    const locale = activation?.lesson_locale === 'zh-CN' ? t('stage2') : '';
    return `<article class="lesson-card" aria-label="${escapeHtml(t('current_lesson'))}">
      <div class="card-topline"><p class="card-kicker">${escapeHtml(t('now'))}</p><span class="now-status">${escapeHtml(t('focused_question'))}</span></div>
      <p class="card-concept">${escapeHtml(card.concept_name)}</p>
      <p class="source-line source-line--${sourceKind(card.source)}">${sourceMarkup(card.source)}</p>
      ${progressMarkup(project.studio?.progress, { compact: true })}
      <p class="lesson-copy">${escapeHtml(card.lesson)}</p>
      <h3>${escapeHtml(card.question)}</h3>
      <div class="answers" aria-label="${escapeHtml(t('answer_choices'))}">${choices}</div>
      ${feedback}
      ${nextControl(project, card)}
      ${locale ? `<p class="locale-note">${escapeHtml(locale)}</p>` : ''}
    </article>`;
  }

  function renderReview(project) {
    const cards = realCards(project.cards).filter((card) => card.state?.answered);
    if (!cards.length) {
      return `<article class="waiting-card"><p class="eyebrow">${escapeHtml(t('past_lessons'))}</p><h3>${escapeHtml(t('review_empty'))}</h3><p>${escapeHtml(t('review_empty_copy'))}</p></article>`;
    }
    return `<section class="review-area" aria-label="${escapeHtml(t('past_lessons'))}">
      <header class="review-heading"><p class="eyebrow">${escapeHtml(t('past_lessons'))}</p><h3>${escapeHtml(t('review_heading'))}</h3></header>
      <ol class="review-list">${[...cards].reverse().map((card) => `<li class="review-card">
        <div><p class="card-concept">${escapeHtml(card.concept_name)}</p><p class="source-line source-line--${sourceKind(card.source)}">${sourceMarkup(card.source)}</p></div>
        <p>${escapeHtml(card.lesson)}</p>
        <p class="review-answer"><strong>${escapeHtml(card.state?.correct ? t('learned') : t('revisit'))}</strong> ${escapeHtml(card.explanation || '')}</p>
      </li>`).join('')}</ol>
    </section>`;
  }

  function renderActivation(activation) {
    const projectName = activation?.name || (uiLocale() === 'en' ? 'this project' : '这个项目');
    const held = Number(activation?.pending_report_count || 0);
    return `<article class="activation-card">
      <p class="eyebrow">${escapeHtml(t('first_activation'))}</p>
      <h3>${escapeHtml(t('enable_project', { project: projectName }))}</h3>
      <p>${escapeHtml(uiLocale() === 'en' ? `This is your call. Until you choose, agent reports${held ? ` (${held} held ${held === 1 ? 'milestone' : 'milestones'})` : ''} wait safely and ambient activity creates no project learning state.` : `由你决定。在你选择前，智能体汇报${held ? `（已有 ${held} 条暂存）` : ''}会安全等待，环境观察也不会为这个项目创建学习状态。`)}</p>
      <form id="activation-form" class="choice-form">
        <fieldset><legend>${escapeHtml(uiLocale() === 'en' ? 'Learning for this project' : '这个项目的学习方式')}</legend>
          <label class="choice-row"><input type="radio" name="carry" value="yes" checked><span><strong>${escapeHtml(t('yes_carry'))}</strong><small>${escapeHtml(t('yes_carry_copy'))}</small></span></label>
          <label class="choice-row"><input type="radio" name="carry" value="no"><span><strong>${escapeHtml(t('dont_carry'))}</strong><small>${escapeHtml(t('dont_carry_copy'))}</small></span></label>
        </fieldset>
        <fieldset><legend>${escapeHtml(t('language'))}</legend>
          <label class="select-label">${escapeHtml(t('language'))}<select name="lesson_locale"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
        </fieldset>
        <fieldset><legend>${escapeHtml(t('capture'))}</legend>
          <label class="choice-row"><input type="radio" name="capture_mode" value="agent-reports-only" checked><span><strong>${escapeHtml(t('reports_only'))}</strong><small>${escapeHtml(t('reports_only_copy'))}</small></span></label>
          <label class="choice-row"><input type="radio" name="capture_mode" value="experimental-ambient"><span><strong>${escapeHtml(t('experimental_ambient'))}</strong><small>${escapeHtml(t('experimental_ambient_copy'))}</small></span></label>
        </fieldset>
        <button class="primary-button" type="submit">${escapeHtml(t('save_choice'))}</button>
        ${activeProject() ? `<button class="activation-later" type="button" data-dismiss-activation>${escapeHtml(t('decide_later'))}</button>` : ''}
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
      cardStage.innerHTML = `<article class="waiting-card"><p class="eyebrow">${escapeHtml(uiLocale() === 'en' ? 'Learning Studio' : '学习工作台')}</p><h3>${escapeHtml(t('choose_project'))}</h3><p>${escapeHtml(uiLocale() === 'en' ? 'Only projects you choose to carry appear as learning channels.' : '只有你选择保留的项目会成为学习频道。')}</p></article>`;
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
    activityTitle.textContent = t('project_activity', { project: project.summary.name });
    const entries = project.activities.slice(-100).reverse();
    activityList.innerHTML = entries.length
      ? entries.map((entry) => `<li class="activity-entry"><span class="activity-state activity-state--${escapeHtml(entry.state || 'observed')}">${escapeHtml(entry.state || 'observed')}</span><span>${escapeHtml(entry.message || entry.reason || entry.event || t('activity'))}</span></li>`).join('')
      : `<li class="activity-empty">${escapeHtml(t('no_activity'))}</li>`;
  }

  function render() {
    refreshStaticCopy();
    renderTabs();
    renderActivationInbox();
    renderConnection();
    renderPipeline();
    renderActiveConversation();
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
          showToast(result.released
            ? (uiLocale() === 'en' ? 'Your held milestone is becoming a lesson in its project tab.' : '暂存的里程碑正在该项目标签中变成课程。')
            : (uiLocale() === 'en' ? 'This project is ready in its tab.' : '这个项目已经在它的标签中就绪。'));
        }
      } else {
        showToast(t('project_outside'));
      }
      render();
    } catch {
      showToast(uiLocale() === 'en' ? 'Osmosis could not save that choice. Please try again.' : '暂时无法保存这个选择，请稍后再试。');
    }
  }

  async function submitAnswer(projectId, cardId, index) {
    const project = projectFor(projectId);
    const warmup = currentWarmup(project);
    const isWarmup = Boolean(warmup);
    const card = warmup || project.studio?.current || cardById(project, cardId);
    const expectedCardId = isWarmup ? warmup.warmup_id : card?.card_id;
    if (!card || cardId !== expectedCardId || card.state?.answered || store.pendingAnswers.has(projectId)) return;
    noteInteraction(projectId);
    store.pendingAnswers.set(projectId, { cardId, index });
    renderStage();
    try {
      const response = await fetch(`/answer?project=${encodeURIComponent(projectId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card_id: cardId, chosen_index: index }),
      });
      if (isWarmup && response.status === 409) {
        store.pendingAnswers.delete(projectId);
        const refreshed = await refreshProjectSnapshot(projectId);
        showToast(refreshed ? t('warmup_replaced_refreshed') : t('warmup_replaced_reconnecting'));
        return;
      }
      if (!response.ok) throw new Error('Answer rejected');
      const result = await response.json();
      const answered = { ...card, state: { answered: true, chosen_index: index, correct: result.correct }, explanation: result.explanation };
      if (isWarmup || result.warmup === true) {
        // Warmups deliberately have no profile/tree/history side effects. The
        // frozen answer body is identical; only the server's `now.kind`
        // routes it to the isolated warmup state.
        if (studioNowKind(project.studio) === 'warmup' && project.studio.now.card_ref === cardId) {
          project.studio.current_warmup = answered;
          project.studio.current = answered;
        }
      } else {
        project.studio.current = answered;
        project.cards = project.cards.map((item) => item.card_id === cardId ? answered : item);
        store.strengths[answered.concept_id] = { ...(store.strengths[answered.concept_id] || {}), name: answered.concept_name, strength: result.strength };
      }
      store.pendingAnswers.delete(projectId);
      if (result.correct === true) celebrateCorrectAnswer(projectId, cardId);
      render();
    } catch {
      store.pendingAnswers.delete(projectId);
      renderStage();
      showToast(isWarmup
        ? (uiLocale() === 'en' ? 'This warmup answer could not be saved yet. Please try again.' : '这张热身题暂时无法保存，请稍后再试。')
        : (uiLocale() === 'en' ? 'Osmosis could not save that answer. Please try again.' : '暂时无法保存这次回答，请稍后再试。'));
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
          project.studio.current_warmup = null;
          project.studio.now = { kind: 'real', card_ref: result.card.card_id };
          project.studio.next_ready = false;
          project.cards = studioState?.mergeStudioCurrent
            ? studioState.mergeStudioCurrent(project.cards, result.card, project.studio.now)
            : [...project.cards.filter((card) => card.card_id !== result.card.card_id), result.card];
        }
        if (store.activeProjectId === projectId) render();
        return;
      }
      if (result.studio) applyStudio(projectId, result.studio);
      if (result.state === 'answer-required') showToast(uiLocale() === 'en' ? 'Answer the current question first.' : '请先回答当前问题。');
      else if (!auto) showToast(result.state === 'preparing' ? t('preparing_next') : t('no_new_lesson'));
      if (store.activeProjectId === projectId) render();
    } catch {
      if (!auto) showToast(uiLocale() === 'en' ? 'Osmosis could not open the next lesson yet.' : '暂时无法打开下一课。');
    }
  }

  async function refreshProjectSnapshot(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/snapshot`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Snapshot unavailable');
      applySnapshot(projectId, await response.json());
      if (store.activeProjectId === projectId) render();
      else renderTabs();
      return true;
    } catch {
      return false;
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
      if (store.activeProjectId === projectId) showToast(uiLocale() === 'en' ? 'Osmosis could not load that project yet.' : '暂时无法加载这个项目。');
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
          ? studioState.mergeStudioCurrent(realCards(body.cards), project.studio.current, project.studio.now)
          : studioNowKind(project.studio) === 'real' && project.studio.current
            ? [...realCards(body.cards).filter((card) => card.card_id !== project.studio.current.card_id), project.studio.current]
            : realCards(body.cards);
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
      project.activities.push({ event: 'drawer', message: uiLocale() === 'en' ? 'Activity history is temporarily unavailable.' : '活动记录暂时不可用。', state: 'failed' });
      renderActivity();
    }
  }

  async function archiveProject(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST' });
      if (!response.ok) throw new Error('Archive unavailable');
      updateSummary((await response.json()).project);
      renderTabs();
    } catch { showToast(t('archive_error')); }
  }

  async function restoreProject(projectId) {
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/unarchive`, { method: 'POST' });
      if (!response.ok) throw new Error('Restore unavailable');
      updateSummary((await response.json()).project);
      renderTabs();
    } catch { showToast(uiLocale() === 'en' ? 'Osmosis could not restore that project.' : '暂时无法恢复这个项目。'); }
  }

  function renderSettings() {
    const activation = activationFor();
    const paused = store.settings.global_learning === 'paused';
    const projectControls = activation
      ? `<section class="settings-group"><p class="settings-label">${escapeHtml(activation.name || (uiLocale() === 'en' ? 'This project' : '这个项目'))}</p>
          <label class="toggle-row"><span><strong>${escapeHtml(t('carry'))}</strong><small>${escapeHtml(activation.carry ? t('carried_copy') : t('uncarried_copy'))}</small></span><input id="setting-carry" type="checkbox" ${activation.carry ? 'checked' : ''}></label>
          <label class="select-label">${escapeHtml(t('capture'))}<select id="setting-capture"><option value="agent-reports-only" ${activation.capture_mode === 'agent-reports-only' ? 'selected' : ''}>${escapeHtml(t('reports_only'))}</option><option value="experimental-ambient" ${activation.capture_mode === 'experimental-ambient' ? 'selected' : ''}>${escapeHtml(t('experimental_ambient'))}</option></select></label>
          <label class="toggle-row"><span><strong>${escapeHtml(t('auto_advance'))}</strong><small>${escapeHtml(t('auto_advance_copy'))}</small></span><input id="setting-auto" type="checkbox" ${activation.auto_advance ? 'checked' : ''}></label>
        </section>`
      : `<p class="settings-copy">${escapeHtml(t('choose_project'))}</p>`;
    settingsContent.innerHTML = `<section class="settings-group">
      <p class="settings-label">${escapeHtml(t('global_learning'))}</p>
      <label class="toggle-row"><span><strong>${escapeHtml(paused ? t('learning_off') : t('learning_on'))}</strong><small>${escapeHtml(paused ? (uiLocale() === 'en' ? 'No new capture, generation, or delivery.' : '不会捕捉、生成或投递新课程。') : (uiLocale() === 'en' ? 'Osmosis can turn useful work into lessons.' : 'Osmosis 会把有用的工作变成课程。'))}</small></span><input id="setting-global" type="checkbox" ${paused ? '' : 'checked'}></label>
      <label class="select-label">${escapeHtml(t('ui_language'))}<select id="setting-ui-locale"><option value="zh-CN" ${uiLocale() === 'zh-CN' ? 'selected' : ''}>简体中文</option><option value="en" ${uiLocale() === 'en' ? 'selected' : ''}>English</option></select></label>
      <label class="select-label">${escapeHtml(t('language'))}<select id="setting-locale"><option value="en" ${store.settings.lesson_locale === 'en' ? 'selected' : ''}>English</option><option value="zh-CN" ${store.settings.lesson_locale === 'zh-CN' ? 'selected' : ''}>简体中文</option></select></label>
      <label class="toggle-row"><span><strong>${escapeHtml(t('mascot'))}</strong><small>${escapeHtml(t('mascot_copy'))}</small></span><input id="setting-mascot" type="checkbox" ${store.settings.mascot_enabled === false ? '' : 'checked'}></label>
      <label class="toggle-row"><span><strong>${escapeHtml(t('local_titles'))}</strong><small>${escapeHtml(t('local_titles_copy'))}</small></span><input id="setting-local-titles" type="checkbox" ${store.settings.local_conversation_titles === true ? 'checked' : ''}></label>
    </section>${projectControls}<button class="primary-button" id="save-settings" type="button">${escapeHtml(t('save'))}</button>`;
    settingsContent.querySelector('#save-settings')?.addEventListener('click', () => void saveSettings());
  }

  async function saveSettings() {
    const global = settingsContent.querySelector('#setting-global')?.checked ? 'on' : 'paused';
    const locale = settingsContent.querySelector('#setting-locale')?.value === 'zh-CN' ? 'zh-CN' : 'en';
    const uiLocaleValue = settingsContent.querySelector('#setting-ui-locale')?.value === 'en' ? 'en' : 'zh-CN';
    try {
      const response = await fetch('/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          global_learning: global,
          lesson_locale: locale,
          ui_locale: uiLocaleValue,
          mascot_enabled: Boolean(settingsContent.querySelector('#setting-mascot')?.checked),
          local_conversation_titles: Boolean(settingsContent.querySelector('#setting-local-titles')?.checked),
        }),
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
      showToast(t('saved'));
    } catch { showToast(t('settings_error')); }
  }

  function applySettings(value) {
    if (!value || typeof value !== 'object') return;
    store.settings = { ...store.settings, ...value };
    if (store.settings.local_conversation_titles !== true) store.conversationTitles.clear();
    refreshStaticCopy();
    void refreshConversationTitles();
    applyActivations(value.activation);
    applyActivations(value.activations);
    applyNotices(value.notices);
  }

  function updateConnectionStatus(status) {
    if (status?.provider) provider = status.provider;
    if (status?.state === 'failed') showToast(uiLocale() === 'en' ? 'Osmosis could not make a lesson from that activity. It will wait for the next useful signal.' : '暂时无法从这条活动制作课程，会等待下一条有用活动。');
    renderConnection();
  }

  function applyProjectEvent(type, payload) {
    const projectId = payload?.project_id;
    if (typeof projectId !== 'string') return;
    const project = projectFor(projectId);
    markActivity(projectId);
    if (type === 'card') {
      if (isWarmupCard(payload)) {
        // Warmup payloads travel only through the authoritative Studio
        // projection. A compatibility card event must never add one to the
        // real history/review surface.
        if (projectId === store.activeProjectId) render();
        else renderTabs();
        return;
      }
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
    events.addEventListener('error', () => { connection.textContent = t('connection_error'); connection.classList.remove('live'); });
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

  // This flag is only used by Node's DOM-free renderer regression tests. The
  // production page never enables it, and the hooks expose no network or
  // persistence surface beyond functions already running in this closure.
  if (window.__OSMOSIS_APP_TEST_HOOKS__ === true) {
    window.__OsmosisAppTest = Object.freeze({
      applySettings,
      celebrateCorrectAnswer,
      progressMarkup,
      renderPipeline,
      renderWarmupNow,
      store,
      submitAnswer,
    });
  }

  render();
  connectEvents();
})();
