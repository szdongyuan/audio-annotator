import assert from 'node:assert/strict';
import { By } from './harness.mjs';
export const read = (h,command,args={}) => h.driver.executeAsyncScript('const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(done,e=>done({error:e}));',command,args);
export const profiles = h => read(h,'profile_list');
export async function createIdentity(h,name){
 await h.menu('创建身份…','协作');await h.input('身份昵称',name);await h.clickText('创建并使用');
 await h.until(`document.querySelector('.collaboration-dialog [role="status"]')?.textContent.includes('身份已创建')&&!document.querySelector('[aria-label="身份操作进度"]')`);
 const s=await profiles(h),p=s.profiles.find(p=>p.authorId===s.selectedAuthorId);assert.equal(p.displayName,name);await h.clickText('关闭');return p;
}
export async function selectIdentity(h,id){
 await h.menu('切换身份…','协作');await h.until(`document.querySelector('.identity-list')`);
 const row=await h.driver.findElement(By.xpath(`//ul[@class='identity-list']/li[.//input[@value='${id}']]`));
 const button=await row.findElement(By.xpath('./button'));if(await button.isEnabled()){await button.click();await h.until(`document.querySelector('.collaboration-dialog [role="status"]')?.textContent.includes('当前身份已更新')&&!document.querySelector('[aria-label="身份操作进度"]')`);}
 assert.equal((await profiles(h)).selectedAuthorId,id);await h.clickText('关闭');
}
export async function renameIdentity(h,name){await h.menu('修改昵称…','协作');await h.input('身份昵称',name);await h.clickText('保存昵称');await h.until(`document.querySelector('.collaboration-dialog [role="status"]')?.textContent.includes('昵称已保存')&&!document.querySelector('[aria-label="身份操作进度"]')`);await h.clickText('关闭');}
export async function exportIdentity(h){await h.menu('导出当前身份…','协作');await h.clickText('选择保存位置…');await h.until(`document.querySelector('.collaboration-dialog [role="status"]')?.textContent.includes('身份已导出')&&!document.querySelector('[aria-label="身份操作进度"]')`);await h.clickText('关闭');}
export async function importIdentity(h){await h.menu('导入身份…','协作');await h.clickText('选择身份文件…');await h.until(`document.querySelector('.collaboration-dialog [role="status"]')&&!document.querySelector('[aria-label="身份操作进度"]')`);}
