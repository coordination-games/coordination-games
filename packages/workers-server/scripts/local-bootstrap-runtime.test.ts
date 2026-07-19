import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopProcessGroup } from './local-bootstrap-runtime.js';

describe('stopProcessGroup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given a permission error while sending SIGTERM, when stopping a group, then rejects instead of reporting cleanup', async () => {
    const permissionError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const kill = vi.fn(() => {
      throw permissionError;
    });

    await expect(stopProcessGroup(1234, kill)).rejects.toBe(permissionError);
  });

  it('Given the group disappears after SIGTERM, when probing cleanup, then probes the negative group id', async () => {
    const kill = vi.fn((processId: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      expect(processId).toBe(-1234);
      return true;
    });

    await stopProcessGroup(1234, kill);
    expect(kill).toHaveBeenCalledWith(-1234, 0);
  });

  it('Given a reparented group probe after the owned child exits, when cleanup sees EPERM, then resolves', async () => {
    const permissionError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const kill = vi.fn((_: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) throw permissionError;
      return true;
    });

    await expect(stopProcessGroup(1234, kill, () => true)).resolves.toBeUndefined();
  });

  it('Given a reparented group probe before the owned child exits, when cleanup sees EPERM, then waits for the child', async () => {
    vi.useFakeTimers();
    let exited = false;
    const permissionError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const kill = vi.fn((_: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) throw permissionError;
      return true;
    });
    const stopped = stopProcessGroup(1234, kill, () => exited);

    await vi.advanceTimersByTimeAsync(50);
    exited = true;
    await vi.advanceTimersByTimeAsync(50);

    await expect(stopped).resolves.toBeUndefined();
  });

  it('Given a group that survives SIGKILL, when the forced verification deadline expires, then rejects instead of polling forever', async () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    const stopped = stopProcessGroup(1234, kill);
    const rejection = expect(stopped).rejects.toThrow(
      'Process group -1234 remained alive after SIGKILL',
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });

  it('Given a group that disappears after SIGKILL, when forced verification probes it, then resolves and clears timers', async () => {
    vi.useFakeTimers();
    let killed = false;
    const kill = vi.fn((_: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGKILL') killed = true;
      if (signal === 0 && killed) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      return true;
    });
    const stopped = stopProcessGroup(1234, kill);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopped).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
