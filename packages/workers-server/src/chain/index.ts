import type { Env } from '../env.js';
import type { ChainRelay } from './types.js';
import { MockRelay } from './mock-relay.js';
import { OnChainRelay } from './onchain-relay.js';

export type { ChainRelay } from './types.js';
export { MockRelay } from './mock-relay.js';
export { OnChainRelay } from './onchain-relay.js';

export function createRelay(env: Env): ChainRelay {
  return env.RPC_URL ? new OnChainRelay(env) : new MockRelay(env.DB);
}
