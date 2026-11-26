import { describe, expect, it } from 'vitest';
import { validateAutoStartConfig } from '../../src/shared/auto-start';
import { buildAutoStartPayload, createAutoStartDraft, sameAutoStartPayload } from '../../src/renderer/components/AutoStartFields';

const scope = { entryPaths:['/run/start.py'], allowedDirectories:['/run'], sources:[{sourceId:'log',kind:'log' as const,path:'/run/log.txt'},{sourceId:'status',kind:'status_json' as const,path:'/run/status.json'}] };
const config = {execution:'server_tmux' as const, enabled:true,armId:'12345678-1234-4234-8234-123456789abc',gpuDeviceIds:[],idleSeconds:60,maxUtilizationPercent:100,maxMemoryMiB:1048576,minFreeMemoryMiB:8192,minFreeDiskMiB:1024,gpuSharing:{groupId:'hdps',maxDevices:3,maxWorkersPerDevice:2},retryOnExit:true,launch:{pythonPath:'/env/bin/python',entryPath:'/run/start.py',cwd:'/run',arguments:'',logSourceId:'log'}};

describe('GPU free-memory sharing settings',()=>{
  it('preserves 8 GiB, three GPUs, two workers and 1 GiB disk through editing',()=>{
    expect(validateAutoStartConfig(config,scope)).toEqual(config);
    const context={...scope,hasStatusSource:true,logSources:[scope.sources[0]!]};
    const draft=createAutoStartDraft(config,context);
    const {payload,error}=buildAutoStartPayload(draft,context);
    expect(error).toBeNull();expect(payload).toMatchObject({minFreeMemoryMiB:8192,minFreeDiskMiB:1024,gpuSharing:{groupId:'hdps',maxDevices:3,maxWorkersPerDevice:2}});
    expect(sameAutoStartPayload(payload!,config)).toBe(true);
    expect(sameAutoStartPayload({...payload!,minFreeMemoryMiB:4096},config)).toBe(false);
  });
  it('rejects sharing without a memory threshold or with invalid group limits',()=>{
    expect(()=>validateAutoStartConfig({...config,minFreeMemoryMiB:undefined},scope)).toThrow('INVALID_AUTO_START');
    expect(()=>validateAutoStartConfig({...config,gpuSharing:{...config.gpuSharing,maxDevices:0}},scope)).toThrow('INVALID_AUTO_START');
    expect(()=>validateAutoStartConfig({...config,gpuSharing:{...config.gpuSharing,maxWorkersPerDevice:0}},scope)).toThrow('INVALID_AUTO_START');
  });
});
