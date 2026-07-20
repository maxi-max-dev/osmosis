'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { idlePresentation, projectLedgerEntries } = require('../lib/presentation-projection');
const { normalizeStudioContract } = require('../public/studio-state');

test('activity projection restores the same epoch across observed, preparing, and visible-card ledger truth', () => {
  const epoch = 'observation-abc';
  let projection = projectLedgerEntries(idlePresentation(), [{
    event: 'observed', activity_epoch_id: epoch, observation_id: epoch, reason: 'patch', at: '2026-07-20T00:00:00.000Z',
  }]);
  assert.deepEqual(projection, {
    epoch_id: epoch, phase: 'observed', reason: 'patch', stable_id: epoch, updated_at: '2026-07-20T00:00:00.000Z',
  });
  projection = projectLedgerEntries(projection, [{
    event: 'accept', source: 'observed', reason: 'studio-candidate', activity_epoch_id: epoch, report_id: 'report-abc', at: '2026-07-20T00:00:01.000Z',
  }]);
  assert.equal(projection.phase, 'preparing');
  assert.equal(projection.epoch_id, epoch);
  projection = projectLedgerEntries(projection, [{
    event: 'delivery', activity_epoch_id: epoch, card_id: 'card-abc', at: '2026-07-20T00:00:02.000Z',
  }]);
  assert.equal(projection.phase, 'card-ready');
  assert.equal(projection.stable_id, 'card-abc');

  const reconnected = normalizeStudioContract({
    current: null, current_warmup: null, next_ready: false,
    presentation: projection, waiting: { reason: 'idle', source_provenance: null },
  });
  assert.equal(reconnected.presentation.phase, 'card-ready');
  assert.equal(reconnected.presentation.epoch_id, epoch);
});

test('an unrelated failure cannot erase a currently displayed epoch', () => {
  const current = {
    epoch_id: 'epoch-kept', phase: 'preparing', reason: 'studio-candidate', stable_id: 'report-kept',
  };
  const unchanged = projectLedgerEntries(current, [{
    event: 'failure', activity_epoch_id: 'other-epoch', reason: 'provider-failed', at: '2026-07-20T01:00:00.000Z',
  }]);
  assert.equal(unchanged.epoch_id, 'epoch-kept');
  assert.equal(unchanged.phase, 'preparing');
  const idle = projectLedgerEntries(current, [{
    event: 'failure', activity_epoch_id: 'epoch-kept', reason: 'provider-failed', at: '2026-07-20T01:00:00.000Z',
  }]);
  assert.equal(idle.phase, 'idle');
});
