import { defaultSourceOrganization, parseSourceOrganization, parseSourceRules, type SourceOrganization, type SourceRules } from '../../bridge/sourceImport';
export interface ImportPlanPreset {
    id: string;
    name: string;
    rules: SourceRules;
    organization: Omit<SourceOrganization, 'targetFolderId'>;
}
const rules: SourceRules = { mode: 'generic', recursive: true, extensions: ['wav', 'flac', 'mp3'], include: ['**/*'], exclude: [], includeSecond: true, skipDuplicates: true };
const { targetFolderId: _target, ...organization } = defaultSourceOrganization();
export const builtinPlans: readonly ImportPlanPreset[] = [
    { id: 'generic-source', name: '通用·保留来源目录', rules, organization: { ...organization, mode: 'sourcePath', wrapSource: true } },
    { id: 'generic-flat', name: '通用·平铺', rules, organization },
    { id: 'jingcheng-result', name: '精成·按结果和故障分类', rules: { ...rules, mode: 'jingcheng' }, organization: { ...organization, mode: 'template', template: '{source}/{result}/{faultType}/{record}' } },
    { id: 'jingcheng-source', name: '精成·保留来源目录', rules: { ...rules, mode: 'jingcheng' }, organization: { ...organization, mode: 'sourcePath', wrapSource: true, stripComponents: ['audio'] } }
];
export const planStorageKey = 'annotator.import-plans.v3';
const maxCharacters = 2000000;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Plan = Pick<ImportPlanPreset, 'rules' | 'organization'>;
function reusable(plan: Plan): Plan { const parsedRules = parseSourceRules(plan.rules); const parsedOrganization = parseSourceOrganization({ ...plan.organization, targetFolderId: null }, parsedRules.mode); const { targetFolderId: _unused, ...org } = parsedOrganization; return structuredClone({ rules: parsedRules, organization: org }); }
export class ImportPlanStore {
    private custom: ImportPlanPreset[] = [];
    last: Plan = reusable(builtinPlans[0]);
    error: string | null = null;
    private storage?: StoragePort;
    get presets() { return structuredClone([...builtinPlans, ...this.custom]); }
    constructor(storage?: StoragePort) { try {
        this.storage = storage ?? window.localStorage;
        const current = this.storage.getItem(planStorageKey);
        const legacy = current === null;
        const raw = legacy ? this.storage.getItem('annotator.import-plans.v2') : current;
        if (raw === null)
            return;
        if (raw.length > maxCharacters)
            throw new Error();
        const v = JSON.parse(raw);
        if (v.version !== (legacy ? 2 : 3) || Object.keys(v).sort().join() !== 'last,presets,version' || !Array.isArray(v.presets) || v.presets.length > 32)
            throw new Error();
        const strict = (p: Plan) => { if (Object.keys(p).sort().join() !== 'organization,rules' || Object.keys(p.organization).sort().join() !== 'mode,stripComponents,template,wrapSource')
            throw new Error();
            if (legacy) {
                if (Object.keys(p.rules).sort().join() !== 'exclude,extensions,include,includeSecond,mode,recursive')
                    throw new Error();
                return reusable({ ...p, rules: { ...p.rules, skipDuplicates: true } });
            }
            return reusable(p); };
        this.last = strict(v.last);
        const ids = new Set<string>();
        this.custom = v.presets.map((p: ImportPlanPreset) => { if (Object.keys(p).sort().join() !== 'id,name,organization,rules' || !/^custom-[\w-]{1,64}$/.test(p.id) || ids.has(p.id))
            throw new Error(); ids.add(p.id); this.validateName(p.name); return { id: p.id, name: p.name, ...strict({ rules: p.rules, organization: p.organization }) }; });
        if (legacy)
            this.persist();
    }
    catch {
        this.custom = [];
        this.last = reusable(builtinPlans[0]);
        this.error = '无法读取本机导入方案，已使用默认设置';
    } }
    private validateName(name: string) { if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f\x7f-\x9f]/.test(name))
        throw new Error('方案名称须为 1–64 个字符'); }
    private persist() { try {
        const raw = JSON.stringify({ version: 3, last: this.last, presets: this.custom });
        if (raw.length > maxCharacters)
            throw new Error();
        if (!this.storage)
            throw new Error();
        this.storage.setItem(planStorageKey, raw);
        this.error = null;
    }
    catch {
        this.error = '无法保存本机方案，本次仍可使用';
    } }
    remember(plan: Plan) { this.last = reusable(plan); this.persist(); }
    save(name: string, plan: Plan) { this.validateName(name); if (this.custom.length >= 32)
        throw new Error('最多保存 32 个自定义方案'); const value = reusable(plan), id = `custom-${crypto.randomUUID()}`; if (JSON.stringify({ version: 3, last: value, presets: [...this.custom, { id, name: name.trim(), ...value }] }).length > maxCharacters)
        throw new Error('导入方案超过容量上限'); this.custom.push({ id, name: name.trim(), ...value }); this.last = value; this.persist(); return id; }
    remove(id: string) { if (!id.startsWith('custom-'))
        throw new Error('内置方案不可删除'); this.custom = this.custom.filter(p => p.id !== id); this.persist(); }
}
