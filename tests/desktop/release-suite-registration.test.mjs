import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

test('sequential release runner preserves all original phases and runs all collaboration suites', async () => {
  const source = await fs.readFile(new URL('../../scripts/run-desktop-tests.mjs', import.meta.url), 'utf8');
  for (const phase of ['project', 'view-churn', 'spectral', 'restart', 'sharing', 'recovery',
    'selection-flow', 'rulers-flow', 'compact-layout', 'classification-flow', 'folder-scan',
    'folder-flow', 'source-import', 'feedback-flow', 'format-flow', 'fidelity-flow', 'processed-flow',
    'interaction-flow', 'sharing-flow', 'collaboration-native', 'collaboration-controls', 'collaboration-layers', 'default-collaboration', 'uuid-identities']) {
    assert.ok(source.includes(`'${phase}'`), `missing release phase ${phase}`);
  }
});
