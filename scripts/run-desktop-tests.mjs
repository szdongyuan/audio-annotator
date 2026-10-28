import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { start } from '../tests/desktop/harness.mjs';
import { projectFlow, restartFlow, recoveryFlow } from '../tests/desktop/project-flow.test.mjs';
import { spectralFlow } from '../tests/desktop/spectral-flow.test.mjs';
import { sharingFlow } from '../tests/desktop/sharing-flow.test.mjs';
import { viewChurn } from '../tests/desktop/view-churn.test.mjs';
function command(cmd, args) { const r = spawnSync(cmd, args, { stdio: 'inherit', shell: cmd.endsWith('.cmd'), windowsHide: true }); if (r.status !== 0) throw new Error(`${cmd} failed: ${r.status}`); }
command(process.execPath, ['--test','tests/desktop/harness-lifecycle.test.mjs','tests/desktop/harness-menu.test.mjs','tests/desktop/harness-output-init.test.mjs','tests/desktop/release-suite-registration.test.mjs']);
command('pwsh', ['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/setup-webdriver.ps1']);
if (!process.argv.includes('--skip-build')) command('npm.cmd', ['run','tauri','--','build','--debug','--no-bundle','--features','e2e','--config','src-tauri/tauri.e2e.conf.json']);
await fs.mkdir(path.resolve(process.env.ANNOTATOR_DESKTOP_OUTPUT ?? '.test-output/default-collaboration-v040/task5'), { recursive: true });
const output = await fs.realpath(await fs.mkdtemp(path.resolve(process.env.ANNOTATOR_DESKTOP_OUTPUT ?? '.test-output/default-collaboration-v040/task5', 'desktop-')));
const project = path.join(output, 'project'); await fs.mkdir(project);
const context = { output, project };
const paths = {
  '新建项目 · 选择空文件夹': [project],
  '打开项目': [path.join(project,'collaboration.json'),path.join(output,'recovery-project','project.json'),path.join(output,'recovery-project','project.json')],
  '': [['six.flac','mono16.wav','stereo.mp3'].map(n=>path.resolve('tests/fixtures/audio',n)),...['six.flac','mono16.wav','stereo.mp3'].map(n=>path.resolve('tests/fixtures/audio',n))],
  '分享 · 保存到本机': [path.join(output,'share.json'),path.join(output,'share.zip')],
  '导入标注文件或完整项目包': [path.join(output,'share.json'),path.join(output,'share.zip')],
  '选择新项目的存放位置 · 将创建独立子文件夹': [output,output],
};
process.env.ANNOTATOR_FIDELITY_OUTPUT=path.join(output,'fidelity');
process.env.ANNOTATOR_SELECTION_OUTPUT=path.join(output,'selection');
process.env.ANNOTATOR_PROCESSED_OUTPUT=path.join(output,'processed');
process.env.ANNOTATOR_INTERACTION_OUTPUT=path.join(output,'interaction');
process.env.ANNOTATOR_SHARING_OUTPUT=path.join(output,'sharing');
const report = { method: 'Selenium → official tauri-driver → matching Microsoft EdgeDriver → actual Tauri executable. Native picker paths are preselected in the e2e feature; UI workflows use WebDriver pointer/keyboard. Folder-scan separately tests native IPC contracts; targeted transport/Channel failure injections are identified in suite reports. No store mutation substitutes for UI acceptance. Subjective listening and physical picker interaction are separate release checks.', checks: [], output };
let h;
try {
  h = await start(paths, output);
  for (const [name, run] of [['project',projectFlow],['view-churn',viewChurn],['spectral',spectralFlow]]) { console.log(`Running ${name}`); await run(h,context); report.checks.push({name,passed:true,...(name==='view-churn'?context.churn:{})}); console.log(`PASS ${name}`); }
  await h.quit(); h = await start({...paths,'':paths[''].slice(1)}, output);
  for (const [name, run] of [['restart',restartFlow],['sharing',sharingFlow],['recovery',recoveryFlow]]) { console.log(`Running ${name}`); await run(h,context); report.checks.push({name,passed:true}); console.log(`PASS ${name}`); }
} catch(error) { report.error = error.stack; await h?.screenshot('failure').catch(()=>{}); console.error(error); process.exitCode=1; }
finally { await h?.quit().catch(()=>{}); await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2)); }
// Each suite owns a fresh process and retires it before the next acquires the ports.
// Keep the six original phases above, including a full process restart and 300-view churn.
if (!process.exitCode) {
  for (const suite of ['selection-flow', 'rulers-flow', 'compact-layout', 'classification-flow', 'list-workflow', 'folder-scan', 'folder-flow', 'source-import', 'feedback-flow', 'format-flow', 'fidelity-flow', 'processed-flow', 'interaction-flow', 'sharing-flow', 'collaboration-native', 'collaboration-controls', 'collaboration-layers', 'default-collaboration', 'uuid-identities', 'media-folders', 'editing-workspace', 'examples', 'folder-navigation', 'folder-removal', 'native-responsiveness']) {
    console.log(`Running ${suite}`);
    const result = spawnSync(process.execPath, [`tests/desktop/${suite}.test.mjs`], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ANNOTATOR_SUITE_OUTPUT: path.join(output, suite), ...(['examples','folder-navigation','folder-removal','native-responsiveness'].includes(suite)?{ANNOTATOR_WORKSPACE_EXE:process.env.ANNOTATOR_WORKSPACE_EXE??path.resolve('target/debug/annotator-desktop.exe')}: {}), ...(suite==='examples'?{ANNOTATOR_EXAMPLES_OUTPUT:path.join(output,suite)}: {}) } });
    report.checks.push({ name: suite, passed: result.status === 0 });
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
}

