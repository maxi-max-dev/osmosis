#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');

const { manualReceiptFor, recoverAnswerReceipt } = require('../lib/answer-recovery');

function usage() {
  return [
    'Usage: node bin/osmosis-recover-answer.js --receipt <receipt-id> --confirm [--profile-dir <directory>]',
    '   or: node bin/osmosis-recover-answer.js --manual --project <id> --card <id> --concept <id> --chosen-index <0-2> --correct|--incorrect --strength <0-2> --confirm',
    '',
    'Restores one operator-confirmed answer receipt after all Osmosis wall processes are stopped.',
    'It never infers answers from activity or delivery ledgers.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = {
    cardId: null,
    chosenIndex: null,
    conceptId: null,
    confirm: false,
    correct: null,
    manual: false,
    profileDir: process.env.OSMOSIS_PROFILE_DIR || path.join(os.homedir(), '.osmosis'),
    projectId: null,
    receiptId: null,
    strength: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { ...parsed, help: true };
    if (argument === '--confirm') {
      parsed.confirm = true;
      continue;
    }
    if (argument === '--manual') {
      parsed.manual = true;
      continue;
    }
    if (argument === '--correct' || argument === '--incorrect') {
      if (parsed.correct !== null) throw new Error('Choose exactly one of --correct or --incorrect.');
      parsed.correct = argument === '--correct';
      continue;
    }
    if (['--receipt', '--profile-dir', '--project', '--card', '--concept', '--chosen-index', '--strength'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
      if (argument === '--receipt') parsed.receiptId = value;
      else if (argument === '--profile-dir') parsed.profileDir = value;
      else if (argument === '--project') parsed.projectId = value;
      else if (argument === '--card') parsed.cardId = value;
      else if (argument === '--concept') parsed.conceptId = value;
      else if (argument === '--chosen-index') parsed.chosenIndex = Number.parseInt(value, 10);
      else parsed.strength = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${JSON.stringify(argument)}.`);
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (parsed.manual && parsed.receiptId) throw new Error('Use either --receipt or --manual fields, never both.');
  const manualReceipt = parsed.manual
    ? manualReceiptFor({
      cardId: parsed.cardId,
      chosenIndex: parsed.chosenIndex,
      conceptId: parsed.conceptId,
      correct: parsed.correct,
      projectId: parsed.projectId,
      resultingStrength: parsed.strength,
    })
    : null;
  const result = await recoverAnswerReceipt({
    confirm: parsed.confirm,
    manualReceipt,
    profileDir: parsed.profileDir,
    receiptId: parsed.receiptId,
  });
  process.stdout.write(`Restored answer receipt ${result.receipt_id} for ${result.concept_id} (strength ${result.resulting_strength}).\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Osmosis recovery: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, usage };
