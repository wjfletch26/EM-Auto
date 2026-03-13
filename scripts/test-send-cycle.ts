/**
 * Quick smoke test — runs one send cycle through the full pipeline.
 * Expects a test contact + test campaign in Google Sheets.
 *
 * Usage: npx tsx scripts/test-send-cycle.ts
 */

import { executeSendCycle } from '../src/engine/send-engine.js';

async function main() {
  console.log('Starting send cycle test...\n');

  try {
    const result = await executeSendCycle();
    console.log('\nSend cycle result:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('\nSend cycle failed:', err);
    process.exit(1);
  }
}

main();
