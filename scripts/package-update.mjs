import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [buildArgument, outputArgument, fromVersion = '0.7.0', revision = ''] = process.argv.slice(2);
if (!buildArgument || !outputArgument) throw Error('Usage: node scripts/package-update.mjs <production-release-directory> <new-delivery-directory> [previous-version] [revision: re1, re2, ...]');
const build = path.resolve(buildArgument), output = path.resolve(outputArgument), version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
assert.match(version, /^\d+\.\d+\.\d+$/); assert.match(fromVersion, /^\d+\.\d+\.\d+$/);
assert.match(revision, /^(?:re[1-9][0-9]*)?$/, 'Revision must be re1, re2, ...');
if (!revision) assert.notEqual(version, fromVersion, 'Same-version rebuilds require an explicit revision');
const releaseLabel = revision ? `${version}-${revision}` : version;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
assert.equal(path.basename(build), 'release', 'A normal production release directory is required');
if (fs.existsSync(output)) throw Error('Refusing to replace an existing delivery directory');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function list(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Resource links are not supported');
    return entry.isDirectory() ? list(path.join(root, entry.name), prefix + entry.name + '/') : [prefix + entry.name];
  });
}
const executable = path.join(build, 'annotator-desktop.exe'), bytes = fs.readFileSync(executable);
for (const marker of ['ANNOTATOR_E2E', 'ANNOTATOR_IMPORT_SOURCE_FIXTURES', 'Injected folder publication failure']) assert.ok(!bytes.includes(Buffer.from(marker)) && !bytes.includes(Buffer.from(marker, 'utf16le')), 'Test executable cannot be packaged');
const builtVersion = execFileSync('pwsh', ['-NoProfile', '-Command', '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:UPDATE_EXE).ProductVersion'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UPDATE_EXE: executable } }).trim();
assert.equal(builtVersion, version);
const resources = [...list('licenses').map(file => ['licenses/' + file, 'licenses/' + file]), ['docs/user-guide.md', 'user-guide.md'], ['docs/examples.md', 'examples.md'], ['docs/third-party.md', 'third-party.md']];
for (const [source, relative] of resources) assert.equal(hash(source), hash(path.join(build, relative)), 'Built resource mismatch: ' + relative);
fs.mkdirSync(output, { recursive: false });
const payload = ['annotator-desktop.exe']; fs.copyFileSync(executable, path.join(output, payload[0]));
for (const [source, relative] of resources) { const destination = path.join(output, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); payload.push(relative); }
const information = { kind: 'audio-annotator-file-update', fromVersion, toVersion: version, revision: revision || null, releaseLabel, sourceCommit, executable: 'annotator-desktop.exe', installation: 'Close the application; extract these files over the existing program directory. Do not replace or move project folders or user data.', formats: { project: 3, collaboration: { newProjects: 5, supported: [5, 6], upgradeTo: 6, upgradeTrigger: 'first confirmed successful permanent deletion', olderClientsCannotOpenUpgradedProjects: true }, authorLayer: 2, privateWorkspace: 2, exchange: 4, dsp: 2, organization: 1, catalog: 2, analysis: 1 }, includesAudioOrPersonalData: false };
fs.writeFileSync(path.join(output, 'UPDATE-INFORMATION.json'), JSON.stringify(information, null, 2) + '\n'); payload.push('UPDATE-INFORMATION.json');
fs.writeFileSync(path.join(output, 'UPDATE-README.txt'), `音频标注 ${fromVersion} → ${releaseLabel} 更新包\n\n1. 保存并同步，处理尚未解决的修改，然后关闭所有软件窗口。\n2. 找到包含 annotator-desktop.exe 的原程序目录，可先备份程序及资源。\n3. 将 ZIP 中全部文件解压覆盖程序目录，保留项目和音频数据位置。\n4. 启动原程序；程序内部版本仍为 ${version}，本次发布修订为 ${revision || '无'}。通过本说明或 UPDATE-INFORMATION.json 的 releaseLabel/sourceCommit 区分重建版本。\n\n项目兼容：新版支持协作格式 5 和 6；仅打开、保存、预览或取消不会升级。首次有效且确认的永久删除会把格式 5 升级至 6，旧版无法打开格式 6；参与该共享项目的电脑应统一使用支持格式 6 的新版。永久删除不可撤销。\n更新包不包含项目、音频、身份或个人设置，不自动迁移或重新导入；旧版不能用于已经升级的项目。更新包沿用已有 WebView2 环境，程序未签名。\n\n源码提交：${sourceCommit}\n\n${fs.existsSync('docs/release-notes-' + releaseLabel + '.md') ? fs.readFileSync('docs/release-notes-' + releaseLabel + '.md', 'utf8') : fs.existsSync('docs/release-notes-' + version + '.md') ? fs.readFileSync('docs/release-notes-' + version + '.md', 'utf8') : ''}\n`); payload.push('UPDATE-README.txt');
payload.sort(); fs.writeFileSync(path.join(output, 'UPDATE-SHA256SUMS'), payload.map(file => hash(path.join(output, file)) + ' *' + file).join('\n') + '\n'); payload.push('UPDATE-SHA256SUMS'); payload.sort();
const archive = path.join(output, `AudioAnnotator-${fromVersion}-to-${releaseLabel}-update.zip`);
execFileSync('pwsh', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskFiles=Get-Content -Raw -LiteralPath $env:UPDATE_FILES|ConvertFrom-Json
$taskArchive=[IO.Compression.ZipFile]::Open($env:UPDATE_ZIP,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($taskFile in $taskFiles){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive,(Join-Path $env:UPDATE_ROOT $taskFile),$taskFile,[IO.Compression.CompressionLevel]::Optimal)|Out-Null} } finally {$taskArchive.Dispose()}`], { windowsHide: true, env: { ...process.env, UPDATE_ROOT: output, UPDATE_ZIP: archive, UPDATE_FILES: (() => { const file = path.join(build, 'update-payload-files.json'); fs.writeFileSync(file, JSON.stringify(payload)); return file; })() } });
const entries = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip=[IO.Compression.ZipFile]::OpenRead($env:UPDATE_ZIP)
try { @($taskZip.Entries|ForEach-Object {$taskEntry=$_;$taskStream=$taskEntry.Open();try {@{file=$taskEntry.FullName;bytes=$taskEntry.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskStream)).ToLowerInvariant()}}finally{$taskStream.Dispose()}})|ConvertTo-Json -Compress }finally{$taskZip.Dispose()}`], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UPDATE_ZIP: archive } }));
assert.deepEqual(entries.map(e => e.file).sort(), payload);
for (const entry of entries) { const file = path.join(output, entry.file); assert.equal(entry.bytes, fs.statSync(file).size, entry.file); assert.equal(entry.sha256, hash(file), entry.file); }
console.log(JSON.stringify({ passed: true, output, fromVersion, version, revision: revision || null, releaseLabel, sourceCommit, payloadFiles: entries.length, archive: path.basename(archive), archiveBytes: fs.statSync(archive).size, archiveSha256: hash(archive), executableSha256: hash(executable), resourceFiles: resources.length, collaborationFormats: [5, 6] }, null, 2));
