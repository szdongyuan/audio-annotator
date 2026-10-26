import type { SpectralEdit } from '../../bridge/types';

export type AnalysisSource = 'original' | 'processed';
export interface AnalysisIdentity { analysisSource: AnalysisSource; processingVersion: number; editSignature: string }
export const originalAnalysis: AnalysisIdentity = { analysisSource: 'original', processingVersion: 2, editSignature: '' };
// Shared with native source.rs. IEEE754 big-endian bits avoid Rust/JS decimal
// serialization differences, including 1.0, exponent spelling and signed zero.
export function canonicalEdits(mediaId: string, edits: readonly SpectralEdit[]): string {
  const bits = (v: number) => { const bytes = new ArrayBuffer(8); new DataView(bytes).setFloat64(0, v === 0 ? 0 : v, false); return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''); };
  const records = edits.filter(e => e.enabled && e.region.mediaId === mediaId).map(e => {
    const r = e.region; return [r.channelIndex, e.processingVersion, bits(r.startSeconds), bits(r.endSeconds), bits(r.lowHz), bits(r.highHz),e.operation.type==='mask'?'mask':`gain:${bits(e.operation.gainDb)}`].join('|');
  });
  return `analysis-edits-v2|${records.sort().filter((r,i,a)=>!r.endsWith('|mask')||i===0||r!==a[i-1]).join(';')}`;
}
export async function editSignature(mediaId: string, edits: readonly SpectralEdit[], subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  return Array.from(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(canonicalEdits(mediaId, edits)))), b => b.toString(16).padStart(2, '0')).join('');
}
