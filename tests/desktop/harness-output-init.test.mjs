import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

for (const [script, prefix] of [['run-desktop-tests.mjs', 'desktop-'], ['measure-performance.mjs', 'perf-']]) {
  test(`${script} initializes output with no parent and preserves previous runs`, async () => {
    const source = await fs.readFile(new URL(`../../scripts/${script}`, import.meta.url), 'utf8');
    // Execute the runner's actual filesystem initialization, excluding builds, fixtures and GUI startup.
    const initialization = source.match(/^(?:await fs\.mkdir[^\r\n]*[\r\n]+)?const output\s*=[\s\S]*?(?=^const (?:context|report)\s*=)/m)?.[0];
    assert.ok(initialization, 'runner output/project initialization must be exercised');
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'annotator-output-init-'));
    try {
      await assert.rejects(fs.stat(path.join(scratch, '.test-output')), { code: 'ENOENT' });
      const initializationEnv={...process.env};delete initializationEnv.ANNOTATOR_DESKTOP_OUTPUT;
      const initialize = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
        `import fs from 'node:fs/promises'; import path from 'node:path';\n${initialization}\nconsole.log(JSON.stringify({output,project}));`],
      { cwd: scratch, env:initializationEnv, encoding: 'utf8', windowsHide: true }));
      const first = initialize();
      assert.equal(path.dirname(first.output), path.join(scratch, '.test-output', ...(script==='run-desktop-tests.mjs'?['default-collaboration-v040','task5']:['fidelity-release'])));
      assert.ok(path.basename(first.output).startsWith(prefix));
      assert.equal((await fs.stat(first.project)).isDirectory(), true);
      const sentinel = path.join(first.output, 'previous-evidence.txt');
      await fs.writeFile(sentinel, 'preserve');
      const second = initialize();
      assert.notEqual(first.output, second.output);
      assert.equal((await fs.stat(second.project)).isDirectory(), true);
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
    } finally {
      assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
      assert.ok(path.basename(scratch).startsWith('annotator-output-init-'));
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
}

for (const suite of ['rulers-flow', 'compact-layout', 'classification-flow', 'feedback-flow']) {
  test(`${suite} uses a release-run-specific output directory`, async () => {
    const source = await fs.readFile(new URL(`./${suite}.test.mjs`, import.meta.url), 'utf8');
    const declaration = source.match(/const output\s*=\s*path\.resolve\([^;]+\);/)?.[0];
    assert.ok(declaration);
    const output = path.join(os.tmpdir(), 'annotator-release-output', suite);
    const actual = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import path from 'node:path';${declaration}console.log(output);`],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, ANNOTATOR_SUITE_OUTPUT: output } }).trim();
    assert.equal(actual, output);
    const env = { ...process.env }; delete env.ANNOTATOR_SUITE_OUTPUT;
    const standalone = () => execFileSync(process.execPath, ['--input-type=module', '-e',
      `import path from 'node:path';${declaration}console.log(output);`],
    { encoding: 'utf8', windowsHide: true, env }).trim();
    assert.notEqual(standalone(), standalone(), 'standalone runs must preserve prior reports too');
  });
}

for(const file of ['selection-flow.test.mjs','fidelity-flow.test.mjs','processed-flow.test.mjs','interaction-flow.test.mjs','task7-sharing.mjs']){
 test(`${file} honors generic owned suite output when legacy output is absent`,async()=>{
  const source=await fs.readFile(new URL(`./${file}`,import.meta.url),'utf8'),match=source.match(/const (output|parent)\s*=\s*path\.resolve\([^;]+\);/);assert.ok(match);
  const expected=path.join(os.tmpdir(),'annotator-generic-suite-output',file),env={...process.env,ANNOTATOR_SUITE_OUTPUT:expected};
  for(const name of ['ANNOTATOR_SELECTION_OUTPUT','ANNOTATOR_FIDELITY_OUTPUT','ANNOTATOR_PROCESSED_OUTPUT','ANNOTATOR_INTERACTION_OUTPUT','ANNOTATOR_SHARING_OUTPUT'])delete env[name];
  const actual=execFileSync(process.execPath,['--input-type=module','-e',`import path from 'node:path';const baseline=false;${match[0]}console.log(${match[1]});`],{encoding:'utf8',windowsHide:true,env}).trim();
  assert.equal(actual,file==='fidelity-flow.test.mjs'?path.join(expected,'native'):expected);
 });
}
