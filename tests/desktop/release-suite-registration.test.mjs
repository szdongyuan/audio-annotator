import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('sequential release runner preserves all original phases and runs all collaboration suites', async () => {
  const source = await fs.readFile(new URL('../../scripts/run-desktop-tests.mjs', import.meta.url), 'utf8');
  for (const phase of ['project', 'view-churn', 'spectral', 'restart', 'sharing', 'recovery',
    'selection-flow', 'rulers-flow', 'compact-layout', 'classification-flow', 'list-workflow', 'folder-scan',
    'folder-flow', 'source-import', 'feedback-flow', 'format-flow', 'fidelity-flow', 'processed-flow',
    'interaction-flow', 'sharing-flow', 'collaboration-native', 'collaboration-controls', 'collaboration-layers', 'default-collaboration', 'uuid-identities', 'media-folders', 'editing-workspace', 'examples', 'folder-navigation', 'folder-removal', 'native-responsiveness', 'collaborative-workspace', 'inspection-processing', 'inspection-usability', 'startup-modes', 'random-navigation', 'recycle-permanent-delete']) {
    assert.ok(source.includes(`'${phase}'`), `missing release phase ${phase}`);
  }
  assert.match(source, /\['examples','folder-navigation','folder-removal','native-responsiveness','collaborative-workspace','inspection-usability'\]\.includes\(suite\)\?\{ANNOTATOR_WORKSPACE_EXE:/);
  assert.ok(!source.includes("'switch-performance'"), 'manifest-dependent benchmark must remain opt-in');
});

test('offline guide links resolve in both installer resources and complete file updates', async () => {
  const config=JSON.parse(await fs.readFile(new URL('../../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  const update=await fs.readFile(new URL('../../scripts/package-update.mjs',import.meta.url),'utf8');
  const updateMappings=new Map([...update.matchAll(/\['(docs\/[^']+)', '([^']+)'\]/g)].map(match=>[match[2],match[1]]));
  const resources=new Map(Object.entries(config.bundle.resources).map(([source,target])=>[target,source]));
  const guide=await fs.readFile(new URL('../../docs/user-guide.md',import.meta.url),'utf8');
  const links=[...guide.matchAll(/\]\(([^):]+\.md)(?:#[^)]*)?\)/g)].map(match=>match[1]);assert.ok(links.length>0);
  for(const link of links){
    assert.ok(resources.has(link),`installer is missing linked guide ${link}`);
    assert.ok(updateMappings.has(link),`file update is missing linked guide ${link}`);
    const installerSource=path.resolve('src-tauri',resources.get(link));
    assert.equal(installerSource,path.resolve(updateMappings.get(link)),`resource source differs for ${link}`);
    assert.ok((await fs.stat(installerSource)).isFile());
  }
});
