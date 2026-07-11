export type FakeRatingRow = {
  game_type: string;
  player_id: string;
  rating: number;
  games_played: number;
  updated_at: string;
};

export type FakeResultRow = {
  game_id: string;
  game_type: string;
  replay_hash: string;
  result_hash: string;
  claim_token: string;
  recorded_at: string;
  version_guard: number;
};

export type FakeVersionRow = {
  game_type: string;
  version: number;
  write_token: string;
  updated_at: string;
};

export type FakeAuditRow = {
  game_id: string;
  player_id: string;
  rank: number;
  rating_before: number;
  rating_after: number;
  delta: number;
};

export type LadderFakeStore = {
  players: Array<{ id: string; handle: string }>;
  versions: FakeVersionRow[];
  ratings: FakeRatingRow[];
  results: FakeResultRow[];
  audit: FakeAuditRow[];
  failBatchAt?: number;
  beforeRatingRead?: () => Promise<void>;
  forceStaleVersion?: boolean;
  batchAttempts?: number;
  staleVersionFailures?: number;
  prepareCount?: number;
};

export type FakeStatement = {
  readonly sql: string;
  readonly bindings: readonly unknown[];
  bind(...values: unknown[]): FakeStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

type VersionedClaim = {
  readonly gameId: unknown;
  readonly claimToken: unknown;
  readonly version: unknown;
  readonly writeToken: unknown;
};

function cloneRows<T>(rows: readonly T[]): T[] {
  return [...structuredClone(rows)];
}

export function ownsVersionedClaim(store: LadderFakeStore, claim: VersionedClaim): boolean {
  const result = store.results.find(
    (row) => row.game_id === claim.gameId && row.claim_token === claim.claimToken,
  );
  const ladderVersion = store.versions.find((row) => row.game_type === result?.game_type);
  if (!ladderVersion) return false;
  return ladderVersion.version === claim.version && ladderVersion.write_token === claim.writeToken;
}

export async function runFakeBatch(
  store: LadderFakeStore,
  statements: readonly FakeStatement[],
  execute: (sql: string, bindings: readonly unknown[]) => unknown,
): Promise<unknown[]> {
  store.batchAttempts = (store.batchAttempts ?? 0) + 1;
  const snapshot = {
    versions: cloneRows(store.versions),
    ratings: cloneRows(store.ratings),
    results: cloneRows(store.results),
    audit: cloneRows(store.audit),
  };
  try {
    const output: unknown[] = [];
    for (const [index, statement] of statements.entries()) {
      if (store.failBatchAt === index) throw new Error('injected D1 batch failure');
      output.push(execute(statement.sql, statement.bindings));
    }
    return output;
  } catch (error) {
    store.versions = snapshot.versions;
    store.ratings = snapshot.ratings;
    store.results = snapshot.results;
    store.audit = snapshot.audit;
    throw error;
  }
}
