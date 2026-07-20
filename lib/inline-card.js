'use strict';

const { strengthFor } = require('./mastery');

const INLINE_CARD_URI = 'ui://osmosis/card.html';
const DEFAULT_ANSWER_URL = 'http://127.0.0.1:4321/answer';
const DEFAULT_REFRESH_URL = 'http://127.0.0.1:4321/inline-card';
const EMPTY_STATE_COPY = '现在没有等待中的课程。';

const INLINE_COPY = {
  'zh-CN': {
    answer: '答案',
    carried: '已带入',
    choice: '选项',
    correct: '答对了',
    empty: EMPTY_STATE_COPY,
    empty_detail: '继续工作吧。下一条观察到的活动或智能体汇报会变成一节专注的课程；已经掌握的知识会随你带到下一个项目。',
    inline: 'Osmosis · 对话内课程',
    listening: 'Osmosis 正在留意',
    not_quite: '再想一想',
    observed_activity: '观察到的活动',
    observed_change: '观察到的改动',
    queue: '队列',
    reported: '智能体汇报',
    fallback: '答案仅在对话内临时显示；请到课程墙同步。',
    synced: '掌握度 {strength} / 2，已保存到你的课程墙。',
    tree: '已点亮',
  },
  en: {
    answer: 'Answer',
    carried: 'CARRIED OVER',
    choice: 'Choice',
    correct: 'Correct',
    empty: 'No lesson is waiting right now.',
    empty_detail: 'Keep building. Your next observed activity or agent report will become a focused lesson, while mastered knowledge stays carried over.',
    inline: 'Osmosis · inline',
    listening: 'Osmosis is listening',
    not_quite: 'Not quite',
    observed_activity: 'Observed activity',
    observed_change: 'Observed change',
    queue: 'Queue',
    reported: 'Reported by agent',
    fallback: 'answer synced on your wall only',
    synced: 'Mastery strength {strength} / 2 — saved to your wall.',
    tree: 'Tree lit',
  },
};

function localeFor(value) {
  return value === 'en' ? 'en' : 'zh-CN';
}

