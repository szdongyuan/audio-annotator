import { parseSourceRules, type SourceRules } from '../../bridge/sourceImport';
export interface RulePreset {
  id: string;
  name: string;
  rules: SourceRules;
}
const defaults: SourceRules = { mode: 'generic', recursive: true, extensions: ['wav', 'flac', 'mp3'], include: ['**/*'], exclude: [], includeSecond: true, skipDuplicates: true };
export const builtinPresets: readonly RulePreset[] = [{ id: 'generic', name: '全部音频', rules: defaults }, { id: 'jingcheng', name: '精成采集数据', rules: { ...defaults, mode: 'jingcheng' } }];
export const splitPatterns = (text: string) => text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
const key = 'annotator.import-rules.v1';
const maxStoredCharacters = 2_000_000;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export class ImportRuleStore {
  private custom: RulePreset[] = [];
  last = structuredClone(defaults);
  error: string | null = null;
  private storage?: StoragePort;
  get presets() {
    return [...structuredClone(builtinPresets), ...structuredClone(this.custom)];
  }
  constructor(storage?: StoragePort) {
    try {
      this.storage = storage ?? window.localStorage;
      const raw = this.storage.getItem(key);
      if (!raw)
        return;
      if (raw.length > maxStoredCharacters)
        throw new Error();
      const value = JSON.parse(raw);
      if (value.version !== 1 || Object.keys(value).sort().join() !== 'last,presets,version' || !Array.isArray(value.presets) || value.presets.length > 32)
        throw new Error();
      parseSourceRules(value.last);
      const ids = new Set<string>();
      for (const p of value.presets) {
        if (Object.keys(p).sort().join() !== 'id,name,rules' || typeof p.id !== 'string' || !/^custom-[\w-]{1,64}$/.test(p.id) || ids.has(p.id))
          throw new Error();
        ids.add(p.id);
        this.validateName(p.name);
        parseSourceRules(p.rules);
      }
      this.custom = value.presets;
      this.last = value.last;
    }
    catch {
      this.custom = [];
      this.last = structuredClone(defaults);
      this.error = '无法读取本机规则，已使用默认设置';
    }
  }
  private validateName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\x00-\x1f]/.test(name))
      throw new Error('规则名称须为 1–64 个字符');
  }
  private persist() {
    try {
      if (!this.storage) throw new Error('Local storage unavailable');
      const raw = JSON.stringify({ version: 1, last: this.last, presets: this.custom });
      if (raw.length > maxStoredCharacters) {
        this.error = '无法保存本机规则：内容超过容量上限，本次仍可使用';
        return;
      }
      this.storage.setItem(key, raw);
      this.error = null;
    }
    catch {
      this.error = '无法保存本机规则，本次仍可使用';
    }
  }
  remember(rules: SourceRules) {
    this.last = structuredClone(parseSourceRules(rules));
    this.persist();
  }
  save(name: string, rules: SourceRules) {
    this.validateName(name);
    parseSourceRules(rules);
    if (this.custom.length >= 32)
      throw new Error('最多保存 32 个自定义规则');
    const id = `custom-${crypto.randomUUID()}`;
    this.custom.push({ id, name: name.trim(), rules: structuredClone(rules) });
    this.remember(rules);
    return id;
  }
  remove(id: string) {
    if (!id.startsWith('custom-'))
      throw new Error('内置规则不可删除');
    this.custom = this.custom.filter(p => p.id !== id);
    this.persist();
  }
}
