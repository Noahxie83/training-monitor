// Test-only simulated provider. No filesystem, network, IPC or product entry point.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/renderer/App';
import '../../src/renderer/style.css';
import { createControlledMockApi, testFlowTask, testFlowSource, testHostConnected, testRegistry } from './fixtures';
import type { LogEvent } from '../../src/shared/contracts';
import type { MonitorSnapshot } from '../../src/shared/api';

function log(i: number, text = `SIMULATED fixture log ${i} training progress`) : LogEvent {
  return { version:1,eventId:`fixture-${i}`,taskId:'flow-cifar10',sourceId:'flow-log',generation:'gen-1',kind:'line',startOffset:String(Math.max(0,i)*100),endOffset:String(Math.max(0,i)*100+100),ingestedAt:'2026-10-18T00:00:00Z',text,reason:null,displayTruncated:false,recordComplete:true,prefixIncomplete:false,runId:null,bindingId:null };
}
const snapshot: MonitorSnapshot = {version:1,demo:true,hosts:[structuredClone(testHostConnected)],tasks:[structuredClone(testFlowTask)],sources:[structuredClone(testFlowSource)]};
snapshot.tasks[0].resources=[];
snapshot.tasks[0].processes={main:null,queue:null,workers:[]};
const api=createControlledMockApi({snapshot,registry:structuredClone(testRegistry)});
let latest=Array.from({length:500},(_,i)=>log(i));
let history=Array.from({length:50},(_,i)=>log(i-50));
api.getLogs=async query=>({events:structuredClone(query.before===null?latest:history),nextBefore:query.before===null?'fixture-older':null,truncatedByBudget:false});
window.monitor=api;
const fixture={
  push(start:number,count:number,text?:string){const events=Array.from({length:count},(_,i)=>log(start+i,text===undefined?undefined:`${text} ${start+i}`));api.emitUpdate({kind:'logs',sourceId:'flow-log',events});},
  redraw(id:number,text:string){api.emitUpdate({kind:'logs',sourceId:'flow-log',events:[{...log(id,text),kind:'redraw'}]});},
  history(start:number,count:number){history=Array.from({length:count},(_,i)=>log(start+i));},
  progress(fraction:number|null){
    const p=snapshot.tasks[0].progress;
    for(const view of [p.global,p.session]){view.fraction=fraction;view.completedCount=fraction===null?null:Math.round(fraction*1000);view.targetCount=fraction===null?null:1000;view.unit=fraction===null?'unknown':'completed_iterations';view.verified=fraction!==null;}
    api.emitUpdate({kind:'snapshot',snapshot});
  },
  snapshot(){api.emitUpdate({kind:'snapshot',snapshot});},
};
Object.assign(window,{simulatedRendererFixture:fixture});
createRoot(document.getElementById('root')!).render(<App/>);
