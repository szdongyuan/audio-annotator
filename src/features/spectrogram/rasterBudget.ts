/** Workspace-wide retained canvas backings plus one synchronous reusable RGBA scratch. */
export function backingSize(width: number, height: number, dpr: number) {
  return { width: Math.max(1, Math.round(width * dpr)), height: Math.max(1, Math.round(height * dpr)) };
}
export const scratchWidth = (width: number) => Math.min(64, width);
export class RasterBudget {
  private surfaces = new Map<object | string, number>();
  private scratchBytes = 0;
  private scratch: ImageData | undefined;
  constructor(readonly limit = 32 * 1024 * 1024) {}
  get bytes() { return [...this.surfaces.values()].reduce((a, b) => a + b, 0) + this.scratchBytes; }
  reserve(owner: object | string, width: number, height: number) {
    const bytes = width * height * 4, scratchBytes = scratchWidth(width) * height * 4;
    const retained = this.bytes - this.scratchBytes - (this.surfaces.get(owner) ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || retained + bytes + scratchBytes > this.limit) throw new Error('频谱栅格资源不足，请缩小窗口或减少可见通道后重试');
    this.surfaces.set(owner, bytes);
    this.scratchBytes = scratchBytes;
    if (this.scratch?.width !== scratchWidth(width) || this.scratch.height !== height) this.scratch = undefined;
  }
  image(context: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.scratch || this.scratch.width !== width || this.scratch.height !== height) this.scratch = context.createImageData(width, height);
    return this.scratch;
  }
  release(owner: object | string) {
    this.surfaces.delete(owner);
    if (!this.surfaces.size) { this.scratch = undefined; this.scratchBytes = 0; }
  }
}
export const rasterBudget = new RasterBudget();
