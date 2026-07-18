(() => {
  'use strict';

  const state = { cards: [], provider: 'none', tree: { meta: {}, nodes: [] }, strengths: {} };
  let pendingAnswer = null;
  let focusedCardId = null;
  let toastTimer = null;
  const deferredUpdates = [];

  const cardArea = document.querySelector('#card-area');
  const treeList = document.querySelector('#tree-list');
  const treeEmpty = document.querySelector('#tree-empty');
  const toast = document.querySelector('#toast');
  const connection = document.querySelector('#connection');
  const modeFooter = document.querySelector('#mode-footer');

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function cardById(cardId) {
    return state.cards.find((card) => card.card_id === cardId);
  }

  function currentCard() {
    const focused = focusedCardId && cardById(focusedCardId);
    if (focused) {
      return focused;
    }
    return state.cards.find((card) => !card.state.answered) || state.cards.at(-1);
  }

  function nextUnansweredCard(excludingCardId) {
    return state.cards.find((card) => !card.state.answered && card.card_id !== excludingCardId);
  }

  function sourceText(card) {
    if (sourceKind(card) === 'observed-change') {
      return 'Osmosis observed a local Codex change.';
    }
    if (sourceKind(card) === 'observed-activity') {
      return 'Osmosis observed local Codex activity.';
    }
    return card.source?.what_i_did || 'Your agent reported a milestone.';
  }

  function sourceKind(card) {
    if (card.source?.kind === 'observed-change') {
      return 'observed-change';
    }
    if (card.source?.kind === 'observed-activity' || card.source?.kind === 'observed') {
      // Legacy observed cards were not precise enough to prove a patch succeeded.
      return 'observed-activity';
    }
    return 'agent';
  }

  function sourceLabel(card) {
    if (sourceKind(card) === 'observed-change') {
      return 'Observed change';
    }
    if (sourceKind(card) === 'observed-activity') {
      return 'Observed activity';
    }
    return 'Reported by agent';
  }

  function sourceLead(card) {
    if (sourceKind(card) === 'observed-change') {
      return 'From a local Codex change:';
    }
    if (sourceKind(card) === 'observed-activity') {
      return 'From local Codex activity:';
    }
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

    if (!answered) {
      return `<div class="card-summary card-summary--waiting">${content}</div>`;
    }

    return `<button class="card-summary" type="button" data-focus-card="${escapeHtml(card.card_id)}">${content}</button>`;
  }

  function renderCards() {
    const card = currentCard();
    if (!card) {
      cardArea.innerHTML = `
        <div class="empty-card">
          <p>Waiting for your first learning signal…</p>
          <span>Osmosis turns a local change or agent report into one focused lesson.</span>
        </div>`;
      return;
    }

    const answered = Boolean(card.state.answered);
    const selectedIndex = answered ? card.state.chosen_index : pendingAnswer?.cardId === card.card_id ? pendingAnswer.index : null;
    const feedback = answered
      ? `
        <section class="answer-feedback ${card.state.correct ? 'correct' : 'incorrect'}" aria-live="polite">
          <p class="result-label">${card.state.correct ? 'Correct' : 'Not quite'}</p>
          <p>${escapeHtml(card.explanation || '')}</p>
        </section>`
      : '';
    const nextCard = answered ? nextUnansweredCard(card.card_id) : null;
    const waiting = state.cards.filter((item) => !item.state.answered && item.card_id !== card.card_id).length;
    const history = state.cards.filter((item) => item.card_id !== card.card_id).reverse();

    cardArea.innerHTML = `
      <section class="card-feed" aria-label="Lesson card feed">
        <article class="lesson-card">
          <div class="card-topline">
            <p class="card-concept">${escapeHtml(card.concept_name)}</p>
            ${waiting > 0 ? `<p class="queue-badge">${waiting} more waiting</p>` : ''}
          </div>
          <p class="source-line source-line--${sourceKind(card)}">
            <span class="provenance-label provenance-label--${sourceKind(card)}">${sourceLabel(card)}</span>
            <span>${sourceLead(card)} "${escapeHtml(sourceText(card))}"</span>
          </p>
          <p class="lesson-copy">${escapeHtml(card.lesson)}</p>
          <h3>${escapeHtml(card.question)}</h3>
          <div class="answers" aria-label="Answer choices">
            ${card.options
              .map((option, index) => {
                const selected = selectedIndex === index;
                const answerClass = selected
                  ? answered
                    ? card.state.correct
                      ? ' selected correct'
                      : ' selected incorrect'
                    : ' pressed'
                  : '';
                const disabled = answered || Boolean(pendingAnswer);
                return `<button type="button" class="answer-option${answerClass}" data-answer-card="${escapeHtml(card.card_id)}" data-answer-index="${index}" aria-pressed="${selected}" ${disabled ? 'disabled' : ''}>${escapeHtml(option)}</button>`;
              })
              .join('')}
          </div>
          ${feedback}
          ${nextCard ? '<button class="next-lesson" type="button" data-next-lesson>Continue to next lesson</button>' : ''}
        </article>
        ${history.length > 0 ? `<div class="card-history" aria-label="Earlier lessons">${history.map(cardSummary).join('')}</div>` : ''}
      </section>`;

    for (const button of cardArea.querySelectorAll('[data-answer-card]')) {
      button.addEventListener('click', () => {
        void submitAnswer(button.dataset.answerCard, Number(button.dataset.answerIndex));
      });
    }
    cardArea.querySelector('[data-next-lesson]')?.addEventListener('click', () => {
      focusedCardId = nextUnansweredCard(card.card_id)?.card_id || null;
      renderCards();
    });
    for (const summary of cardArea.querySelectorAll('[data-focus-card]')) {
      summary.addEventListener('click', () => {
        focusedCardId = summary.dataset.focusCard;
        renderCards();
      });
    }
  }

  function isCarriedOver(node, strength) {
    const projectCreatedAt = Date.parse(state.tree.meta?.created_at || '');
    const masteredAt = Date.parse(state.strengths[node.concept_id]?.updated_at || '');
    return strength >= 2 && Number.isFinite(projectCreatedAt) && Number.isFinite(masteredAt) && masteredAt < projectCreatedAt;
  }

  function treeNodeMarkup(node, childrenByParent, visited) {
    if (visited.has(node.concept_id)) {
      return '';
    }
    visited.add(node.concept_id);

    const children = childrenByParent.get(node.concept_id) || [];
    const strength = Number(state.strengths[node.concept_id]?.strength || 0);
    const branch = children.length > 0;
    const carriedOver = !branch && isCarriedOver(node, strength);
    const visualState = carriedOver ? 'carried' : strength >= 2 ? 'mastered' : strength >= 1 ? 'learning' : branch ? 'branch' : 'dim';
    const childMarkup = children.map((child) => treeNodeMarkup(child, childrenByParent, visited)).join('');

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
    const nodes = Array.isArray(state.tree.nodes) ? state.tree.nodes : [];
    treeEmpty.hidden = nodes.length > 0;
    if (nodes.length === 0) {
      treeEmpty.textContent =
        state.provider === 'none'
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
    let markup = roots.map((node) => treeNodeMarkup(node, childrenByParent, visited)).join('');
    markup += nodes
      .filter((node) => !visited.has(node.concept_id))
      .map((node) => treeNodeMarkup(node, childrenByParent, visited))
      .join('');
    treeList.innerHTML = markup;
  }

  function render() {
    renderCards();
    renderTree();
  }

  function showToast(message) {
    if (toastTimer) {
      window.clearTimeout(toastTimer);
    }
    toast.textContent = message;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3_000);
  }

  function updateConnectionStatus(status) {
    const provider = status.provider || state.provider;
    if (provider === 'codex' && status.state === 'generating') {
      connection.textContent = 'Generating (this provider is slower).';
      connection.classList.add('live');
      return;
    }

    if (status.state === 'pacing') {
      connection.textContent = 'Spacing lessons…';
      connection.classList.add('live');
      return;
    }

    if (['idle', 'skipped', 'queue-full', 'replay-complete'].includes(status.state)) {
      connection.textContent = 'Live';
      connection.classList.add('live');
    }
  }

  function applySnapshot(snapshot) {
    state.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    state.tree = snapshot.tree || { meta: {}, nodes: [] };
    state.strengths = snapshot.strengths || {};
    if (focusedCardId && !cardById(focusedCardId)) {
      focusedCardId = null;
    }
  }

  function applyCard(card) {
    state.cards = state.cards.filter((item) => item.card_id !== card.card_id);
    state.cards.push(card);
  }

  function applyStrength(update) {
    const current = state.strengths[update.concept_id] || {};
    state.strengths[update.concept_id] = { ...current, strength: update.strength };
  }

  function deferOrApply(update) {
    if (pendingAnswer) {
      deferredUpdates.push(update);
      return;
    }
    update();
    render();
  }

  function flushDeferredUpdates() {
    while (deferredUpdates.length > 0) {
      deferredUpdates.shift()();
    }
  }

  async function submitAnswer(cardId, index) {
    if (pendingAnswer) {
      return;
    }

    const card = cardById(cardId);
    if (!card || card.state.answered) {
      return;
    }

    pendingAnswer = { cardId, index };
    focusedCardId = cardId;
    renderCards();

    try {
      const response = await fetch('/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, chosen_index: index }),
      });
      if (!response.ok) {
        throw new Error('The answer request was not accepted.');
      }

      const result = await response.json();
      card.state = { answered: true, chosen_index: index, correct: result.correct };
      card.explanation = result.explanation;
      state.strengths[card.concept_id] = {
        ...(state.strengths[card.concept_id] || {}),
        name: card.concept_name,
        strength: result.strength,
      };
      pendingAnswer = null;
      flushDeferredUpdates();
      render();
    } catch {
      pendingAnswer = null;
      deferredUpdates.length = 0;
      renderCards();
      showToast('Osmosis could not save that answer. Please try again.');
    }
  }

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
    const snapshot = JSON.parse(event.data);
    deferOrApply(() => applySnapshot(snapshot));
  });
  events.addEventListener('card', (event) => {
    const card = JSON.parse(event.data);
    deferOrApply(() => applyCard(card));
  });
  events.addEventListener('strength', (event) => {
    const update = JSON.parse(event.data);
    deferOrApply(() => applyStrength(update));
  });
  events.addEventListener('tree', (event) => {
    const tree = JSON.parse(event.data);
    deferOrApply(() => {
      state.tree = tree;
    });
  });
  events.addEventListener('status', (event) => {
    const status = JSON.parse(event.data);
    updateConnectionStatus(status);
    if (status.report?.what_i_did) {
      const observed =
        status.report.source === 'observed' ||
        ['observed', 'observed-change', 'observed-activity'].includes(status.report.source?.kind);
      if (observed) {
        const observedChange =
          status.report.observed_kind === 'change' || status.report.source?.kind === 'observed-change';
        showToast(observedChange ? 'Osmosis observed a local change.' : 'Osmosis observed local activity.');
      } else {
        showToast(`Codex reported: "${status.report.what_i_did}"`);
      }
    }
  });

  fetch('/health')
    .then((response) => response.json())
    .then((info) => {
      state.provider = info.provider;
      modeFooter.textContent = `${info.mode} · ${info.provider}`;
      renderTree();
    })
    .catch(() => {});
})();
