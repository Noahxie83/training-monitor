import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchConfigHash } from '../../src/launch/controller';
import { cancelChangedServerWaits } from '../../src/launch/reconcile';
import { autoRegistry } from './auto-start.test';
import type { Registry } from '../../src/shared/contracts';
import type { ServerWaitResult, Transport } from '../../src/transport/types';

const controllerSignal = new AbortController().signal;

function serverRegistry(): Registry {
  const registry = autoRegistry();
  registry.tasks[0]!.autoStart!.execution = 'server_tmux';
  registry.tasks[0]!.autoStart!.gpuDeviceIds = [];
  return registry;
}

function wslRegistry(): Registry {
  const registry = autoRegistry();
  registry.hosts[0]!.target = { kind: 'wsl', distribution: 'Ubuntu-26.04' };
  return registry;
}

function cancelled(taskId: string, armId: string, hash: string): ServerWaitResult {
  return { state: 'cancelled', armId, configHash: hash, idleElapsedSeconds: 0, requiredIdleSeconds: 10,
    lastCheckedAt: null, startedAt: null, pid: null, errorCode: null, message: null,
    sessionName: `monitor-${taskId}`, selectedDeviceId: null };
}

function mockTransport() {
  return { cancelServerWait: vi.fn() } as unknown as Transport & { cancelServerWait: ReturnType<typeof vi.fn> };
}

