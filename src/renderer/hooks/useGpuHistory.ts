import { useEffect, useState } from 'react';
import type { GpuSeriesPoint, HostSnapshot } from '../../shared/contracts';

const MAX_POINTS_PER_DEVICE = 90;

export function useGpuHistory(host: HostSnapshot | null | undefined): Record<string, GpuSeriesPoint[]> {
  const [history, setHistory] = useState<Record<string, GpuSeriesPoint[]>>({});
  const hostId = host?.hostId ?? null;
  const gpuObservedAt = host?.gpu?.observedAt ?? null;

  // Fetch persisted 15-minute history from SQLite v2 on host change
  useEffect(() => {
    let active = true;
    setHistory({});
    if (!hostId || !window.monitor?.getGpuSeries) return;
    window.monitor
      .getGpuSeries({ hostId, rangeMs: 15 * 60 * 1000, maxPoints: MAX_POINTS_PER_DEVICE })
      .then((res) => {
        if (!active) return;
        const grouped: Record<string, GpuSeriesPoint[]> = {};
        for (const pt of res.gpu ?? []) {
          const list = grouped[pt.deviceId] ?? [];
          list.push(pt);
          grouped[pt.deviceId] = list;
        }
        setHistory(grouped);
      })
      .catch(() => {
        // Silently ignore if history query is unsupported
      });
    return () => {
      active = false;
    };
  }, [hostId]);

  // Append incoming live snapshots so Sparklines grow smoothly in real time
  useEffect(() => {
    if (!host?.gpu || host.gpu.state !== 'available' || !gpuObservedAt) return;
    const gpu = host.gpu;
    const livePoints: GpuSeriesPoint[] = [];

    if (gpu.devices && gpu.devices.length > 0) {
      for (const dev of gpu.devices) {
        livePoints.push({
          observedAt: gpuObservedAt,
          deviceId: dev.deviceId,
          utilPct: dev.utilizationPct ?? null,
          memUsedMiB: dev.memoryUsedMiB ?? null,
          memTotalMiB: dev.memoryTotalMiB ?? null,
          tempC: dev.temperatureC ?? null,
          powerW: dev.powerDrawW ?? null,
        });
      }
    } else if (gpu.metrics.length > 0) {
      const byDevice = new Map<string, GpuSeriesPoint>();
      for (const m of gpu.metrics) {
        if (m.scope !== 'device' || !m.deviceId) continue;
        const pt = byDevice.get(m.deviceId) ?? {
          observedAt: gpuObservedAt,
          deviceId: m.deviceId,
          utilPct: null,
          memUsedMiB: null,
          memTotalMiB: null,
          tempC: null,
          powerW: null,
        };
        if (m.name === 'gpu_utilization' && m.value !== null) pt.utilPct = m.value;
        if (m.name === 'gpu_memory_used' && m.value !== null) pt.memUsedMiB = m.value / (1024 * 1024);
        if (m.name === 'gpu_memory_total' && m.value !== null) pt.memTotalMiB = m.value / (1024 * 1024);
        byDevice.set(m.deviceId, pt);
      }
      livePoints.push(...byDevice.values());
    }

    if (livePoints.length === 0) return;

    setHistory((prev) => {
      let changed = false;
      const next: Record<string, GpuSeriesPoint[]> = { ...prev };
      for (const pt of livePoints) {
        const list = next[pt.deviceId] ?? [];
        if (list[list.length - 1]?.observedAt === pt.observedAt) continue;
        next[pt.deviceId] = [...list, pt].slice(-MAX_POINTS_PER_DEVICE);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [host?.gpu, gpuObservedAt]);

  return history;
}
