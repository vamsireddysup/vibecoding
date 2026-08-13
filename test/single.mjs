/** Runs one suite in its own process, so global fakes cannot leak between them. */

import { report } from './harness.mjs';

const name = process.argv[2];
if (!name) {
  console.error('usage: node test/single.mjs <suite>');
  process.exit(2);
}

const { default: run } = await import(`./${name}.test.mjs`);
await run();
process.exit(report() ? 0 : 1);
