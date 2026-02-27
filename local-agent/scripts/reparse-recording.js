#!/usr/bin/env node
/**
 * Re-parse a recording session using the updated workflow parser.
 * Usage: node scripts/reparse-recording.js <session-dir>
 */
const path = require('path');
const dotenv = require('dotenv');

// Load .env from repo root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not found in .env');
  process.exit(1);
}

const sessionDir = process.argv[2];
if (!sessionDir) {
  console.error('Usage: node scripts/reparse-recording.js <session-dir>');
  process.exit(1);
}

const absDir = path.resolve(sessionDir);
console.log(`Re-parsing: ${absDir}`);

const { parseRecordingToWorkflow } = require('../dist/src/agent/workflow-parser');

parseRecordingToWorkflow(absDir)
  .then((workflow) => {
    console.log(`\nSuccess! Workflow: "${workflow.name}"`);
    console.log(`  ID: ${workflow.id}`);
    console.log(`  Steps: ${workflow.steps.length}`);
    console.log(`  Variables: ${workflow.variables.length}`);
    console.log(`  Rules: ${(workflow.rules || []).length}`);
    console.log(`\nSaved to: ${absDir}/workflow.json`);
  })
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
