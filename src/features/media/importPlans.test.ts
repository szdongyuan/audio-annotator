import { expect, it } from 'vitest';
import { ImportPlanStore, builtinPlans, planStorageKey } from './importPlans';
const storage = () => { const values = new Map<string, string>([['annotator.import-rules.v1', 'old untouched']]); return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } }; };
it('offers four meaningful complete layouts and leaves v1 untouched', () => { const s = storage(), store = new ImportPlanStore(s); expect(builtinPlans.map(p => p.name)).toEqual(['通用·保留来源目录', '通用·平铺', '精成·按结果和故障分类', '精成·保留来源目录']); expect(builtinPlans[2].organization.template).toBe('{source}/{result}/{faultType}/{record}'); expect(builtinPlans[3].organization.stripComponents).toEqual(['audio']); store.remember(builtinPlans[2]); expect(s.values.get('annotator.import-rules.v1')).toBe('old untouched'); expect(s.values.has(planStorageKey)).toBe(true); });
it('roundtrips 32 reusable plans without source paths or project target and rejects overflow symmetrically', () => { const s = storage(), store = new ImportPlanStore(s); for (let i = 0; i < 32; i++)
    store.save('方案' + i, { ...builtinPlans[2], paths: ['D:/private'], organization: { ...builtinPlans[2].organization, targetFolderId: 'project-only' } } as never); expect(() => store.save('overflow', builtinPlans[0])).toThrow(); const serialized = s.values.get(planStorageKey)!; expect(serialized).not.toContain('D:/private'); expect(serialized).not.toContain('project-only'); expect(new ImportPlanStore(s).presets).toHaveLength(36); });
it('unknown versions and oversized storage retain bounded defaults', () => { const s = storage(); s.values.set(planStorageKey, JSON.stringify({ version: 99 })); expect(new ImportPlanStore(s).presets).toHaveLength(4); expect(new ImportPlanStore(s).error).toBeTruthy(); });

const legacyPlan = () => ({rules:{mode:'jingcheng',recursive:false,extensions:['flac'],include:['*/CH1'],exclude:['**/bad/*'],includeSecond:false},organization:{mode:'template',wrapSource:true,stripComponents:['audio'],template:'{source}/{result}/{record}'}});
const legacyDocument = () => ({version:2,last:legacyPlan(),presets:[{id:'custom-legacy',name:'旧方案',...legacyPlan()}]});
it('defaults every plan to duplicate skipping and preserves explicit false in last and custom plans',()=>{
 const s=storage(),store=new ImportPlanStore(s);
 expect(store.last.rules.skipDuplicates).toBe(true);
 expect(store.presets.every(p=>p.rules.skipDuplicates)).toBe(true);
 const plan={...builtinPlans[2],rules:{...builtinPlans[2].rules,skipDuplicates:false}};
 const id=store.save('保留重复',plan),reopened=new ImportPlanStore(s);
 expect(reopened.last.rules.skipDuplicates).toBe(false);
 expect(reopened.presets.find(p=>p.id===id)?.rules.skipDuplicates).toBe(false);
 expect(planStorageKey).toBe('annotator.import-plans.v3');
 expect(JSON.parse(s.values.get(planStorageKey)!).version).toBe(3);
});
it('migrates complete v2 last and custom plans to v3 while leaving legacy bytes untouched',()=>{
 const s=storage(),legacyKey='annotator.import-plans.v2',currentKey='annotator.import-plans.v3';
 const legacy=legacyDocument(),before=JSON.stringify(legacy,null,2);s.values.set(legacyKey,before);
 const migrated=new ImportPlanStore(s);
 expect(migrated.error).toBeNull();
 expect(migrated.last).toEqual({...legacy.last,rules:{...legacy.last.rules,skipDuplicates:true}});
 expect(migrated.presets[4]).toEqual({...legacy.presets[0],rules:{...legacy.presets[0].rules,skipDuplicates:true}});
 expect(JSON.parse(s.values.get(currentKey)!).version).toBe(3);
 migrated.remember({...migrated.last,rules:{...migrated.last.rules,skipDuplicates:false}});
 expect(s.values.get(legacyKey)).toBe(before);
 expect(new ImportPlanStore(s).last.rules.skipDuplicates).toBe(false);
});
it('prefers existing v3 and never falls back from corrupt or empty v3 to valid v2',()=>{
 const s=storage();s.values.set('annotator.import-plans.v2',JSON.stringify(legacyDocument()));
 s.values.set('annotator.import-plans.v3',JSON.stringify({version:3,last:{rules:{...builtinPlans[1].rules,skipDuplicates:false},organization:builtinPlans[1].organization},presets:[]}));
 expect(new ImportPlanStore(s).last.rules.skipDuplicates).toBe(false);
 for(const raw of ['','{bad',JSON.stringify({version:3,last:legacyPlan(),presets:[]})]){
  s.values.set('annotator.import-plans.v3',raw);const store=new ImportPlanStore(s);
  expect(store.error).toBeTruthy();expect(store.last).toEqual({rules:builtinPlans[0].rules,organization:builtinPlans[0].organization});
  expect(s.values.get('annotator.import-plans.v3')).toBe(raw);
 }
});
it('rejects invalid legacy shapes, policies and oversized data without writing v3',()=>{
 const base=legacyDocument();
 const invalid=[{...base,extra:true},{...base,last:{...base.last,rules:{...base.last.rules,extra:true}}},{...base,last:{...base.last,rules:{...base.last.rules,includeSecond:'false'}}},{...base,last:{...base.last,rules:{...base.last.rules,skipDuplicates:false}}},{...base,presets:Array(33).fill(base.presets[0])}];
 for(const raw of [...invalid.map(v=>JSON.stringify(v)),' '.repeat(2000001)]){
  const s=storage();s.values.set('annotator.import-plans.v2',raw);const store=new ImportPlanStore(s);
  expect(store.error).toBeTruthy();expect(store.presets).toHaveLength(4);expect(s.values.has('annotator.import-plans.v3')).toBe(false);expect(s.values.get('annotator.import-plans.v2')).toBe(raw);
 }
 const s=storage();s.values.set('annotator.import-plans.v3',' '.repeat(2000001));expect(new ImportPlanStore(s).error).toBeTruthy();
});
it('keeps migrated plans usable and legacy data intact when v3 persistence fails',()=>{
 const s=storage(),before=JSON.stringify(legacyDocument());s.values.set('annotator.import-plans.v2',before);
 const store=new ImportPlanStore({...s,setItem:()=>{throw new Error('denied');}});
 expect(store.last.rules.skipDuplicates).toBe(true);expect(store.presets[4].id).toBe('custom-legacy');expect(store.error).toMatch(/无法保存/);expect(s.values.get('annotator.import-plans.v2')).toBe(before);
});
