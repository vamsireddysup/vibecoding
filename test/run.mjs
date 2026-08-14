/**
 * Test runner. No dependencies — `npm test` (or `node test/run.mjs`) works on a
 * fresh clone with nothing installed.
 *
 * These suites cover the logic that can run outside a browser: summary
 * normalization, storage, provider request shape and error handling, and the
 * recognition restart loop. The parts that genuinely need Chrome — tab capture,
 * the speaker re-pipe, real audio — are covered by the manual checklist in the
 * README instead.
 *
 * Suites run in separate processes because several of them install conflicting
 * globals (chrome, fetch, SpeechRecognition).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = ['summary', 'store', 'providers', 'speech', 'partial-json', 'dedupe', 'streaming'];

const runSuite = (name) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'single.mjs'), name], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code === 0));
  });

const results = [];
for (const suite of SUITES) {
  console.log(`\n${'='.repeat(52)}\n${suite}\n${'='.repeat(52)}`);
  results.push([suite, await runSuite(suite)]);
}

const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
console.log(`\n${'='.repeat(52)}`);
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`All ${results.length} suites passed.`);
