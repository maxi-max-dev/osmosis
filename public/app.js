(() => {
  'use strict';

  const state = { cards: [], tree: { nodes: [] }, strengths: {} };
  let pendingAnswer = null;
  let focusedCardId = null;
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

  function renderCards() {
    const card = currentCard();
    if (!card) {
      cardArea.innerHTML = '<div class="empty-card"><p>Waiting for your agent’s first milestone…</p><span>Osmosis will turn it into one focused lesson.</span></div>';
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

    cardArea.innerHTML = `
      <article class="lesson-card">
        <p class="source-line">From what your AI just did: “${escapeHtml(card.source.what_i_did)}”</p>
        <p class="card-concept">${escapeHtml(card.concept_name)}</p>
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
        ${nextCard ? '<button class="next-lesson" type="button" data-next-lesson>Next lesson</button>' : ''}
        ${waiting > 0 ? `<p class="queue-badge">${waiting} more waiting</p>` : ''}
      </article>`;

    for (const button of cardArea.querySelectorAll('[data-answer-card]')) {
      button.addEventListener('click', () => {
        void submitAnswer(button.dataset.answerCard, Number(button.dataset.answerIndex));
      });
    }
    cardArea.querySelector('[data-next-lesson]')?.addEventListener('click', () => {
      focusedCardId = nextUnansweredCard(card.card_id)?.card_id || null;
      renderCards();
    });
  }

  function renderTree() {
    const nodes = Array.isArray(state.tree.nodes) ? state.tree.nodes : [];
    treeEmpty.hidden = nodes.length > 0;
    treeList.innerHTML = nodes
      .map((node) => {
        const strength = state.strengths[node.concept_id]?.strength || 0;
        return `<li class="tree-node strength-${strength}">${escapeHtml(node.concept_name)}</li>`;
      })
      .join('');
  }

  function render() {
    renderCards();
    renderTree();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.setTimeout(() => toast.classList.remove('visible'), 3_000);
  }

  function applySnapshot(snapshot) {
    state.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    state.tree = snapshot.tree || { nodes: [] };
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
    showToast(`Osmosis queued: “${card.source.what_i_did}”`);
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

  fetch('/health')
    .then((response) => response.json())
    .then((info) => {
      modeFooter.textContent = `${info.mode} · ${info.provider}`;
    })
    .catch(() => {});
})();
