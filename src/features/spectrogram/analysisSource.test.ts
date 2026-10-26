/// <reference types="node" />
import { expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import fixture from '../../../tests/fixtures/analysis-signature.json';
import type { SpectralEdit } from '../../bridge/types';
import { canonicalEdits, editSignature } from './analysisSource';
it('shares IEEE754 canonical geometry and digest with native, independent of JSON decimal spelling', async () => {
  const edits = fixture.edits as SpectralEdit[];
  expect(canonicalEdits('m', edits)).toBe(fixture.canonical);
  expect(await editSignature('m', edits, webcrypto.subtle as SubtleCrypto)).toBe(fixture.signature);
  const renamed = edits.map(e => ({ ...e, id: 'renamed' })).reverse();
  expect(canonicalEdits('m', [...renamed, ...edits, { ...edits[0], enabled: false }, { ...edits[0], region: { ...edits[0].region, mediaId: 'other' } }])).toBe(fixture.canonical);
  expect(canonicalEdits('m', [{ ...edits[0], region: { ...edits[0].region, endSeconds: 1.0000000000000002 } }])).not.toBe(canonicalEdits('m', [edits[0]]));
});

it('retains gain operation value and repeated applications in processed identity',()=>{
 const gain={...fixture.edits[0],operation:{type:'gain' as const,gainDb:6}} as unknown as SpectralEdit;
 expect(canonicalEdits('m',[gain,gain])).not.toBe(canonicalEdits('m',[gain]));
 expect(canonicalEdits('m',[gain,{...gain,enabled:false}])).toBe(canonicalEdits('m',[gain]));
 expect(canonicalEdits('m',[{...gain,operation:{type:'gain',gainDb:-6}}] as never)).not.toBe(canonicalEdits('m',[gain]));
});

it('shares operation values and repeated gain records with native canonical identity',async()=>{
 const edits=fixture.gainEdits as SpectralEdit[];
 expect(canonicalEdits('m',edits)).toBe(fixture.gainCanonical);
 expect(await editSignature('m',edits,webcrypto.subtle as SubtleCrypto)).toBe(fixture.gainSignature);
 expect(canonicalEdits('m',[...edits].reverse())).toBe(fixture.gainCanonical);
});
