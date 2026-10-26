import { expect, it, vi } from 'vitest';
import { builtinPresets, ImportRuleStore, splitPatterns } from './importRules';
it('stores validated local rules only, preserves builtins and handles corruption', () => {
 const storage = { value: '', getItem: () => storage.value || null, setItem: (_: string, value: string) => { storage.value = value; } };
 const store = new ImportRuleStore(storage);
 expect(splitPatterns('*/CH1, */CH2; **/audio/*.wav\n')).toEqual(['*/CH1','*/CH2','**/audio/*.wav']);
 store.save('我的规则', builtinPresets[0].rules);
 expect(new ImportRuleStore(storage).presets).toHaveLength(3);
 expect(() => store.remove('generic')).toThrow();
 store.remove(store.presets[2].id); expect(store.presets).toHaveLength(2);
 storage.value = '{bad'; const corrupt = new ImportRuleStore(storage);
 expect(corrupt.presets).toHaveLength(2); expect(corrupt.error).toBeTruthy();
});
it('keeps an explicit storage error when the localStorage accessor is unavailable',()=>{const access=vi.spyOn(window,'localStorage','get').mockImplementation(()=>{throw new Error('unavailable');});try{const store=new ImportRuleStore();store.remember(builtinPresets[0].rules);expect(store.error).toBeTruthy();expect(store.presets).toHaveLength(2);}finally{access.mockRestore();}});
it('bounds custom presets, ignores injected paths and stays usable when storage fails',()=>{
 const storage={getItem:()=>null,setItem:()=>{throw new Error('denied');}};const store=new ImportRuleStore(storage);
 store.remember(builtinPresets[1].rules);expect(store.error).toBeTruthy();expect(store.last.mode).toBe('jingcheng');
 for(let i=0;i<32;i++)store.save(`规则 ${i}`,builtinPresets[0].rules);
 expect(()=>store.save('过多',builtinPresets[0].rules)).toThrow();
 const invalid=new ImportRuleStore({getItem:()=>JSON.stringify({version:1,last:{...builtinPresets[0].rules,paths:['N:/private']},presets:[]}),setItem:()=>{}});expect(invalid.error).toBeTruthy();expect(invalid.last).toEqual(builtinPresets[0].rules);
});
it('preserves readable saved presets when a valid new preset exceeds aggregate storage capacity',()=>{
 const storage={value:'',getItem:()=>storage.value||null,setItem:(_:string,value:string)=>{storage.value=value;}};
 const store=new ImportRuleStore(storage),rules={...builtinPresets[0].rules,include:Array.from({length:256},()=> 'a'.repeat(512))};
 for(let i=0;i<14;i++)store.save(`large ${i}`,rules);
 expect(store.error).toBeNull();expect(new ImportRuleStore(storage).presets).toHaveLength(16);
 const saved=storage.value,id=store.save('too much for storage',rules);
 expect(store.error).toMatch(/容量/);expect(storage.value===saved).toBe(true);
 const reopened=new ImportRuleStore(storage);expect(reopened.error).toBeNull();expect(reopened.presets).toHaveLength(16);
 store.remove(id);expect(store.error).toBeNull();expect(new ImportRuleStore(storage).presets).toHaveLength(16);
});
