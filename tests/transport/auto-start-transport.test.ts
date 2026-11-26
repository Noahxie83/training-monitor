import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createTransport } from '../../src/transport/transport';
import type { Registry } from '../../src/shared/contracts';
class Child extends EventEmitter {stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();kill(){this.emit('close',null);return true;}}
const signal=new AbortController().signal;
async function setup(wsl=false){
 const registry:Registry={version:1,revision:1,hosts:[{hostId:'h',label:'h',enabled:true,allowedRoots:['/allowed'],target:wsl?{kind:'wsl',distribution:'Ubuntu-26.04'}:{kind:'ssh',alias:'lab-campus'}}],tasks:[{taskId:'t',hostId:'h',label:'t',algorithm:'',enabled:true,allowedDirectories:['/allowed/run'],entryPaths:['train.py'],checkpointDirectories:[],sources:[{sourceId:'log',kind:'log',path:'/allowed/run/new.log'}],autoStart:{enabled:true,armId:'12345678-1234-4234-8234-123456789abc',gpuDeviceIds:['GPU 6'],idleSeconds:10,maxUtilizationPercent:5,maxMemoryMiB:1024,launch:{pythonPath:'/usr/bin/python3',entryPath:'train.py',cwd:'/allowed/run',arguments:'--name "hello; touch /tmp/never"',logSourceId:'log'}}}]};
 const requests:any[]=[];const calls:any[]=[];let running=true;
 const probeSource=await readFile('src/probe/readonly_probe.py','utf8');const launcherSource=await readFile('src/launch/launcher.py','utf8');
 const spawn=(command:string,args:string[],options:any)=>{const child=new Child();calls.push({command,args,options});const chunks:Buffer[]=[];child.stdin.on('data',data=>chunks.push(Buffer.from(data)));child.stdin.once('end',()=>{
  const source=Buffer.concat(chunks).toString('utf8');let body:Buffer;
  if(command==='wsl.exe'&&args.includes('--list'))body=Buffer.from(running?'Ubuntu-26.04\n':'');
  else if(command.endsWith('nvidia-smi.exe'))body=Buffer.from('6, GPU-a, 0, 0, 24576');
  else {const encoded=source.match(/REQUEST_B64 = "([^"\n]+)"/)![1]!;const request=JSON.parse(Buffer.from(encoded,'base64').toString());requests.push(request);
   if(request.op==='launch_task'){const embedded=source.match(/PROBE_SOURCE_B64 = "([^"\n]+)"/)![1]!;expect(Buffer.from(embedded,'base64').toString()).toBe(probeSource);expect(source).not.toContain(request.launch.arguments);}
   const payload=request.op==='probe_host'?{hostBootId:'boot',scanComplete:true,errorCode:null,gpu:{status:'ok',csv:'6, GPU-a, 0, 0, 24576'}}:request.op==='probe_launch_readiness'?{scanComplete:true,running:false,errorCode:null}:{status:'started',pid:42,processKey:null,startedAt:'2026-11-11T00:00:00Z',errorCode:null};
   const data=Buffer.from(JSON.stringify({version:1,requestId:request.requestId,sourceId:null,payload}));const prefix=Buffer.alloc(4);prefix.writeUInt32BE(data.length);body=Buffer.concat([prefix,data]);}
  child.stdout.end(body);child.stderr.end();child.emit('close',0);});return child;};
 const transport=createTransport({hostId:'h',host:registry.hosts[0]!,registry},{probeSource,launcherSource,spawn,registryProvider:async()=>registry});
 return {transport,registry,requests,calls,stop:()=>running=false};
}
describe('registered launch transport',()=>{
 it.each([false,true])('frames a scoped launch and physical UUID for WSL=%s',async(wsl)=>{const f=await setup(wsl);await f.transport.probeHost(signal);expect(await f.transport.checkTaskStopped!(f.registry.tasks[0]!,signal)).toEqual({scanComplete:true,running:false,errorCode:null});const result=await f.transport.launchTask!(f.registry.tasks[0]!,f.registry.tasks[0]!.autoStart!.armId,'a'.repeat(64),signal);expect(result.status).toBe('started');expect(f.requests.at(-1)).toMatchObject({op:'launch_task',gpuDevices:[{deviceId:'GPU 6',uuid:'GPU-a'}],taskAllowedDirectories:['/allowed/run'],hostAllowedRoots:['/allowed']});expect(f.requests.find(r=>r.op==='probe_launch_readiness').task.sources).toEqual([]);expect(f.calls.every(call=>call.options.shell===false&&call.options.windowsHide)).toBe(true);});
 it('refuses launch after task configuration changed',async()=>{const f=await setup();await f.transport.probeHost(signal);const old=structuredClone(f.registry.tasks[0]!);f.registry.tasks[0]!.autoStart!.enabled=false;await expect(f.transport.launchTask!(old,old.autoStart!.armId,'a'.repeat(64),signal)).rejects.toThrow('REGISTRY_CHANGED');expect(f.requests.filter(r=>r.op==='launch_task')).toHaveLength(0);});
 it('never wakes stopped WSL even after a successful earlier sample',async()=>{const f=await setup(true);await f.transport.probeHost(signal);f.stop();await expect(f.transport.launchTask!(f.registry.tasks[0]!,f.registry.tasks[0]!.autoStart!.armId,'a'.repeat(64),signal)).rejects.toThrow('WSL_NOT_RUNNING');expect(f.requests.filter(r=>r.op==='launch_task')).toHaveLength(0);});
 it('requires a successful same transport GPU identity sample',async()=>{const f=await setup();await expect(f.transport.launchTask!(f.registry.tasks[0]!,f.registry.tasks[0]!.autoStart!.armId,'a'.repeat(64),signal)).rejects.toThrow('LAUNCH_SERVICE_UNAVAILABLE');expect(f.calls).toHaveLength(0);});
});
