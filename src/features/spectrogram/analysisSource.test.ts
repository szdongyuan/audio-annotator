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
