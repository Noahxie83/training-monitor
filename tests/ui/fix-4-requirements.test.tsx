// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useLogBuffer } from '../../src/renderer/hooks/useLogBuffer';
import { useMonitor } from '../../src/renderer/hooks/useMonitor';
import { App } from '../../src/renderer/App';
import { KpiMetricsGrid } from '../../src/renderer/components/KpiMetricsGrid';
import { EvidenceDrawer } from '../../src/renderer/components/EvidenceDrawer';
import { useFocusTrap } from '../../src/renderer/hooks/useFocusTrap';
import type { LogEvent, ResourceMetric } from '../../src/shared/contracts';
import type { LogPage } from '../../src/shared/api';
import { createControlledMockApi, testFlowSource, testFlowTask, testScoreTask } from './fixtures';

export function event(id: string, text = id): LogEvent {
  return { version: 1, eventId: id, text, taskId: 'flow-cifar10', sourceId: 'flow-log', generation: 'gen-1', kind: 'line', startOffset: '0', endOffset: '1', ingestedAt: '2026-10-18T00:00:00Z', reason: null, displayTruncated: false, recordComplete: true, prefixIncomplete: false, runId: null, bindingId: null };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (err: Error) => void; const promise = new Promise<T>((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
const page = (events: LogEvent[], nextBefore: string | null = null, truncatedByBudget = false): LogPage => ({ events, nextBefore, truncatedByBudget });
afterEach(cleanup);

describe('fix4 request ordering and resident budgets', () => {
  it.each(['success', 'failure'] as const)('I3: old initial %s cannot overwrite completed reload cursor, error, truncation or live redraw', async (outcome) => {
    const initial = deferred<LogPage>(); const fresh = deferred<LogPage>();
    const api = createControlledMockApi(); api.getLogs = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise); window.monitor=api;
    const {result}=renderHook(()=>useLogBuffer('flow-cifar10',[testFlowSource]));
    act(()=>api.emitUpdate({kind:'logs',sourceId:'flow-log',events:[event('live','new live')]}));
    act(()=>result.current.reloadFromLatest());
    await act(async()=>fresh.resolve(page([event('live','old page'),event('fresh')],'new-cursor')));
    expect(result.current.nextBefore).toBe('new-cursor');
    await act(async()=>outcome==='success' ? initial.resolve(page([event('stale')],'old-cursor',true)) : initial.reject(new Error('old initial failed')));
    expect(result.current.nextBefore).toBe('new-cursor'); expect(result.current.truncatedByBudget).toBe(false); expect(result.current.initialFetchError).toBeNull();
    expect(result.current.events.map(e=>e.text)).toEqual(['fresh','new live']);
  });

  it('I11: first search page and hidden live share 8MiB, continuation upserts and preserves fresh hits', async()=>{
    const api=createControlledMockApi(); api.getLogs=async()=>page(Array.from({length:70},(_,i)=>event('live'+i,'中'.repeat(22000))));
    api.searchLogs=async q=>({events:q.continuation ? [event('hit69','updated'),event('later','新'.repeat(22000))] : Array.from({length:70},(_,i)=>event('hit'+i,'中'.repeat(22000))),continuation:q.continuation?null:'next',scope:'retained_local',cancelled:false}); window.monitor=api;
    const {result}=renderHook(()=>useLogBuffer('flow-cifar10',[testFlowSource])); await waitFor(()=>expect(result.current.events.length).toBe(70));
    await act(async()=>{await result.current.executeSearch('hit');});
    expect(result.current.totalBufferedBytes).toBeLessThanOrEqual(8388608);
    expect(result.current.events).toHaveLength(70);
    for(const e of result.current.events)expect(new TextEncoder().encode(e.text!).length).toBeLessThanOrEqual(65536);
    // hidden live takes only the remaining capacity: 128 previews at 65535 bytes each.
    expect(result.current.totalBufferedCount).toBe(128); expect(result.current.totalBufferedBytes).toBe(8388480);
    act(()=>api.emitUpdate({kind:'logs',sourceId:'flow-log',events:[event('during','d'.repeat(65536))]}));
    expect(result.current.totalBufferedBytes).toBeLessThanOrEqual(8388608);
    await act(async()=>{await result.current.loadMoreSearchResults();});
    expect(result.current.events.find(e=>e.eventId==='hit69')?.text).toBe('updated');
    expect(result.current.events.at(-1)?.eventId).toBe('later'); expect(result.current.totalBufferedBytes).toBeLessThanOrEqual(8388608);
    act(()=>result.current.clearSearch()); expect(result.current.totalBufferedBytes).toBe(new TextEncoder().encode(result.current.events.map(e=>e.text).join('')).length);
  });

  it('I11: an oversized first search page alone is bounded by actual UTF8 bytes',async()=>{
    const api=createControlledMockApi();api.getLogs=async()=>page([]);
    api.searchLogs=async()=>({events:Array.from({length:140},(_,i)=>event(`first${i}`,'中'.repeat(22000))),continuation:null,scope:'retained_local',cancelled:false});window.monitor=api;
    const {result}=renderHook(()=>useLogBuffer('flow-cifar10',[testFlowSource]));await waitFor(()=>expect(result.current.isLoadingInitial).toBe(false));
    await act(async()=>{await result.current.executeSearch('first');});
    const retained=result.current.events;expect(retained).toHaveLength(128);expect(retained.at(-1)?.eventId).toBe('first139');
    expect(retained.every(e=>e.displayTruncated && new TextEncoder().encode(e.text!).byteLength===65535)).toBe(true);
    expect(result.current.totalBufferedBytes).toBe(8388480);expect(result.current.totalBufferedCount).toBe(128);expect(result.current.residentEvicted).toBe(true);
  });

  it('I11: continuation crossing exactly-full search marks actual eviction and retains its fresh hit',async()=>{
    const api=createControlledMockApi();api.getLogs=async()=>page([]);
    api.searchLogs=async q=>({events:q.continuation?[event('fresh-continuation')]:Array.from({length:10000},(_,i)=>event(`cap${i}`)),continuation:q.continuation?null:'more',scope:'retained_local',cancelled:false});window.monitor=api;
    const {result}=renderHook(()=>useLogBuffer('flow-cifar10',[testFlowSource]));await waitFor(()=>expect(result.current.isLoadingInitial).toBe(false));
    await act(async()=>{await result.current.executeSearch('cap');});expect(result.current.residentEvicted).toBe(false);
    await act(async()=>{await result.current.loadMoreSearchResults();});expect(result.current.totalBufferedCount).toBe(10000);expect(result.current.events[0].eventId).toBe('cap1');expect(result.current.events.at(-1)?.eventId).toBe('fresh-continuation');expect(result.current.residentEvicted).toBe(true);
  });

  it('I11: 10000 unique total across live/search, replacement releases previous hits and live shared ID redraw is canonical', async()=>{
    const api=createControlledMockApi(); api.getLogs=async()=>page(Array.from({length:6000},(_,i)=>event('live'+i)));
    api.searchLogs=async q=>({events:q.literal==='second'?[event('replacement')]:Array.from({length:6000},(_,i)=>event('hit'+i)),continuation:null,scope:'retained_local',cancelled:false}); window.monitor=api;
    const {result}=renderHook(()=>useLogBuffer('flow-cifar10',[testFlowSource]));await waitFor(()=>expect(result.current.events.length).toBe(6000));
    await act(async()=>{await result.current.executeSearch('first');});expect(result.current.totalBufferedCount).toBe(10000);expect(result.current.events.length).toBe(6000);
    act(()=>api.emitUpdate({kind:'logs',sourceId:'flow-log',events:[event('hit5999','new redraw')]}));expect(result.current.events.at(-1)?.text).toBe('new redraw');expect(result.current.totalBufferedCount).toBeLessThanOrEqual(10000);
    await act(async()=>{await result.current.executeSearch('second');});expect(result.current.events.map(e=>e.eventId)).toEqual(['replacement']);expect(result.current.totalBufferedCount).toBeLessThan(6000);
  });
});

describe('fix4 independent operation state',()=>{
  it('I16: preferences read retry exposes loading and keeps snapshot success',async()=>{
    const retry=deferred<{theme:'light'}>(); const api=createControlledMockApi();api.getPreferences=vi.fn().mockRejectedValueOnce(new Error('prefs unavailable')).mockReturnValueOnce(retry.promise);window.monitor=api;
    render(<App/>);await screen.findByText(/读取偏好设置失败/);expect(screen.getByRole('heading',{name:'flow-cifar10'})).toBeDefined();
    fireEvent.click(screen.getByRole('button',{name:'重试读取偏好设置'}));expect(screen.getByText('正在读取偏好设置…')).toBeDefined();
    await act(async()=>retry.resolve({theme:'light'}));expect(document.querySelector('.app-shell')?.getAttribute('data-theme')).toBe('light');expect(screen.queryByText(/读取偏好设置失败/)).toBeNull();
  });
  it.each(['success','failure'] as const)('I16: older save %s cannot mask newer save success or loading',async outcome=>{
    const a=deferred<{theme:'dark'}>();const b=deferred<{theme:'light'}>();const api=createControlledMockApi();api.savePreferences=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);window.monitor=api;
    const {result}=renderHook(()=>useMonitor());await waitFor(()=>expect(result.current.snapshot).not.toBeNull());
    let first!:Promise<unknown>;let second!:Promise<unknown>;
    act(()=>{first=result.current.updatePreferences({theme:'dark'}).catch(()=>{});second=result.current.updatePreferences({theme:'light'});});
    expect(result.current.isSavingPreferences).toBe(true);
    await act(async()=>{b.resolve({theme:'light'});await second;});expect(result.current.isSavingPreferences).toBe(false);
    await act(async()=>{outcome==='success'?a.resolve({theme:'dark'}):a.reject(new Error('stale failure'));await first;});
    expect(result.current.preferences.theme).toBe('light');expect(result.current.error).toBeNull();
  });
  it('I16: failed latest save preserves successful preferences, and retry exposes saving then clears the error',async()=>{
    const recovery=deferred<{theme:'light'}>();const api=createControlledMockApi();api.savePreferences=vi.fn().mockRejectedValueOnce(new Error('save unavailable')).mockReturnValueOnce(recovery.promise);window.monitor=api;
    const {result}=renderHook(()=>useMonitor());await waitFor(()=>expect(result.current.snapshot).not.toBeNull());
    const previous=result.current.preferences;await act(async()=>{await result.current.updatePreferences({theme:'light'}).catch(()=>{});});
    expect(result.current.preferences).toEqual(previous);expect(result.current.preferencesSaveError).toContain('save unavailable');expect(result.current.isSavingPreferences).toBe(false);
    let request!:Promise<void>;act(()=>{request=result.current.updatePreferences({theme:'light'});});expect(result.current.isSavingPreferences).toBe(true);expect(result.current.preferencesSaveError).toBeNull();
    await act(async()=>{recovery.resolve({theme:'light'});await request;});expect(result.current.preferences.theme).toBe('light');expect(result.current.isSavingPreferences).toBe(false);expect(result.current.preferencesSaveError).toBeNull();
  });

  it('I16: snapshot and log reads show loading through retry; all rejected reads/refreshes settle without unhandled rejection',async()=>{
    const snapshot=deferred<any>();const logs=deferred<LogPage>(); const api=createControlledMockApi(); const original=api.getSnapshot;api.getSnapshot=vi.fn().mockReturnValueOnce(snapshot.promise).mockImplementationOnce(original);api.getLogs=vi.fn().mockReturnValueOnce(logs.promise).mockResolvedValue(page([event('recovered')]));api.requestRefresh=async()=>{throw new Error('refresh unavailable');};window.monitor=api;
    const unhandled=vi.fn();window.addEventListener('unhandledrejection',unhandled);render(<App/>);
    expect(screen.getByText('正在读取监控快照…')).toBeDefined();await act(async()=>snapshot.reject(new Error('snapshot unavailable')));fireEvent.click(screen.getByRole('button',{name:'重试'}));
    await screen.findByText('正在读取日志…');await act(async()=>logs.reject(new Error('logs unavailable')));fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('recovered');
    fireEvent.click(screen.getByRole('button',{name:/刷新全部宿主/}));await screen.findByText(/刷新观测数据失败/);expect(unhandled).not.toHaveBeenCalled();window.removeEventListener('unhandledrejection',unhandled);
  });
});

it('I8/I10: every matched main/queue/worker CPU,RSS,GPU and device value retains its own stamp/source/unit',()=>{
  const task=structuredClone(testFlowTask);task.processes.queue=structuredClone(testScoreTask.processes.queue);task.resources=[];
  const processes=[task.processes.main!,task.processes.queue!,...task.processes.workers];
  for(const [i,p] of processes.entries())for(const [j,name] of ['cpu_utilization','process_rss','gpu_memory_used'].entries())task.resources.push({scope:'process',processKey:p.key!,deviceId:name==='gpu_memory_used'?'GPU-1':null,name:name as ResourceMetric['name'],unit:name==='cpu_utilization'?'percent_one_cpu':'bytes',value:11+i*10+j,source:`sample-${i}-${j}`,observedAt:`2026-10-18T01:0${i}:0${j}Z`,freshness:i%2?'stale':'fresh'});
  task.resources.push({scope:'process',processKey:{...processes[2].key!,startTicks:'wrong'},deviceId:'GPU-1',name:'gpu_memory_used',unit:'bytes',value:999999,source:'wrong-start',observedAt:null,freshness:'stale'}, {scope:'process',processKey:{...processes[0].key!,hostBootId:'wrong'},deviceId:null,name:'cpu_utilization',unit:'percent_one_cpu',value:999,source:'wrong-boot',observedAt:null,freshness:'stale'}, {scope:'device',processKey:null,deviceId:'GPU-1',name:'gpu_memory_used',unit:'bytes',value:77,source:'device-sample',observedAt:'2026-10-18T02:00:00Z',freshness:'stale'});
  const {container}=render(<><KpiMetricsGrid task={task}/><EvidenceDrawer task={task} isOpen onClose={()=>{}}/></>);
  for(const metric of task.resources.filter(m=>!m.source.startsWith('wrong'))){const rows=Array.from(container.querySelectorAll('[data-resource-source]')).filter(el=>el.getAttribute('data-resource-source')===metric.source);expect(rows).toHaveLength(2);for(const row of rows){expect(row.textContent).toContain(metric.unit);expect(row.textContent).toContain(metric.observedAt);expect(row.textContent).toContain(metric.freshness==='stale'?'陈旧':'新鲜');}}
  expect(container.textContent).not.toContain('wrong-start');expect(container.textContent).not.toContain('wrong-boot');
});

it('I14: viewport Space keyCode229 does not prevent default or toggle lock',async()=>{
  window.monitor=createControlledMockApi({logs:[event('a')]});render(<App/>);await screen.findByText('a');const viewport=screen.getByRole('region',{name:'日志流视窗'});viewport.focus();
  const e=new KeyboardEvent('keydown',{key:' ',code:'Space',keyCode:229,bubbles:true,cancelable:true});fireEvent(viewport,e);expect(e.defaultPrevented).toBe(false);expect(screen.getByRole('button',{name:'⏸ 锁定自动滚动'})).toBeDefined();
});

it('NB6: releases only its inert ownership before restoring connected usable opener',()=>{
  const focusObservations: boolean[]=[];
  function Trap({open}:{open:boolean}){const ref=useFocusTrap(open,()=>{});return <div className="app-shell"><div className="app-header"><button onFocus={()=>focusObservations.push(Boolean(document.querySelector('.app-header[inert]')))}>opener</button></div><div className="existing" inert>already inert</div>{open&&<div className="modal-overlay"><div ref={ref}><button>inside</button></div></div>}</div>;}
  const {rerender}=render(<Trap open={false}/>);const opener=screen.getByText('opener');opener.focus();rerender(<Trap open/>);expect(document.querySelector('.app-header')?.hasAttribute('inert')).toBe(true);rerender(<Trap open={false}/>);
  expect(focusObservations).toEqual([false,false]);expect(document.activeElement).toBe(opener);expect(document.querySelector('.existing')?.hasAttribute('inert')).toBe(true);
});

it('I6: asynchronously loaded selected row establishes current anchor and warns only once that row is actually evicted',async()=>{
  const initial=deferred<LogPage>();const api=createControlledMockApi();api.getLogs=()=>initial.promise;window.monitor=api;render(<App/>);
  await act(async()=>initial.resolve(page(Array.from({length:30},(_,i)=>event(`row${i}`)))));
  const row=screen.getByText('row0');expect(row.closest('.log-event-row')).not.toBeNull();const selection=window.getSelection()!;const range=document.createRange();range.selectNodeContents(row);selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toContain('row0');fireEvent(document,new Event('selectionchange'));
  act(()=>api.emitUpdate({kind:'logs',sourceId:'flow-log',events:[event('next')]}));expect(screen.queryByText(/当前阅读位置已被缓冲区淘汰/)).toBeNull();
  act(()=>api.emitUpdate({kind:'logs',sourceId:'flow-log',events:Array.from({length:10000},(_,i)=>event(`new${i}`))}));expect(screen.getByText(/当前阅读位置已被缓冲区淘汰/)).toBeDefined();selection.removeAllRanges();
});
