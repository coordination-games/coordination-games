import type { Env } from '../env.js';
import { MockRelay } from './mock-relay.js';
import type { OnChainRelayEnv } from './onchain-relay.js';
import { OnChainRelay } from './onchain-relay.js';
import { StrictLocalRelay } from './strict-local-relay.js';
import type { ChainRelay } from './types.js';

export type RelayEnv = OnChainRelayEnv &
  Pick<Env, 'STRICT_LOCAL_SETTLEMENT' | 'TREASURY_AGENT_HANDLE'>;

export { MockRelay } from './mock-relay.js';
export { OnChainRelay } from './onchain-relay.js';
export { StrictLocalRelay } from './strict-local-relay.js';
export type { ChainRelay } from './types.js';

export function createRelay(env: RelayEnv): ChainRelay {
  if (env.RPC_URL) return new OnChainRelay(env);
  return env.STRICT_LOCAL_SETTLEMENT === 'true'
    ? new StrictLocalRelay(env.DB, env.TREASURY_AGENT_HANDLE)
    : new MockRelay(env.DB);
}
