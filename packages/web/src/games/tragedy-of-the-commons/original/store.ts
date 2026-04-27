import { useSyncExternalStore } from 'react';

export interface HexTile {
  q: number;
  r: number;
  terrain: string;
  productionNumber: number;
  revealed: boolean;
  revealedBy?: string[];
  regionId?: string;
  regionName?: string;
  biome?: string;
  primaryResource?: string;
  center?: { x: number; y: number };
  polygon?: Array<{ x: number; y: number }>;
  ecosystemIds?: string[];
}

export interface AgentState {
  id?: string;
  name?: string;
  strategy?: string;
  color?: string;
  resources?: Record<string, number>;
  vp?: number;
  influence?: number;
  trust?: number;
  longestRoad?: number;
  structures?: {
    villages?: number;
    townships?: number;
    cities?: number;
    beacons?: number;
    tradePosts?: number;
    roads?: number;
  };
  structureLocations?: Array<{
    type: string;
    hexes: Array<{ q: number; r: number }>;
    regionId?: string;
    regionIds?: string[];
  }>;
  armies?: Array<{ id: string; owner: string; position: { q: number; r: number }; count: number }>;
}

export interface Commitment {
  id: string;
  type?: string;
  promisor?: string;
  counterparties?: string[];
  resolutionStatus?: string;
  summary?: string;
  dueByRound?: number;
  payoutShareBps?: number;
}

export interface Attestation {
  id: string;
  commitmentId?: string;
  actor?: string;
  phase?: string;
  verdict?: string;
  weight?: number;
}

export interface VisibleBehaviorTag {
  id: string;
  round: number;
  actor: string;
  kind: string;
  severity: string;
  description: string;
}

export interface TrustEvidenceRef {
  kind: string;
  id: string;
  visibility: 'public' | 'viewer-visible';
  round?: number;
  relayIndex?: number;
  summary?: string;
}

export interface TrustSignal {
  label: string;
  stance: 'positive' | 'negative' | 'informational' | 'unknown';
  summary: string;
  confidence?: number;
  evidenceRefs?: TrustEvidenceRef[];
}

export interface TrustCard {
  schemaVersion: 'trust-card/v1';
  agentId: string;
  subjectId: string;
  headline: string;
  summary: string;
  signals: TrustSignal[];
  caveats: string[];
  evidenceRefs: TrustEvidenceRef[];
  updatedAt?: number;
}

export interface CrisisState {
  name?: string;
  type?: string;
  description?: string;
}

export interface AgentIdentity {
  agentId: string;
  walletAddress: string;
  name?: string;
  mcpEndpoint?: string;
  capabilities?: string[];
  registeredAt?: number;
  chainId?: number;
}

export interface AttestationReadiness {
  uid: string;
  schema: string;
  gameId: string;
  agentId: string;
  placement?: number;
  score?: number;
  trustDelta?: number;
  cooperationRate?: number;
  betrayalCount?: number;
  ecosystemImpact?: number;
  attestedAt?: number;
}

export interface AgentParticipationReadiness {
  agentId: string;
  status: 'registered' | 'active' | 'inactive' | 'unknown';
  mcpConnected: boolean;
  lastSeenAt?: number;
  gamesPlayed?: number;
  trustScore?: number;
}

export interface ChatMessage {
  id: string;
  sender: string;
  recipient?: string;
  content: string;
  type: 'public' | 'private' | 'diary' | 'system';
  round: number;
  phase?: string;
  timestamp: number;
}

export interface GameState {
  gameId: string | null;
  round: number;
  phase: string;
  prizePoolWei: string;
  payablePrizePoolWei: string;
  slashedPrizePoolWei: string;
  carryoverPrizePoolWei: string;
  commonsHealth: {
    score: number;
    payableFraction: number;
    reasons?: string[];
  } | null;
  activeCrisis: CrisisState | null;
  productionNumber: number;
  wheelPosition: number;
  productionWheel: number[];
  hexGrid: HexTile[];
  worldMap: Record<string, unknown> | null;
  agents: Record<string, AgentState>;
  pendingAgentInfo: Record<string, { name?: string; strategy?: string }>;
  agentOrder: string[];
  ecosystemStates: Array<Record<string, unknown>>;
  commitments: Commitment[];
  attestations: Attestation[];
  behaviorTags: VisibleBehaviorTag[];
  trustCards: TrustCard[];
  trustMatrix: { agents: string[]; matrix: number[][] } | null;
  winnerId: string | null;
  agentIdentities: Record<string, AgentIdentity>;
  attestationReadiness: AttestationReadiness[];
  participationReadiness: AgentParticipationReadiness[];
}

interface StoreState {
  gameState: GameState;
  selectedHex: { q: number; r: number } | null;
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  messages: ChatMessage[];
  setGameState: (state: Partial<GameState>) => void;
  replaceGameState: (state: GameState, messages: ChatMessage[]) => void;
  setSelectedHex: (hex: { q: number; r: number } | null) => void;
  setConnectionStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;
  addMessage: (message: ChatMessage) => void;
  clearMessages: () => void;
}

type Listener = () => void;

export const initialGameState: GameState = {
  gameId: null,
  round: 0,
  phase: 'waiting',
  prizePoolWei: '0',
  payablePrizePoolWei: '0',
  slashedPrizePoolWei: '0',
  carryoverPrizePoolWei: '0',
  commonsHealth: null,
  activeCrisis: null,
  productionNumber: 0,
  wheelPosition: 0,
  productionWheel: [],
  hexGrid: [],
  worldMap: null,
  agents: {},
  pendingAgentInfo: {},
  agentOrder: [],
  ecosystemStates: [],
  commitments: [],
  attestations: [],
  behaviorTags: [],
  trustCards: [],
  trustMatrix: null,
  winnerId: null,
  agentIdentities: {},
  attestationReadiness: [],
  participationReadiness: [],
};

const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => {
    listener();
  });
}

let currentState: StoreState;

function setStoreState(next: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)) {
  const patch = typeof next === 'function' ? next(currentState) : next;
  currentState = { ...currentState, ...patch };
  emit();
}

currentState = {
  gameState: initialGameState,
  selectedHex: null,
  connectionStatus: 'disconnected',
  messages: [],
  setGameState: (newState) =>
    setStoreState((state) => ({ gameState: { ...state.gameState, ...newState } })),
  replaceGameState: (gameState, messages) => setStoreState({ gameState, messages }),
  setSelectedHex: (hex) => setStoreState({ selectedHex: hex }),
  setConnectionStatus: (status) => setStoreState({ connectionStatus: status }),
  addMessage: (message) => setStoreState((state) => ({ messages: [...state.messages, message] })),
  clearMessages: () => setStoreState({ messages: [] }),
};

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface UseGameStore {
  <T>(selector: (state: StoreState) => T): T;
  getState: () => StoreState;
  setState: typeof setStoreState;
  subscribe: typeof subscribe;
}

export const useGameStore: UseGameStore = Object.assign(
  function useGameStoreSelector<T>(selector: (state: StoreState) => T): T {
    const state = useSyncExternalStore(
      subscribe,
      () => currentState,
      () => currentState,
    );
    return selector(state);
  },
  {
    getState: () => currentState,
    setState: setStoreState,
    subscribe,
  },
);
