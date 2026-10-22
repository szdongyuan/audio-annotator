/** Only this LRU owns retained tile buffers. React holds keys, never duplicate arrays. */
export class TileCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private pins = new Map<string, Set<string>>();
  bytes = 0;
  constructor(readonly limit = 96 * 1024 * 1024) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry); return entry.value;
  }
  set(key: string, value: T, bytes: number) {
    const previous = this.entries.get(key);
    if (bytes > this.limit) return false;
    while (this.bytes + bytes - (previous?.bytes ?? 0) > this.limit) {
      const oldest = [...this.entries].find(([candidate]) => candidate !== key && ![...this.pins.values()].some(keys => keys.has(candidate)));
      if (!oldest) return false;
      this.entries.delete(oldest[0]); this.bytes -= oldest[1].bytes;
    }
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    return true;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  setPins(owner: string, keys: readonly string[]) { if (keys.length) this.pins.set(owner, new Set(keys)); else this.pins.delete(owner); }
  byteSize(key: string) { return this.entries.get(key)?.bytes ?? 0; }
  deleteMatching(predicate: (key: string) => boolean) {
    for (const [key, entry] of this.entries) if (predicate(key)) { this.entries.delete(key); this.bytes -= entry.bytes; }
  }
  matchingKeys(predicate: (value: T, key: string) => boolean): string[] {
    return [...this.entries].filter(([key, entry]) => predicate(entry.value, key)).map(([key]) => key);
  }
}
