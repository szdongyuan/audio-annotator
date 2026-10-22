import type { TileResult } from './tileClient';
import { TileCache } from './tileCache';
// 64 MiB numeric tiles + <=12 one-MiB canvases + transient one-MiB raster per canvas
// stays below the 96 MiB frontend tile/image budget. No retained image copies.
export const tileCache = new TileCache<TileResult>(64 * 1024 * 1024);
/** Four native requests across ALL panes, below the native 32 waiting-job bound. */
export class TileScheduler {
  private active = 0;
  private waiting: { visible: boolean; valid: () => boolean; run: () => Promise<void> }[] = [];
  submit(visible: boolean, valid: () => boolean, work: () => Promise<void>) {
    this.waiting = this.waiting.filter(job => job.valid());
    this.waiting.push({ visible, valid, run: work }); this.pump();
  }
  private pump() {
    this.waiting = this.waiting.filter(job => job.valid());
    this.waiting.sort((a, b) => Number(b.visible) - Number(a.visible));
    while (this.active < 4 && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      void job.run().catch(() => {}).finally(() => { this.active--; this.pump(); });
    }
  }
}
export const tileScheduler = new TileScheduler();