function inlineCopy(locale, key, values = {}) {
  const phrase = INLINE_COPY[localeFor(locale)][key] || INLINE_COPY['zh-CN'][key] || key;
  return phrase.replace(/\{([a-z_]+)\}/g, (_, name) => String(values[name] ?? ''));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function unansweredCards(state) {
  return Array.isArray(state?.cards)
    ? state.cards.filter((card) => card && !card.state?.answered)
    : [];
}

function currentStudioCard(state) {
  const currentId = state?.studio?.current_card_id;
  if (typeof currentId === 'string') {
    const current = Array.isArray(state?.cards)
      ? state.cards.find((card) => card?.card_id === currentId)
      : null;
    if (current && !current.state?.answered) {
      return current;
    }
  }
  return unansweredCards(state).at(-1) || null;
}

function inlineProgress(state) {
  const nodes = Array.isArray(state?.tree?.nodes) ? state.tree.nodes : [];
  const strengths = state?.strengths && typeof state.strengths === 'object' ? state.strengths : {};

  return {
    lit: nodes.reduce(
      (count, node) => count + (node && strengthFor(strengths, node.concept_id) >= 1 ? 1 : 0),
      0,
    ),
    queued: unansweredCards(state).length,
    total: nodes.length,
  };
}

function isCarriedOver(state, card) {
  const projectCreatedAt = Date.parse(state?.tree?.meta?.created_at || '');
  const masteredAt = Date.parse(state?.strengths?.[card.concept_id]?.updated_at || '');
  return (
    strengthFor(state?.strengths || {}, card.concept_id) >= 2 &&
    Number.isFinite(projectCreatedAt) &&
    Number.isFinite(masteredAt) &&
    masteredAt < projectCreatedAt
  );
}

function documentShell(body, script = '', uiLocale = 'zh-CN') {
  return `<!doctype html>
<html lang="${localeFor(uiLocale)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${localeFor(uiLocale) === 'en' ? 'Osmosis inline lesson' : 'Osmosis 对话内课程'}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #080c18;
        color: #f1f5ff;
      }
      * { box-sizing: border-box; }
      body {
        min-width: 280px;
        margin: 0;
        background:
          radial-gradient(circle at 88% 0%, rgba(91, 123, 206, 0.24), transparent 18rem),
          radial-gradient(circle at 0% 100%, rgba(226, 170, 65, 0.12), transparent 17rem),
          #080c18;
      }
      .shell { margin: 0 auto; max-width: 720px; padding: 20px; }
      .card {
        background: linear-gradient(145deg, rgba(30, 43, 75, 0.98), rgba(14, 21, 39, 0.98));
        border: 1px solid rgba(139, 165, 219, 0.34);
        border-radius: 18px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.3);
        overflow: hidden;
      }
      .topline {
        align-items: center;
        border-bottom: 1px solid rgba(139, 165, 219, 0.18);
        display: flex;
        gap: 10px;
        justify-content: space-between;
        padding: 15px 18px;
      }
      .brand, .badge, .source-label, .progress-label {
        font-size: 0.68rem;
        font-weight: 760;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .brand { color: #9eb9ff; }
      .badge {
        border: 1px solid rgba(250, 203, 105, 0.48);
        border-radius: 999px;
        color: #ffdda0;
        padding: 5px 8px;
      }
      .badge--live {
        border-color: rgba(143, 177, 246, 0.43);
        color: #bbd0ff;
      }
      .body { padding: 22px 18px 18px; }
      h1 { font-size: clamp(1.25rem, 4.5vw, 1.72rem); letter-spacing: -0.03em; margin: 0 0 12px; }
      .source {
        color: #aab8d6;
        font-size: 0.83rem;
        line-height: 1.5;
        margin: 0 0 18px;
      }
      .source-label {
        border: 1px solid transparent;
        border-radius: 999px;
        display: inline-block;
        font-size: 0.64rem;
        line-height: 1;
        margin-right: 7px;
        padding: 4px 6px;
        vertical-align: 1px;
      }
      .source-label--agent {
        background: rgba(100, 136, 220, 0.13);
        border-color: rgba(132, 163, 235, 0.37);
        color: #bad0ff;
      }
      .source-label--observed-change {
        background: rgba(67, 177, 156, 0.13);
        border-color: rgba(103, 213, 190, 0.42);
        color: #a8eadb;
      }
      .source-label--observed-activity {
        background: rgba(103, 139, 205, 0.13);
        border-color: rgba(139, 174, 235, 0.38);
        color: #c3d6ff;
      }
      .source--observed-change { color: #b7d9d3; }
      .source--observed-activity { color: #b8cae4; }
      .lesson { color: #edf2ff; font-size: 0.98rem; line-height: 1.65; margin: 0; }
      .question { color: #f6f8ff; font-size: 1rem; line-height: 1.48; margin: 24px 0 13px; }
      .choices { display: grid; gap: 9px; }
      .choice {
        background: rgba(14, 25, 49, 0.8);
        border: 1px solid rgba(115, 140, 192, 0.52);
        border-radius: 10px;
        color: #dce6ff;
        cursor: pointer;
        font: inherit;
        line-height: 1.42;
        padding: 12px 13px;
        text-align: left;
      }
      .choice:hover:not(:disabled) { background: rgba(35, 53, 91, 0.96); border-color: #a9c2ff; }
      .choice:focus-visible { outline: 2px solid #b4c9ff; outline-offset: 3px; }
      .choice:disabled { cursor: default; opacity: 0.82; }
      .choice.selected.correct { border-color: #68c897; color: #d4ffe6; }
      .choice.selected.incorrect { border-color: #ee99a9; color: #ffdae0; }
      .feedback {
        border-left: 3px solid #71809d;
        margin-top: 20px;
        padding: 3px 0 3px 13px;
      }
      .feedback.correct { border-color: #68c897; }
      .feedback.incorrect { border-color: #ee99a9; }
      .feedback-title { font-weight: 780; margin: 0 0 5px; }
      .feedback-copy { color: #d1dcf3; line-height: 1.56; margin: 0; }
      .sync-note { color: #aebddb; font-size: 0.78rem; line-height: 1.4; margin: 9px 0 0; }
      .progress {
        border-top: 1px solid rgba(139, 165, 219, 0.18);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 13px 18px;
      }
      .progress-item {
        background: rgba(11, 19, 37, 0.8);
        border: 1px solid rgba(137, 161, 214, 0.22);
        border-radius: 999px;
        color: #cedaf3;
        font-size: 0.77rem;
        padding: 6px 9px;
      }
      .progress-label { color: #f3cc80; margin-right: 4px; }
      .empty { padding: 31px 22px; text-align: center; }
      .empty p { color: #d9e3fb; line-height: 1.6; margin: 0 auto 8px; max-width: 31rem; }
      .empty small { color: #9cabc8; line-height: 1.5; }
      /* Keep the inline experiment recognizably part of the warm Studio. */
      :root { color-scheme: light; background: #fff7ea; color: #26332e; }
      body { background: #fff7ea; }
      .card { background: #fffdf8; border-color: #dfd2bd; box-shadow: 0 16px 36px rgba(80,58,29,.12); }
      .topline,.progress { border-color: #dfd2bd; }
      .brand { color: #257e70; }.badge { border-color: #c9972e; color: #a06f10; }.badge--live { border-color: #257e70; color: #257e70; }
      h1,.question { color: #18231f; }.source,.lesson,.feedback-copy { color: #4f5b54; }
      .choice { background: #fff2dc; border-color: #dfd2bd; color: #26332e; }.choice:hover:not(:disabled) { background: #dff3ed; border-color: #257e70; }.choice:focus-visible { outline-color: #265f9e; }
      .source-label--agent { background: #e3efff; border-color: #4f7dbd; color: #4f7dbd; }.source-label--observed-change { background: #dff3ed; border-color: #257e70; color: #257e70; }.source-label--observed-activity { background: #fff2dc; border-color: #dfd2bd; color: #68736d; }
      .progress-item { background: #fff2dc; border-color: #dfd2bd; color: #4f5b54; }.progress-label { color: #a06f10; }.empty p { color: #4f5b54; }.empty small,.sync-note { color: #68736d; }
    </style>
  </head>
  <body>
    ${body}
    ${script}
  </body>
</html>`;
}

function progressMarkup(progress, locale) {
  return `
    <footer class="progress" aria-label="${escapeHtml(localeFor(locale) === 'en' ? 'Learning progress' : '学习进度')}">
      <span class="progress-item" id="tree-progress"><span class="progress-label">${escapeHtml(inlineCopy(locale, 'tree'))}</span>${progress.lit} / ${progress.total}</span>
      <span class="progress-item" id="queue-progress"><span class="progress-label">${escapeHtml(inlineCopy(locale, 'queue'))}</span>${progress.queued}</span>
    </footer>`;
}

function emptyRefreshScript(refreshUrl) {
  const refreshData = jsonForScript({ refreshUrl: text(refreshUrl, DEFAULT_REFRESH_URL) });
  return `
    <script id="inline-refresh-data" type="application/json">${refreshData}</script>
    <script>
      (() => {
        'use strict';

        const inlineRefresh = JSON.parse(document.querySelector('#inline-refresh-data').textContent);

        function waitForLesson() {
          window.setTimeout(async () => {
            try {
              const response = await fetch(inlineRefresh.refreshUrl, { cache: 'no-store' });
              if (response.ok) {
                const html = await response.text();
                if (html.includes('data-osmosis-inline-card="ready"')) {
                  document.open();
                  document.write(html);
                  document.close();
                  return;
                }
              }
            } catch {
              // The local iframe fallback must never interrupt Codex work.
            }

            waitForLesson();
          }, 2_500);
        }

        waitForLesson();
      })();
    </script>`;
}

function renderInlineCard({ state = {}, answerUrl = DEFAULT_ANSWER_URL, refreshUrl = DEFAULT_REFRESH_URL, uiLocale = 'zh-CN' } = {}) {
  const locale = localeFor(uiLocale);
  const progress = inlineProgress(state);
  const card = currentStudioCard(state);

  if (!card) {
    return documentShell(`
      <main class="shell">
        <section class="card" data-osmosis-inline-card="pending" aria-label="${escapeHtml(locale === 'en' ? 'Osmosis inline lesson' : 'Osmosis 对话内课程')}">
          <div class="topline">
            <span class="brand">${escapeHtml(inlineCopy(locale, 'inline'))}</span>
            <span class="badge">${escapeHtml(inlineCopy(locale, 'carried'))}</span>
          </div>
          <div class="empty">
            <h1>${escapeHtml(inlineCopy(locale, 'listening'))}</h1>
            <p>${escapeHtml(inlineCopy(locale, 'empty'))}</p>
            <small>${escapeHtml(inlineCopy(locale, 'empty_detail'))}</small>
          </div>
          ${progressMarkup(progress, locale)}
        </section>
      </main>`,
      emptyRefreshScript(refreshUrl), locale,
    );
  }

  const source = card.source && typeof card.source === 'object' ? card.source : {};
  const sourceKind =
    source.kind === 'observed-change'
      ? 'observed-change'
      : source.kind === 'observed-activity' || source.kind === 'observed'
        ? 'observed-activity'
        : 'agent';
  const observed = sourceKind !== 'agent';
  const sourceLabel =
    sourceKind === 'observed-change'
      ? inlineCopy(locale, 'observed_change')
      : sourceKind === 'observed-activity'
        ? inlineCopy(locale, 'observed_activity')
        : inlineCopy(locale, 'reported');
  // Keep observed source headings generic so raw rollout identifiers cannot reach the iframe.
  const sourceTask = observed
    ? sourceKind === 'observed-change'
      ? (locale === 'en' ? 'Local Codex change' : '本地 Codex 改动')
      : (locale === 'en' ? 'Local Codex activity' : '本地 Codex 活动')
    : text(source.task, locale === 'en' ? 'Milestone' : '里程碑');
  const sourceWhat = observed
    ? sourceKind === 'observed-change'
      ? inlineCopy(locale, 'observed_change')
      : inlineCopy(locale, 'observed_activity')
    : text(source.what_i_did, locale === 'en' ? 'Your agent reported a milestone.' : '智能体汇报了一个里程碑。');
  const options = Array.isArray(card.options) ? card.options : [];
  const correctIndex = Number.isInteger(card.correct_index) && card.correct_index >= 0 && card.correct_index <= 2 ? card.correct_index : 0;
  const nodes = Array.isArray(state?.tree?.nodes) ? state.tree.nodes : [];
  const strength = strengthFor(state?.strengths || {}, card.concept_id);
  const inlineData = {
    answerUrl: text(answerUrl, DEFAULT_ANSWER_URL),
    cardId: text(card.card_id),
    cardInTree: nodes.some((node) => node?.concept_id === card.concept_id),
    cardWasLit: strength >= 1,
    correctIndex,
    explanation: text(card.explanation),
    copy: {
      correct: inlineCopy(locale, 'correct'),
      notQuite: inlineCopy(locale, 'not_quite'),
      synced: inlineCopy(locale, 'synced', { strength: '{strength}' }),
      tree: inlineCopy(locale, 'tree'),
      queue: inlineCopy(locale, 'queue'),
      fallback: inlineCopy(locale, 'fallback'),
    },
    progress,
  };
  const carriedOver = isCarriedOver(state, card);
  const choices = [0, 1, 2]
    .map(
      (index) =>
        `<button class="choice" type="button" data-answer-index="${index}" aria-label="${escapeHtml(`${inlineCopy(locale, 'answer')} ${index + 1}`)}">${escapeHtml(text(options[index], `${inlineCopy(locale, 'choice')} ${index + 1}`))}</button>`,
    )
    .join('');
  const script = `
    <script id="inline-card-data" type="application/json">${jsonForScript(inlineData)}</script>
    <script>
      (() => {
        'use strict';

        const inlineCard = JSON.parse(document.querySelector('#inline-card-data').textContent);
        const buttons = [...document.querySelectorAll('[data-answer-index]')];
        const feedback = document.querySelector('#answer-feedback');
        const title = document.querySelector('#answer-title');
        const explanation = document.querySelector('#answer-explanation');
        const syncNote = document.querySelector('#answer-sync-note');
        const treeProgress = document.querySelector('#tree-progress');
        const queueProgress = document.querySelector('#queue-progress');

        function showSelection(index, correct) {
          for (const button of buttons) {
            const choice = Number(button.dataset.answerIndex);
            button.disabled = true;
            button.classList.remove('selected', 'correct', 'incorrect');
            if (choice === index) {
              button.classList.add('selected', correct ? 'correct' : 'incorrect');
            }
          }
        }

        function updateProgress(strength) {
          let lit = inlineCard.progress.lit;
          if (inlineCard.cardInTree && !inlineCard.cardWasLit && strength >= 1) {
            lit += 1;
          }
          treeProgress.textContent = inlineCard.copy.tree + ' ' + lit + ' / ' + inlineCard.progress.total;
          queueProgress.textContent = inlineCard.copy.queue + ' ' + Math.max(0, inlineCard.progress.queued - 1);
        }

        function showFeedback(result, synced) {
          feedback.hidden = false;
          feedback.classList.remove('correct', 'incorrect');
          feedback.classList.add(result.correct ? 'correct' : 'incorrect');
          title.textContent = result.correct ? inlineCard.copy.correct : inlineCard.copy.notQuite;
          explanation.textContent = result.explanation;
          syncNote.textContent = synced
            ? inlineCard.copy.synced.replace('{strength}', result.strength)
            : inlineCard.copy.fallback;
        }

        async function answer(index) {
          showSelection(index, index === inlineCard.correctIndex);
          try {
            const response = await fetch(inlineCard.answerUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ card_id: inlineCard.cardId, chosen_index: index }),
            });
            if (!response.ok) {
              throw new Error('Answer was not accepted.');
            }
            const result = await response.json();
            if (
              typeof result?.correct !== 'boolean' ||
              typeof result?.explanation !== 'string' ||
              !Number.isInteger(result?.strength)
            ) {
              throw new Error('Answer response was invalid.');
            }
            showSelection(index, result.correct);
            showFeedback(result, true);
            updateProgress(result.strength);
          } catch {
            showFeedback(
              {
                correct: index === inlineCard.correctIndex,
                explanation: inlineCard.explanation,
                strength: null,
              },
              false,
            );
          }
        }

        for (const button of buttons) {
          button.addEventListener('click', () => {
            void answer(Number(button.dataset.answerIndex));
          });
        }
      })();
    </script>`;

  return documentShell(
    `
      <main class="shell">
        <section class="card" data-osmosis-inline-card="ready" aria-label="${escapeHtml(locale === 'en' ? 'Osmosis inline lesson' : 'Osmosis 对话内课程')}">
          <div class="topline">
          <span class="brand">${escapeHtml(inlineCopy(locale, 'inline'))}</span>
          <span class="badge${carriedOver ? '' : ' badge--live'}">${escapeHtml(carriedOver ? inlineCopy(locale, 'carried') : (locale === 'en' ? 'LIVE LESSON' : '实时课程'))}</span>
          </div>
          <div class="body">
            <h1>${escapeHtml(text(card.concept_name, locale === 'en' ? 'Your next concept' : '下一项概念'))}</h1>
            <p class="source source--${sourceKind}"><span class="source-label source-label--${sourceKind}">${sourceLabel}</span>${escapeHtml(sourceTask)} · ${escapeHtml(sourceWhat)}</p>
            <p class="lesson">${escapeHtml(text(card.lesson))}</p>
            <h2 class="question">${escapeHtml(text(card.question))}</h2>
            <div class="choices" aria-label="${escapeHtml(locale === 'en' ? 'Answer choices' : '答案选项')}">${choices}</div>
            <section class="feedback" id="answer-feedback" hidden aria-live="polite">
              <p class="feedback-title" id="answer-title"></p>
              <p class="feedback-copy" id="answer-explanation"></p>
              <p class="sync-note" id="answer-sync-note"></p>
            </section>
          </div>
      ${progressMarkup(progress, locale)}
        </section>
      </main>`,
    script, locale,
  );
}

module.exports = {
  DEFAULT_ANSWER_URL,
  DEFAULT_REFRESH_URL,
  EMPTY_STATE_COPY,
  INLINE_CARD_URI,
  currentStudioCard,
  inlineProgress,
  renderInlineCard,
  unansweredCards,
};
