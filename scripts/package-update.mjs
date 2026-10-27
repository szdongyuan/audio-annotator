import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [buildArgument, outputArgument, fromVersion = '0.7.0'] = process.argv.slice(2);
if (!buildArgument || !outputArgument) throw Error('Usage: node scripts/package-update.mjs <production-release-directory> <new-delivery-directory> [previous-version]');
const build = path.resolve(buildArgument), output = path.resolve(outputArgument), version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
assert.match(version, /^\d+\.\d+\.\d+$/); assert.match(fromVersion, /^\d+\.\d+\.\d+$/);
assert.notEqual(version, fromVersion, 'Update versions must differ');
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
const resources = [...list('licenses').map(file => ['licenses/' + file, 'licenses/' + file]), ['docs/user-guide.md', 'user-guide.md'], ['docs/third-party.md', 'third-party.md']];
for (const [source, relative] of resources) assert.equal(hash(source), hash(path.join(build, relative)), 'Built resource mismatch: ' + relative);
fs.mkdirSync(output, { recursive: false });
const payload = ['annotator-desktop.exe']; fs.copyFileSync(executable, path.join(output, payload[0]));
for (const [source, relative] of resources) { const destination = path.join(output, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); payload.push(relative); }
const information = { kind: 'audio-annotator-file-update', fromVersion, toVersion: version, executable: 'annotator-desktop.exe', installation: 'Close the application; extract these files over the existing program directory. Do not replace or move project folders or user data.', formatsUnchanged: { project: 3, collaboration: 5, authorLayer: 2, privateWorkspace: 2, exchange: 4, dsp: 2, organization: 1, catalog: 2, analysis: 1 }, includesAudioOrPersonalData: false };
fs.writeFileSync(path.join(output, 'UPDATE-INFORMATION.json'), JSON.stringify(information, null, 2) + '\n'); payload.push('UPDATE-INFORMATION.json');
fs.writeFileSync(path.join(output, 'UPDATE-README.txt'), `音频标注 ${fromVersion} → ${version} 更新包\n\n1. 在旧版中保存并同步，处理尚未解决的失败修改，然后关闭所有音频标注程序窗口。\n2. 找到原程序所在目录（包含 annotator-desktop.exe），可先将原程序和配套资源复制一份以备回退。\n3. 将更新 ZIP 中的全部文件解压并覆盖到原程序目录。不要解压到项目或 NAS 数据目录。\n4. 启动原来的 annotator-desktop.exe，从“帮助 → 关于”确认版本为 ${version}，照常打开原来的 collaboration.json。\n\n兼容性：${version} 与 ${fromVersion} 的项目、标注、共享目录、私人处理、监听设置和身份文件格式相同，无需转换或重新导入音频。更早版本的不同格式项目仍按原有规则处理。\n更新包不包含音频、项目、身份或个人设置，也不删除程序目录中的其他文件；现有项目和用户数据应保持原位。\n更新包沿用原有 WebView2 环境，不需要重新安装运行环境。程序未签名。\n\n${fs.existsSync('docs/release-notes-' + version + '.md') ? fs.readFileSync('docs/release-notes-' + version + '.md', 'utf8') : '详细改动请参阅对应版本的发布说明。'}\n`); payload.push('UPDATE-README.txt');
payload.sort(); fs.writeFileSync(path.join(output, 'UPDATE-SHA256SUMS'), payload.map(file => hash(path.join(output, file)) + ' *' + file).join('\n') + '\n'); payload.push('UPDATE-SHA256SUMS'); payload.sort();
const archive = path.join(output, `AudioAnnotator-${fromVersion}-to-${version}-update.zip`);
execFileSync('pwsh', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskFiles=Get-Content -Raw -LiteralPath $env:UPDATE_FILES|ConvertFrom-Json
$taskArchive=[IO.Compression.ZipFile]::Open($env:UPDATE_ZIP,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($taskFile in $taskFiles){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive,(Join-Path $env:UPDATE_ROOT $taskFile),$taskFile,[IO.Compression.CompressionLevel]::Optimal)|Out-Null} } finally {$taskArchive.Dispose()}`], { windowsHide: true, env: { ...process.env, UPDATE_ROOT: output, UPDATE_ZIP: archive, UPDATE_FILES: (() => { const file = path.join(build, 'update-payload-files.json'); fs.writeFileSync(file, JSON.stringify(payload)); return file; })() } });
const entries = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskZip=[IO.Compression.ZipFile]::OpenRead($env:UPDATE_ZIP)
try { @($taskZip.Entries|ForEach-Object {$taskEntry=$_;$taskStream=$taskEntry.Open();try {@{file=$taskEntry.FullName;bytes=$taskEntry.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskStream)).ToLowerInvariant()}}finally{$taskStream.Dispose()}})|ConvertTo-Json -Compress }finally{$taskZip.Dispose()}`], { encoding: 'utf8', windowsHide: true, env: { ...process.env, UPDATE_ZIP: archive } }));
assert.deepEqual(entries.map(e => e.file).sort(), payload);
for (const entry of entries) { const file = path.join(output, entry.file); assert.equal(entry.bytes, fs.statSync(file).size, entry.file); assert.equal(entry.sha256, hash(file), entry.file); }
console.log(JSON.stringify({ passed: true, output, fromVersion, version, payloadFiles: entries.length, archive: path.basename(archive), archiveBytes: fs.statSync(archive).size, archiveSha256: hash(archive), executableSha256: hash(executable), resourceFiles: resources.length, formatsUnchanged: true }, null, 2));
