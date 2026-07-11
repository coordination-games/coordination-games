import { describe, expect, it } from 'vitest';
import {
  ensureTreasuryRegistration,
  parseTreasurySeedStatus,
  type TreasurySeedStatus,
} from '../../../../scripts/lib/treasury-seed-flow.js';

const SEED: TreasurySeedStatus = {
  handle: 'tournament-treasury',
  server: 'http://localhost:8787',
  address: '0x1234567890abcdef1234567890abcdef12345678',
  createdAt: '2026-07-11T00:00:00.000Z',
};

describe('ensureTreasuryRegistration', () => {
  it('Given a legacy seed lacking completion fields, when authentication would succeed, then registration still runs before authentication', async () => {
    const calls: string[] = [];
    const persisted: TreasurySeedStatus[] = [];

    const result = await ensureTreasuryRegistration(SEED, {
      faucet: async () => {
        calls.push('faucet');
      },
      register: async () => {
        calls.push('register');
      },
      registrationReady: async () => false,
      authenticate: async () => {
        calls.push('authenticate');
      },
      persist: async (seed) => {
        persisted.push(seed);
      },
      now: () => '2026-07-11T00:01:00.000Z',
    });

    expect(calls).toEqual(['faucet', 'register', 'authenticate']);
    expect(result.faucetCompletedAt).toBe('2026-07-11T00:01:00.000Z');
    expect(result.registeredAt).toBe('2026-07-11T00:01:00.000Z');
    expect(persisted).toHaveLength(2);
  });

  it('Given a seed with completed faucet and registration, when retrying, then skips network setup and authenticates only', async () => {
    const calls: string[] = [];
    const registered: TreasurySeedStatus = {
      ...SEED,
      faucetCompletedAt: '2026-07-11T00:01:00.000Z',
      registeredAt: '2026-07-11T00:02:00.000Z',
    };

    await ensureTreasuryRegistration(registered, {
      faucet: async () => {
        calls.push('faucet');
      },
      register: async () => {
        calls.push('register');
      },
      registrationReady: async () => true,
      authenticate: async () => {
        calls.push('authenticate');
      },
      persist: async () => {
        calls.push('persist');
      },
      now: () => '2026-07-11T00:03:00.000Z',
    });

    expect(calls).toEqual(['authenticate']);
  });

  it('Given completed local seed state but a stale D1 identity, when retrying, then re-registers to backfill before authentication', async () => {
    const calls: string[] = [];
    const registered: TreasurySeedStatus = {
      ...SEED,
      faucetCompletedAt: '2026-07-11T00:01:00.000Z',
      registeredAt: '2026-07-11T00:02:00.000Z',
    };

    await ensureTreasuryRegistration(registered, {
      faucet: async () => {
        calls.push('faucet');
      },
      register: async () => {
        calls.push('register');
      },
      registrationReady: async () => false,
      authenticate: async () => {
        calls.push('authenticate');
      },
      persist: async () => {
        calls.push('persist');
      },
      now: () => '2026-07-11T00:03:00.000Z',
    });

    expect(calls).toEqual(['register', 'persist', 'authenticate']);
  });
});

describe('parseTreasurySeedStatus', () => {
  it('Given a legacy seed status without completion fields, when parsed, then remains compatible', () => {
    expect(
      parseTreasurySeedStatus({
        handle: 'tournament-treasury',
        server: 'http://localhost:8787',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        createdAt: '2026-07-11T00:00:00.000Z',
      }),
    ).toEqual(SEED);
  });

  it.each([
    ['faucetCompletedAt', 1],
    ['registeredAt', false],
  ])('Given malformed optional %s, when parsed, then rejects the seed status', (field, malformedValue) => {
    expect(parseTreasurySeedStatus({ ...SEED, [field]: malformedValue })).toBeNull();
  });
});