async function reconcile(current: Registry, next: Registry) {
  const transports = new Map([[current.hosts[0]!, mockTransport()]]);
  const oldTask = current.tasks[0]!;
  const oldHash = launchConfigHash(current.hosts[0]!, oldTask);
  transports.get(current.hosts[0]!)!.cancelServerWait!.mockResolvedValue(cancelled(oldTask.taskId, oldTask.autoStart!.armId, oldHash));
  const provider = vi.fn(async (host: typeof current.hosts[number]) => transports.get(host)!);
  await cancelChangedServerWaits(current, next, provider, controllerSignal);
  return { provider, transport: transports.get(current.hosts[0]!)! };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('changed server wait reconciliation', () => {
  it('cancels once when a server wait task is disabled', async () => {
    const current = serverRegistry();
    const next = structuredClone(current);
    next.tasks[0]!.autoStart!.enabled = false;
    const { provider, transport } = await reconcile(current, next);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(current.hosts[0]!, current);
    expect(transport.cancelServerWait).toHaveBeenCalledTimes(1);
    expect(transport.cancelServerWait).toHaveBeenCalledWith(current.tasks[0]!, expect.any(String), controllerSignal);
  });

  it.each(['delete', 'disable', 'host-disable', 'scope-change'] as const)('cancels a %s change', async (kind) => {
    const current = serverRegistry();
    const next = structuredClone(current);
    if (kind === 'delete') next.tasks.splice(0, 1);
    if (kind === 'disable') next.tasks[0]!.enabled = false;
    if (kind === 'host-disable') next.hosts[0]!.enabled = false;
    if (kind === 'scope-change') next.tasks[0]!.allowedDirectories = ['/changed'];
    const { transport } = await reconcile(current, next);
    expect(transport.cancelServerWait).toHaveBeenCalledTimes(1);
    expect(transport.cancelServerWait.mock.calls[0]![0]).toBe(current.tasks[0]!);
    expect(transport.cancelServerWait.mock.calls[0]![1]).toBeTypeOf('string');
    expect(transport.cancelServerWait.mock.calls[0]![2]).toBe(controllerSignal);
  });

  it('does not cancel an unchanged server wait task', async () => {
    const current = serverRegistry();
    const next = structuredClone(current);
    next.revision += 1;
    next.tasks[0]!.label = 'renamed';
    const { transport } = await reconcile(current, next);
    expect(transport.cancelServerWait).not.toHaveBeenCalled();
  });

  it('does not cancel a structuredClone label edit', async () => {
    const current = serverRegistry();
    const next = structuredClone(current);
    next.tasks[0]!.label = 'renamed';
    const { transport } = await reconcile(current, next);
    expect(transport.cancelServerWait).not.toHaveBeenCalled();
  });

  it('cancels a detached wait on a disabled old SSH host', async () => {
    const current = serverRegistry();
    current.hosts[0]!.enabled = false;
    const next = structuredClone(current);
    next.tasks.splice(0, 1);
    const { transport } = await reconcile(current, next);
    expect(transport.cancelServerWait).toHaveBeenCalledTimes(1);
  });

  it('does not cancel unrelated legacy or WSL configuration changes', async () => {
    const legacy = autoRegistry();
    delete legacy.tasks[0]!.autoStart!.execution;
    const nextLegacy = structuredClone(legacy);
    nextLegacy.tasks[0]!.allowedDirectories = ['/changed'];
    const wsl = wslRegistry();
    const nextWsl = structuredClone(wsl);
    nextWsl.tasks[0]!.allowedDirectories = ['/changed'];
    const { transport } = await reconcile(wsl, nextWsl);
    await reconcile(legacy, nextLegacy);
    expect(transport.cancelServerWait).not.toHaveBeenCalled();
  });

  it('accepts missing and started terminal confirmations', async () => {
    const current = serverRegistry();
    const next = structuredClone(current);
    next.tasks[0]!.autoStart!.enabled = false;
    const currentTransport = mockTransport();
    const provider = vi.fn(async () => currentTransport);
    const oldHash = launchConfigHash(current.hosts[0]!, current.tasks[0]!);
    const first = cancelled('t', current.tasks[0]!.autoStart!.armId, oldHash);
    const second = { ...first, state: 'started' as const, pid: 42 };
    const third = { ...first, state: 'missing' as const };
    const responses = [first, second, third];
    currentTransport.cancelServerWait.mockImplementation(async () => responses.shift()!);
    await cancelChangedServerWaits(current, next, provider, controllerSignal);
    await cancelChangedServerWaits(current, next, provider, controllerSignal);
    await cancelChangedServerWaits(current, next, provider, controllerSignal);
    expect(currentTransport.cancelServerWait).toHaveBeenCalledTimes(3);
    expect(responses).toHaveLength(0);
    expect(currentTransport.cancelServerWait.mock.calls.map(call => call[1])).toEqual([oldHash, oldHash, oldHash]);
  });

  it('rejects unavailable transports and nonterminal responses without cancellation', async () => {
    const current = serverRegistry();
    const next = structuredClone(current);
    next.tasks[0]!.autoStart!.enabled = false;
    const empty = {} as Transport;
    await expect(cancelChangedServerWaits(current, next, async () => empty, controllerSignal)).rejects.toThrow('无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改');
    const waiting = mockTransport();
    waiting.cancelServerWait.mockResolvedValue({ state: 'waiting' } as ServerWaitResult);
    await expect(cancelChangedServerWaits(current, next, async () => waiting, controllerSignal)).rejects.toThrow('无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改');
    const mismatched = mockTransport();
    mismatched.cancelServerWait.mockResolvedValue(cancelled('other', 'wrong', 'wrong'));
    await expect(cancelChangedServerWaits(current, next, async () => mismatched, controllerSignal)).rejects.toThrow('无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改');
    const rejected = mockTransport();
    rejected.cancelServerWait.mockRejectedValue(new Error('CONNECTION_LOST'));
    await expect(cancelChangedServerWaits(current, next, async () => rejected, controllerSignal)).rejects.toThrow('无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改');
  });

  it('returns the same Chinese uncertainty error after an abort', async () => {
    const current = serverRegistry();
    const next = structuredClone(current);
    next.tasks[0]!.autoStart!.enabled = false;
    const controller = new AbortController();
    controller.abort();
    await expect(cancelChangedServerWaits(current, next, async () => mockTransport(), controller.signal)).rejects.toThrow('无法确认服务器取消等待，原规则仍可能运行，请重新连接后再修改');
  });
});
