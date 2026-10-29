import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import fixture from '../../../tests/fixtures/document-v3.json';
import {MediaList} from './MediaList';
import {useMediaNavigation} from './useMediaNavigation';
vi.mock('./useMediaNavigation',async original=>{const actual=await original<typeof import('./useMediaNavigation')>();return {...actual,useMediaNavigation:vi.fn(actual.useMediaNavigation)};});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('skips unchanged DTO rows while actions target the current owner and real data changes still render',()=>{
 const first=vi.fn(),latest=vi.fn(),props={media:fixture.media,annotations:fixture.annotations,statuses:[],selectedId:null,disabled:false,onSelect:first,onImport:vi.fn(),onRelink:vi.fn()};
 const ui=render(<MediaList {...props}/>),renders=vi.mocked(useMediaNavigation).mock.calls.length;
 ui.rerender(<MediaList {...props} media={structuredClone(props.media)} annotations={structuredClone(props.annotations)} statuses={[]} onSelect={latest}/>);
 expect(useMediaNavigation).toHaveBeenCalledTimes(renders);
 fireEvent.click(screen.getByRole('button',{name:fixture.media[0].displayName}));expect(latest).toHaveBeenCalledWith(fixture.media[0].id);expect(first).not.toHaveBeenCalled();
 const changed=structuredClone(props.media);changed[0].displayName='renamed.wav';ui.rerender(<MediaList {...props} media={changed} onSelect={latest}/>);
 expect(screen.getByRole('button',{name:'renamed.wav'})).toBeTruthy();expect(vi.mocked(useMediaNavigation).mock.calls.length).toBeGreaterThan(renders);
});
