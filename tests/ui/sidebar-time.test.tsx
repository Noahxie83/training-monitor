// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TaskFleetTree } from '../../src/renderer/components/TaskFleetTree';
import { formatTimestamp, formatTimeOnly } from '../../src/renderer/utils/format';
import { testHostConnected, testFlowTask, testScoreTask } from './fixtures';

afterEach(cleanup);

describe('single sidebar and local observation time', () => {
  it('keeps the full task list after resizing and allows selecting a task', () => {
    const onSelectTask = vi.fn();
    const { container } = render(<TaskFleetTree hosts={[testHostConnected]} tasks={[testFlowTask, testScoreTask]} activeTaskId={testFlowTask.taskId} onSelectTask={onSelectTask} />);
    fireEvent.resize(window);
    expect(container.querySelector('.task-fleet-panel')?.className).toBe('task-fleet-panel');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /展开|精简/ })).toBeNull();
    fireEvent.click(screen.getByText('Score-based').closest('button')!);
    expect(onSelectTask).toHaveBeenCalledWith(testScoreTask.taskId);
  });

  it('formats UTC timestamps in the computer timezone, including date rollover', () => {
    const iso = '2026-10-21T16:21:42.013Z';
    const parts = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const time = `${part('hour')}:${part('minute')}:${part('second')}`;
    expect(formatTimestamp(iso)).toBe(`${part('year')}-${part('month')}-${part('day')} ${time}`);
    expect(formatTimeOnly(iso)).toBe(time);
  });

  it('keeps missing observation times unknown', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimeOnly(null)).toBe('—');
  });
});
