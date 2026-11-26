import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTransport } from '../../src/transport/transport';
import type { Registry } from '../../src/shared/contracts';

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { this.emit('close', null, 'SIGTERM'); return true; }
}

describe('registered GPU mapping through SSH frames', () => {
  it('passes same-host physical GPU identities, projects scoped data and rejects a changed boot', async () => {
    const registry: Registry = { version: 1, revision: 1,
      hosts: [{ hostId: 'h', label: 'h', enabled: true, allowedRoots: ['/allowed'], target: { kind: 'ssh', alias: 'lab-campus' } }],
      tasks: [{ taskId: 't', hostId: 'h', label: 't', enabled: true, algorithm: 'custom', logFormat: 'generic', allowedDirectories: ['/allowed/run'], entryPaths: ['train.py'], sources: [], checkpointDirectories: [] }] };
    let key = { hostBootId: 'boot-a', pid: 42, startTicks: '100' };
    let gpuError = false;
    const requests: any[] = [];
    const spawn = () => {
      const child = new Child();
      const chunks: Buffer[] = [];
      child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
      child.stdin.once('end', () => {
        const marker = Buffer.concat(chunks).toString('utf8').match(/REQUEST_B64 = "([^"]+)"/)![1]!;
        const request = JSON.parse(Buffer.from(marker, 'base64').toString('utf8'));
        requests.push(request);
        const payload = request.op === 'probe_host' ? { hostBootId: 'boot-a', scanComplete: true, errorCode: null,
          gpu: { status: 'ok', csv: '6, GPU-a, 98, 8192, 24576' } }
          : { scanComplete: true, errorCode: null, sources: [], processes: [{ processKey: key, role: 'unknown', roleEvidence: 'exact_script_entry', evidenceComplete: true,
            scriptEntry: '/allowed/run/train.py', cwd: '/allowed/run', writerSourceIds: [], writerSourceEvidence: {}, writerEvidenceComplete: false }],
          processGpu: gpuError ? { status: 'unavailable', errorCode: 'NVIDIA_SMI_TIMEOUT', samples: [], processKeys: [] }
            : { status: 'ok', processKeys: [key], samples: [{ processKey: key, keyBeforeSample: key, keyAfterSample: key, deviceId: 'GPU 6', memoryBytes: 1024, utilizationPercent: 74 }] } };
        const body = Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, sourceId: null, payload }));
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
        child.stdout.end(Buffer.concat([prefix, body])); child.stderr.end(); child.emit('close', 0, null);
      });
      return child;
    };
    const transport = createTransport({ hostId: 'h', host: registry.hosts[0]!, registry }, { probeSource: 'REQUEST_B64 = "__MONITOR_REQUEST_B64__"', spawn: spawn as never });
    const signal = new AbortController().signal;
    await transport.probeHost(signal);
    const current = await transport.probeTask(registry.tasks[0]!, signal);
    expect(requests[1]).toMatchObject({ includeProcessGpu: true, gpuDevices: [{ index: 6, uuid: 'GPU-a' }] });
    expect(current.processGpu?.metrics).toMatchObject([{ deviceId: 'GPU 6', scope: 'process', value: 1024 }, { deviceId: 'GPU 6', scope: 'process', value: 74 }]);
    key = { ...key, hostBootId: 'boot-b' };
    expect((await transport.probeTask(registry.tasks[0]!, signal)).processGpu?.metrics).toEqual([]);
    key = { ...key, hostBootId: 'boot-a' }; gpuError = true;
    const failed = await transport.probeTask(registry.tasks[0]!, signal);
    expect(failed).toMatchObject({ scanComplete: true, processScanError: null, processGpu: { state: 'unavailable', errorCode: 'NVIDIA_SMI_TIMEOUT' } });
  });
});
