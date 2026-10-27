import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import { MediaAssociation } from './MediaAssociation';
import type { MediaUI } from '../media/useMedia';
import type { ActiveProject } from '../project/useProjectLifecycle';
it('keeps a large ready catalog out of the recovery panel and only offers missing or changed files',()=>{
 const files=Array.from({length:10000},(_,i)=>({...fixture.media[0],id:crypto.randomUUID(),displayName:`file-${i}.wav`}));
 const active={store:{snapshot:{document:{media:files}}}} as unknown as ActiveProject;
 const statuses=files.map(m=>({mediaId:m.id,status:'ready' as const}));const setRelink=vi.fn();
 const media={statuses,setRelink,disabled:false} as unknown as MediaUI;
 const view=render(<MediaAssociation active={active} media={media}/>);expect(screen.queryByRole('region')).toBeNull();
 const changed={...media,statuses:statuses.map((s,i)=>({...s,status:i===9999?'missing' as const:i===32?'changed' as const:s.status}))};
 view.rerender(<MediaAssociation active={active} media={changed}/>);expect(screen.getAllByRole('button')).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'关联 file-9999.wav'}));expect(setRelink).toHaveBeenCalledExactlyOnceWith(files[9999]);
});
