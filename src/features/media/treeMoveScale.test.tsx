import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MoveReviewItems } from './MediaList';
import { OrganizationController } from './organization';
import { RecycleController } from './recycle';
import { useTreeMove } from './useTreeMove';

const nonce='11111111-1111-4111-8111-111111111111', projectId='22222222-2222-4222-8222-222222222222';
const ids=Array.from({length:10000},(_,i)=>`00000000-0000-4000-8000-${(i+1).toString(16).padStart(12,'0')}`);
afterEach(()=>{document.body.innerHTML='';});
it('lazily renders at most one page of a 10,000-item review',async()=>{
 const view=render(<MoveReviewItems ids={ids} media={new Map()}/>);expect(view.container.querySelectorAll('li')).toHaveLength(0);
 fireEvent.click(screen.getByText('查看要移动的音频'));await waitFor(()=>expect(view.container.querySelectorAll('li')).toHaveLength(50));
 expect(screen.getByText('1 / 200')).toBeVisible();expect(screen.getByRole('button',{name:'上一页音频'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'下一页音频'}));expect(screen.getByText('2 / 200')).toBeVisible();expect(view.container.querySelectorAll('li')).toHaveLength(50);expect(screen.getByText(ids[50])).toBeVisible();
 fireEvent.click(screen.getByText('查看要移动的音频'));await waitFor(()=>expect(view.container.querySelectorAll('li')).toHaveLength(0));
});
it('does not rerender for repeated pointer movement over the same target with 10,000 selected IDs',()=>{
 const organization=new OrganizationController(projectId,nonce,true,{} as never),recycle=new RecycleController(projectId,nonce,true,{} as never);
 organization.snapshot={kind:'audio-annotator-organization',formatVersion:1,projectId,revision:1,layoutRevision:1,folders:[],media:ids.map(mediaId=>({mediaId,folderId:null,originalFilename:'a.wav'}))};
 recycle.snapshot={kind:'audio-annotator-recycle',formatVersion:1,projectId,revision:1,trashed:[],recentOperations:[]};
 const target=document.createElement('div'),source=document.createElement('button');target.dataset.dropFolder='';document.body.append(target,source);
 Object.defineProperty(document,'elementFromPoint',{configurable:true,value:vi.fn(()=>target)});
 const options={organization,recycle,enabled:true,authorized:true,selected:new Set(ids),onComplete:vi.fn()};let renders=0;
 const hook=renderHook(()=>{renders++;return useTreeMove(options);});
 const event={pointerId:1,button:0,clientX:0,clientY:0,currentTarget:source,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false} as unknown as React.PointerEvent<HTMLButtonElement>;
 act(()=>hook.result.current.down(event,ids[0]));act(()=>hook.result.current.move({...event,clientX:20,clientY:20}));
 const afterFirst=renders;for(let i=0;i<100;i++)act(()=>hook.result.current.move({...event,clientX:20+i,clientY:20}));
 expect(hook.result.current.feedback?.count).toBe(10000);expect(renders).toBe(afterFirst);
});
