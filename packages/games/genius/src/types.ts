export const GENIUS_COLORS = ['red', 'blue', 'green', 'yellow'] as const;

export type GeniusColor = (typeof GENIUS_COLORS)[number];
export type GeniusPhase = 'playing' | 'finished';

export type GeniusConfigInput = {
  readonly playerIds: readonly string[];
  readonly seed: string;
  readonly maxRounds?: number;
};

export type GeniusConfig = {
  readonly playerIds: readonly string[];
  readonly seed: string;
  readonly maxRounds: number;
};

export type PressColorAction = {
  readonly type: 'press_color';
  readonly color: GeniusColor;
};

export type GeniusAction = PressColorAction;

export type GeniusPlayerState = {
  readonly id: string;
  readonly score: number;
  readonly active: boolean;
  readonly eliminatedRound: number | null;
};

export type GeniusState = {
  readonly phase: GeniusPhase;
  readonly round: number;
  readonly maxRounds: number;
  readonly seed: string;
  readonly sequence: readonly GeniusColor[];
  readonly currentPlayerId: string | null;
  readonly inputIndex: number;
  readonly completedThisRound: readonly string[];
  readonly players: readonly GeniusPlayerState[];
  readonly winnerIds: readonly string[];
};

export type GeniusRanking = {
  readonly playerId: string;
  readonly score: number;
  readonly active: boolean;
  readonly eliminatedRound: number | null;
};

export type GeniusOutcome = {
  readonly winnerIds: readonly string[];
  readonly roundsPlayed: number;
  readonly rankings: readonly GeniusRanking[];
};

export type GeniusVisibleState = {
  readonly phase: GeniusPhase;
  readonly round: number;
  readonly maxRounds: number;
  readonly sequence: readonly GeniusColor[];
  readonly currentPlayerId: string | null;
  readonly inputIndex: number;
  readonly completedThisRound: readonly string[];
  readonly players: readonly GeniusPlayerState[];
  readonly winnerIds: readonly string[];
};

export type GeniusRecordedAction = {
  readonly playerId: string | null;
  readonly action: GeniusAction;
};

export type GeniusTranscriptEntry = GeniusRecordedAction & {
  readonly index: number;
  readonly state: GeniusState;
};

export type GeniusReplay = {
  readonly state: GeniusState;
  readonly outcome: GeniusOutcome | null;
  readonly transcript: readonly GeniusTranscriptEntry[];
};

export type GeniusBot = {
  readonly playerId: string;
  chooseAction(view: GeniusVisibleState): GeniusAction;
};

export type GeniusBotFixture = {
  readonly config: GeniusConfig;
  readonly actions: readonly GeniusRecordedAction[];
  readonly state: GeniusState;
  readonly outcome: GeniusOutcome;
  readonly transcript: readonly GeniusTranscriptEntry[];
  readonly replay: GeniusReplay;
  readonly publicHash: `0x${string}`;
};
