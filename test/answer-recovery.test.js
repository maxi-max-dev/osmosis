'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAnswerReceiptStore } = require('../lib/answer-receipt-store');
const { manualReceiptFor, recoverAnswerReceipt } = require('../lib/answer-recovery');
const { parseArgs } = require('../bin/osmosis-recover-answer');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-answer-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function receipt({ projectId = 'project-0123456789', cardId = 'card-1', conceptId = 'project-0123456789:running' } = {}) {
  return {
    answered_at: '2026-07-21T00:00:00.000Z',
    card_id: cardId,
    chosen_index: 0,
    concept_id: conceptId,
    concept_name: 'Running',
    correct: true,
    project_id: projectId,
    receipt_id: 'answer-receipt-0123456789',
    resulting_correct: 1,
    resulting_seen: 1,
    resulting_strength: 2,
  };
}

async function writeRecoverableProject(directory, value = receipt()) {
  const root = path.join(directory, 'project');
  const profileDir = path.join(directory, 'profile');
  await fs.mkdir(path.join(root, '.osmosis'), { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'projects.json'), `${JSON.stringify({
    version: 1,
    projects: [{ archived: false, last_activity_at: null, name: 'project', project_id: value.project_id, root, unanswered_count: 1 }],
  })}\n`);
  await fs.writeFile(path.join(root, '.osmosis', 'cards.json'), `${JSON.stringify({
    cards: [{
      card_id: value.card_id,
      concept_id: value.concept_id,
      concept_name: value.concept_name,
      correct_index: 0,
      explanation: 'A durable answer.',
      options: ['Correct', 'Wrong', 'Wrong'],
      question: 'Which answer?',
      state: { answered: false, chosen_index: null, correct: null },
    }],
  }, null, 2)}\n`);
  return { profileDir, root };
}

test('operator-confirmed recovery restores exactly one durable answer receipt without consulting a delivery ledger', async (t) => {
  const directory = await temporaryDirectory(t);
  const value = receipt();
  const { profileDir, root } = await writeRecoverableProject(directory, value);
  const receipts = createAnswerReceiptStore({ profileDir });
  await receipts.ensure(value);
  // This tempting activity record is deliberately irrelevant: recovery can
  // proceed only because the separate immutable answer receipt exists.
  await fs.mkdir(path.join(profileDir, 'ledger'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'ledger', `${value.project_id}.jsonl`), `${JSON.stringify({
    card_id: value.card_id,
    concept_id: value.concept_id,
    event: 'delivery',
    project_id: value.project_id,
    state: 'delivered',
  })}\n`);

  await assert.rejects(
    recoverAnswerReceipt({ profileDir, receiptId: value.receipt_id }),
    /--confirm/,
  );
  const restored = await recoverAnswerReceipt({ confirm: true, profileDir, receiptId: value.receipt_id });
  assert.deepEqual(restored, {
    card_restored: true,
    concept_id: value.concept_id,
    project_id: value.project_id,
    receipt_id: value.receipt_id,
    resulting_strength: 2,
  });

  const profile = JSON.parse(await fs.readFile(path.join(profileDir, 'profile.json'), 'utf8'));
  assert.deepEqual(profile[value.concept_id], {
    correct: 1,
    name: 'Running',
    seen: 1,
    strength: 2,
    updated_at: value.answered_at,
  });
  const cards = JSON.parse(await fs.readFile(path.join(root, '.osmosis', 'cards.json'), 'utf8'));
  assert.deepEqual(cards.cards[0].state, { answered: true, chosen_index: 0, correct: true });
  assert.equal(cards.cards[0].answer_receipt.receipt_id, value.receipt_id);
  await assert.rejects(
    recoverAnswerReceipt({ confirm: true, profileDir, receiptId: value.receipt_id }),
    /already been restored/,
  );
});

test('recovery refuses a delivery-ledger-only guess, but accepts one exact operator-confirmed historical declaration', async (t) => {
  const directory = await temporaryDirectory(t);
  const value = receipt();
  const { profileDir, root } = await writeRecoverableProject(directory, value);
  await fs.mkdir(path.join(profileDir, 'ledger'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'ledger', `${value.project_id}.jsonl`), `${JSON.stringify({
    card_id: value.card_id,
    concept_id: value.concept_id,
    event: 'delivery',
    project_id: value.project_id,
    state: 'delivered',
  })}\n`);

  await assert.rejects(
    recoverAnswerReceipt({ confirm: true, profileDir, receiptId: value.receipt_id }),
    /No durable answer receipt/,
  );
  const cards = JSON.parse(await fs.readFile(path.join(root, '.osmosis', 'cards.json'), 'utf8'));
  assert.equal(cards.cards[0].state.answered, false);
  await assert.rejects(fs.readFile(path.join(profileDir, 'profile.json'), 'utf8'), { code: 'ENOENT' });

  const manual = manualReceiptFor({
    cardId: value.card_id,
    chosenIndex: 0,
    conceptId: value.concept_id,
    correct: true,
    projectId: value.project_id,
    resultingStrength: 2,
  });
  const recovered = await recoverAnswerReceipt({ confirm: true, manualReceipt: manual, profileDir });
  assert.equal(recovered.card_restored, true);
  assert.match(recovered.receipt_id, /^manual-/);
  const recoveredCards = JSON.parse(await fs.readFile(path.join(root, '.osmosis', 'cards.json'), 'utf8'));
  assert.equal(recoveredCards.cards[0].state.answered, true);
  assert.equal((await createAnswerReceiptStore({ profileDir }).find(manual.receipt_id)).evidence, 'operator-confirmed-historical');

  const parsed = parseArgs(['--manual', '--project', value.project_id, '--card', value.card_id, '--concept', value.concept_id, '--chosen-index', '0', '--correct', '--strength', '2', '--confirm', '--profile-dir', profileDir]);
  assert.deepEqual(parsed, {
    cardId: value.card_id,
    chosenIndex: 0,
    conceptId: value.concept_id,
    confirm: true,
    correct: true,
    manual: true,
    profileDir,
    projectId: value.project_id,
    receiptId: null,
    strength: 2,
  });
});
