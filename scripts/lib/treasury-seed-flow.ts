export type TreasurySeedStatus = {
  readonly handle: string;
  readonly server: string;
  readonly address: string;
  readonly createdAt: string;
  readonly faucetCompletedAt?: string;
  readonly registeredAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTreasurySeedStatus(value: unknown): TreasurySeedStatus | null {
  if (!isRecord(value)) return null;
  const { handle, server, address, createdAt, faucetCompletedAt, registeredAt } = value;
  if (
    typeof handle !== 'string' ||
    typeof server !== 'string' ||
    typeof address !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  if (faucetCompletedAt !== undefined && typeof faucetCompletedAt !== 'string') return null;
  if (registeredAt !== undefined && typeof registeredAt !== 'string') return null;
  return {
    handle,
    server,
    address,
    createdAt,
    ...(faucetCompletedAt === undefined ? {} : { faucetCompletedAt }),
    ...(registeredAt === undefined ? {} : { registeredAt }),
  };
}

type TreasuryRegistrationOperations = {
  readonly faucet: () => Promise<void>;
  readonly register: () => Promise<void>;
  readonly registrationReady: () => Promise<boolean>;
  readonly authenticate: () => Promise<void>;
  readonly persist: (seed: TreasurySeedStatus) => Promise<void>;
  readonly now: () => string;
};

export async function ensureTreasuryRegistration(
  seed: TreasurySeedStatus,
  operations: TreasuryRegistrationOperations,
): Promise<TreasurySeedStatus> {
  let updated = seed;
  if (updated.faucetCompletedAt === undefined) {
    await operations.faucet();
    updated = { ...updated, faucetCompletedAt: operations.now() };
    await operations.persist(updated);
  }
  if (updated.registeredAt === undefined || !(await operations.registrationReady())) {
    await operations.register();
    updated = { ...updated, registeredAt: operations.now() };
    await operations.persist(updated);
  }
  await operations.authenticate();
  return updated;
}
