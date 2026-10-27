import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { Builder, By, Key, until } from 'selenium-webdriver';
export { By, Key };
// A renderer update can detach a menu item between lookup and native click.
// Reacquire only that failed click; never retry other interaction errors.
export async function clickFresh(find) {
  for (let attempt=0;attempt<3;attempt++) {
    try { await (await find()).click(); return; }
    catch (error) { if(error.name!=='StaleElementReferenceError'||attempt===2)throw error; }
  }
}
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function revealMedia(h, name) {
  const selector = `.media-select[aria-label=${JSON.stringify(name)}]`;
  if (!(await h.driver.findElements(By.css(selector))).length) {
    await h.input('搜索音频', name);
    await h.until(`document.querySelector(${JSON.stringify(selector)})`, 'search reveals media ancestors');
  }
  await clickFresh(async () => (await h.driver.findElements(By.css(selector)))[0]);
}
const portOccupied = port => new Promise(resolve => { const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);}); });
export function instanceOptions(options = {}) {
  const ports = { driver: 4445, native: 4446, debug: 9235, ...options.ports }, values = Object.values(ports);
  if(values.length!==3||new Set(values).size!==3||values.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw Error('Invalid test ports: require three unique integer ports from 1024 to 65535');
  if(options.localDataEnv!==undefined&&(!path.isAbsolute(options.localDataEnv)||!options.localDataEnv.trim()))throw Error('localDataEnv must be an absolute owned directory');
  if(options.webviewDirectory!==undefined&&(!path.isAbsolute(options.webviewDirectory)||!options.webviewDirectory.trim()))throw Error('webviewDirectory must be an absolute owned directory');
  return { ports, localDataEnv: options.localDataEnv, webviewDirectory:options.webviewDirectory };
}
export async function assertTestPortsAvailable(ports) {
  for(const port of ports)if(await portOccupied(port))throw Error(`Test port already occupied: ${port}; refusing to attach to an existing process`);
}
// WebView children can retire after the owned parent exits. Observe readiness;
// never attach to or terminate a listener merely because it occupies a test port.
export async function waitForTestPortsReleased(ports, timeoutMs = 10000) {
  const deadline=performance.now()+timeoutMs;
  do { if(!(await Promise.all(ports.map(portOccupied))).some(Boolean))return;await wait(100); } while(performance.now()<deadline);
  throw Error('Test port still occupied after owned process teardown; no listener was attached or terminated');
}

function stop(proc) { if(proc.exitCode===null) spawnSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); }
// EdgeDriver reports client dimensions here; measure only our spawned native PID.
function nativeRect(pid, size) {
  if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid owned PID');
  if(size&&(!Number.isInteger(size.width)||!Number.isInteger(size.height)||size.width<700||size.height<500))throw Error('Invalid native size');
  const code=`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class OwnedWindow {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
}
'@
$taskWindow=(Get-Process -Id ${pid}).MainWindowHandle
if($taskWindow -eq 0){throw 'Owned process has no window'}
${size?`[OwnedWindow]::SetWindowPos($taskWindow,[IntPtr]::Zero,20,20,${size.width},${size.height},0x14) | Out-Null`:''}
$taskRect=New-Object OwnedWindow+RECT
[OwnedWindow]::GetWindowRect($taskWindow,[ref]$taskRect) | Out-Null
@{x=$taskRect.Left;y=$taskRect.Top;width=$taskRect.Right-$taskRect.Left;height=$taskRect.Bottom-$taskRect.Top;method='Win32 GetWindowRect on owned native PID';pid=${pid}} | ConvertTo-Json -Compress`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error(result.stderr);return JSON.parse(result.stdout);
}
export async function start(paths, output, executable = path.resolve('target/debug/annotator-desktop.exe'), options = {}) {
  const {ports,localDataEnv,webviewDirectory}=instanceOptions(options),ownedPorts=Object.values(ports),port=ports.driver;
  await assertTestPortsAvailable(ownedPorts);
  const tools = JSON.parse(await fs.readFile('.tools/webdriver.json', 'utf8'));
  const requestedLocal=localDataEnv??path.join(output,'local-data');await fs.mkdir(requestedLocal,{recursive:true});const ownedLocal=await fs.realpath(requestedLocal);
  const native = spawn(executable, [], { windowsHide: true, env: { ...process.env, ANNOTATOR_E2E_LOCAL_DATA:ownedLocal, ANNOTATOR_E2E_DEBUG_PORT: String(ports.debug), ANNOTATOR_E2E_PATHS: JSON.stringify(paths), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${ports.debug}`, WEBVIEW2_USER_DATA_FOLDER: webviewDirectory ?? path.join(output, `webview-${Date.now()}`) } });
  const proc = spawn(tools.tauriDriver, ['--port', String(port), '--native-port', String(ports.native), '--native-driver', tools.edgeDriver], { windowsHide: true });
  let log = ''; proc.stdout.on('data', b => { log += b; }); proc.stderr.on('data', b => { log += b; });
  native.stdout.on('data', b => { log += b; }); native.stderr.on('data', b => { log += b; });
  let driver;
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/status`); break; } catch { await wait(100); } }
    for (let i=0;i<100;i++) { if(native.exitCode!==null)throw Error(`Native app exited ${native.exitCode}: ${log}`); try { await fetch(`http://127.0.0.1:${ports.debug}/json/version`); break; } catch { await wait(100); } }
    driver = await new Builder().usingServer(`http://127.0.0.1:${port}`).withCapabilities({ browserName: 'webview2', 'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${ports.debug}` } }).build();
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 60000, script: 120000 });
    await driver.wait(until.elementLocated(By.css('.main-menu')), 30000);
    await driver.manage().window().setRect({ width: 1280, height: 800, x: 20, y: 20 });
    if(!options.exactOuter){const size = await driver.executeScript('return [innerWidth,innerHeight]');
    await driver.manage().window().setRect({ width: 1280 + 1280 - size[0], height: 800 + 800 - size[1] });}
  } catch (error) { stop(proc); stop(native); await fs.writeFile(path.join(output, `driver-${native.pid}.log`), log); await waitForTestPortsReleased(ownedPorts); throw error; }
  const h = {
    driver, output, nativePid: native.pid,
    nativeRect: size => nativeRect(native.pid, size),
    evaluate: (script, ...args) => driver.executeScript(script, ...args),
    async until(script, label = script, timeout = 60000) { await driver.wait(async () => !!await driver.executeScript(`return (${script})`), timeout, label, 50); },
    element: selector => driver.findElement(By.css(selector)),
    async selectMedia(name) { await revealMedia(h,name); await h.until(`document.querySelector('.file-pane h2')?.textContent===${JSON.stringify(name)}&&!document.querySelector('.tile-status')`); },
    async bindSources(names) { await h.until(`document.querySelector('[aria-label="关联原始音频"]')`); for(const name of names) await driver.findElement(By.xpath(`//div[@aria-label='关联原始音频']/div[span[normalize-space(.)='${name}']]/button`)).click(); await h.clickText('校验并导入'); },
    async clickText(text) { const button=await driver.wait(async()=>{ const elements = await driver.findElements(By.xpath(`//button[normalize-space(.)='${text}']`)); for (const e of elements) if (await e.isDisplayed() && await e.isEnabled()) return e; return false; },10000,`visible enabled button: ${text}`,50);await button.click(); },
    async click(selector) { await (await h.element(selector)).click(); },
    async label(label) { await clickFresh(()=>driver.wait(async()=>{for(const selector of [`[role="menu"] [aria-label="${label}"]`,`[aria-label="${label}"]`])for(const item of await driver.findElements(By.css(selector)))if(await item.isDisplayed())return item;return false;},10000,`visible control: ${label}`,50)); },
    async input(label, text) { const e = await h.element(`[aria-label="${label}"]`); await e.click(); await e.sendKeys(Key.CONTROL, 'a', Key.NULL, Key.BACK_SPACE, text, Key.TAB); },
    async select(label, text) { const e = await h.element(`select[aria-label="${label}"]`); await e.findElement(By.xpath(`.//option[normalize-space(.)='${text}']`)).click(); },
    async menu(text, group='文件') { await clickFresh(()=>driver.findElement(By.xpath(`//nav[@role='menubar']/button[normalize-space(.)='${group}']`))); await clickFresh(()=>driver.findElement(By.xpath(`//div[@role='menu']/button[starts-with(@aria-label,'${text}')]`))); },
    async screenshot(name) { await fs.writeFile(path.join(output, `${name}.png`), await driver.takeScreenshot(), 'base64'); },
    async drag(selector, a, b) { const e = await h.element(selector); await driver.executeScript('arguments[0].scrollIntoView({block:"nearest"})', e); const r = await e.getRect(); await driver.actions({ async: true }).move({ x: Math.round(r.x + r.width * a[0]), y: Math.round(r.y + r.height * a[1]), origin: 'viewport' }).pause(80).press().move({ x: Math.round(r.x + r.width * b[0]), y: Math.round(r.y + r.height * b[1]), origin: 'viewport', duration: 180 }).release().perform(); },
    async context(selector, point = [.5,.5]) { const e = await h.element(selector), r = await e.getRect(); await driver.actions({ async: true }).move({ x: Math.round(r.x + r.width * point[0]), y: Math.round(r.y + r.height * point[1]), origin: 'viewport' }).press(2).release(2).perform(); },
    async snapshot(id) { return driver.executeAsyncScript('const done=arguments[arguments.length-1],projectId=arguments[0];window.__TAURI_INTERNALS__.invoke("collaboration_status").then(s=>window.__TAURI_INTERNALS__.invoke("get_project_snapshot",{projectId,...(s.shared?{runtimeNonce:s.runtimeNonce}:{})})).then(done,e=>done({error:e}));', id); },
    async quit() { try { await Promise.race([driver.quit().catch(()=>{}),wait(5000)]); } finally { stop(proc); stop(native); await fs.writeFile(path.join(output, `driver-${native.pid}.log`), log); await waitForTestPortsReleased(ownedPorts); } },
  };
  return h;
}

