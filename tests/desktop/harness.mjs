import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Builder, By, Key, until } from 'selenium-webdriver';
export { By, Key };
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function stop(proc) { if(proc.exitCode===null) spawnSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); }
export async function start(paths, output, executable = path.resolve('target/debug/annotator-desktop.exe')) {
  const tools = JSON.parse(await fs.readFile('.tools/webdriver.json', 'utf8'));
  const port = 4445;
  for(const endpoint of ['http://127.0.0.1:4445/status','http://127.0.0.1:9235/json/version']) {
    if(await fetch(endpoint,{signal:AbortSignal.timeout(500)}).catch(()=>null))throw Error(`Test port already occupied: ${endpoint}; refusing to attach to an existing process`);
  }
  const native = spawn(executable, [], { windowsHide: true, env: { ...process.env, ANNOTATOR_E2E_PATHS: JSON.stringify(paths), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9235', WEBVIEW2_USER_DATA_FOLDER: path.join(output, `webview-${Date.now()}`) } });
  const proc = spawn(tools.tauriDriver, ['--port', String(port), '--native-port', '4446', '--native-driver', tools.edgeDriver], { windowsHide: true });
  let log = ''; proc.stdout.on('data', b => { log += b; }); proc.stderr.on('data', b => { log += b; });
  native.stdout.on('data', b => { log += b; }); native.stderr.on('data', b => { log += b; });
  let driver;
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/status`); break; } catch { await wait(100); } }
    for (let i=0;i<100;i++) { if(native.exitCode!==null)throw Error(`Native app exited ${native.exitCode}: ${log}`); try { await fetch('http://127.0.0.1:9235/json/version'); break; } catch { await wait(100); } }
    driver = await new Builder().usingServer(`http://127.0.0.1:${port}`).withCapabilities({ browserName: 'webview2', 'ms:edgeOptions': { debuggerAddress: '127.0.0.1:9235' } }).build();
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 60000, script: 120000 });
    await driver.wait(until.elementLocated(By.css('.project-menu')), 30000);
    await driver.manage().window().setRect({ width: 1280, height: 800, x: 20, y: 20 });
    const size = await driver.executeScript('return [innerWidth,innerHeight]');
    await driver.manage().window().setRect({ width: 1280 + 1280 - size[0], height: 800 + 800 - size[1] });
  } catch (error) { stop(proc); stop(native); await fs.writeFile(path.join(output, `driver-${native.pid}.log`), log); throw error; }
  const h = {
    driver, output, nativePid: native.pid,
    evaluate: (script, ...args) => driver.executeScript(script, ...args),
    async until(script, label = script, timeout = 60000) { await driver.wait(async () => !!await driver.executeScript(`return (${script})`), timeout, label, 50); },
    element: selector => driver.findElement(By.css(selector)),
    async clickText(text) { const elements = await driver.findElements(By.xpath(`//button[normalize-space(.)='${text}']`)); for (const e of elements) if (await e.isDisplayed()) { await e.click(); return; } throw new Error(`No visible button: ${text}`); },
    async click(selector) { await (await h.element(selector)).click(); },
    async label(label) { await h.click(`[aria-label="${label}"]`); },
    async input(label, text) { const e = await h.element(`[aria-label="${label}"]`); await e.click(); await e.sendKeys(Key.CONTROL, 'a', Key.NULL, text, Key.TAB); },
    async select(label, text) { const e = await h.element(`select[aria-label="${label}"]`); await e.findElement(By.xpath(`.//option[normalize-space(.)='${text}']`)).click(); },
    async menu(text) { await h.click('.project-menu summary'); const e = await driver.findElement(By.xpath(`//details[contains(@class,'project-menu')]//button[starts-with(normalize-space(.),'${text}')]`)); await e.click(); },
    async screenshot(name) { await fs.writeFile(path.join(output, `${name}.png`), await driver.takeScreenshot(), 'base64'); },
    async drag(selector, a, b) { const e = await h.element(selector); await driver.executeScript('arguments[0].scrollIntoView({block:"nearest"})', e); const r = await e.getRect(); await driver.actions({ async: true }).move({ x: Math.round(r.x + r.width * a[0]), y: Math.round(r.y + r.height * a[1]), origin: 'viewport' }).pause(80).press().move({ x: Math.round(r.x + r.width * b[0]), y: Math.round(r.y + r.height * b[1]), origin: 'viewport', duration: 180 }).release().perform(); },
    async snapshot(id) { return driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke("get_project_snapshot",{projectId:arguments[0]}).then(done,e=>done({error:e}));', id); },
    async quit() { try { await Promise.race([driver.quit().catch(()=>{}),wait(5000)]); } finally { stop(proc); stop(native); await fs.writeFile(path.join(output, `driver-${native.pid}.log`), log); await wait(1000); } },
  };
  return h;
}

