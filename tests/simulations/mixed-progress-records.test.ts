import { describe, expect, it } from 'vitest';
import { createLiveMonitor } from './live-monitor-fixture';

describe('mixed progress and diagnostic lines', () => {
  it('keeps observed progress when STEP and RESULT lines follow the global bar', async () => {
    const fixture = await createLiveMonitor({
      initialLog: 'HDPS 0/1000 [00:00<10:00, 1.00it/s]\nSTEP job=a step=5/50\n',
      clockStepMs: 1,
    });
    try {
      await fixture.api.start();
      await fixture.api.requestRefresh({});
      fixture.append('HDPS 145/1000 [00:10<01:30, 10.0it/s]\nSTEP job=a step=10/50\n');
      await fixture.api.requestRefresh({});
      const first = (await fixture.api.getSnapshot()).tasks[0]!;
      expect(first.lifecycle).toBe('running');
      expect(first.progress.session.completedCount).toBe(145);
      expect(first.progress.session.targetCount).toBe(1000);

      fixture.append('RESULT job=a psnr=30.4 completed=3/20\n');
      const diagnostic = (await fixture.api.getSnapshot()).tasks[0]!;
      expect(diagnostic.progress.session.completedCount).toBe(145);

      fixture.append('HDPS 155/1000 [00:11<01:29, 10.0it/s]\nRESULT job=b completed=4/20\nSTEP job=c step=5/50\n');
      const advanced = (await fixture.api.getSnapshot()).tasks[0]!;
      expect(advanced.lifecycle).toBe('running');
      expect(advanced.progress.session.completedCount).toBe(155);
    } finally { await fixture.close(); }
  });

  it('does not treat diagnostics alone as a progress record', async () => {
    const fixture = await createLiveMonitor({ initialLog: 'health ok\nSTEP job=a step=5/50\n' });
    try {
      await fixture.api.start();
      fixture.append('RESULT job=a completed=1/20\n');
      const snapshot = (await fixture.api.getSnapshot()).tasks[0]!;
      expect(snapshot.lifecycle).not.toBe('running');
      expect(snapshot.progress.session.completedCount).toBeNull();
    } finally { await fixture.close(); }
  });
});
