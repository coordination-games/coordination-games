#!/usr/bin/env tsx
/**
 * Lightweight model-agnostic harness for local Coordination Games testing.
 *
 * Boundary: the game engine remains model-agnostic. This script owns provider
 * calls, decision parsing, reasoning publication, and action retries.
 *
 * Example MiniMax/OpenAI-compatible run:
 *   GAME_SERVER=http://127.0.0.1:3101 \
 *   PROVIDER=openai-compatible \
 *   OPENAI_BASE_URL=https://api.minimax.io/v1 \
 *   OPENAI_API_KEY=... \
 *   MODEL=MiniMax-M2.7-highspeed \
 *   tsx scripts/run-model-harness.ts
 *
 * Safe dry-run without model calls:
 *   PROVIDER=scripted GAME_SERVER=http://127.0.0.1:3101 tsx scripts/run-model-harness.ts
 */

import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { api, authenticate } from './lib/bot-agent.js';

const SERVER = process.env.GAME_SERVER ?? 'http://127.0.0.1:3101';
const GAME_TYPE = process.env.GAME_TYPE ?? 'tragedy-of-the-commons';
const BOT_COUNT = Number.parseInt(process.env.BOT_COUNT ?? '4', 10);
const TEAM_SIZE = Number.parseInt(process.env.TEAM_SIZE ?? '2', 10);
const MAX_ROUNDS = Number.parseInt(process.env.HARNESS_ROUNDS ?? '3', 10);
const PROVIDER_NAME = process.env.PROVIDER ?? 'scripted';
const MODEL = process.env.MODEL ?? process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7-highspeed';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: npm run harness:model -- [--help]

Environment:
  GAME_SERVER       Server URL (default http://127.0.0.1:3101)
  GAME_TYPE         Game slug (default tragedy-of-the-commons)
  BOT_COUNT         Number of agents (default 4)
  TEAM_SIZE         Lobby team size (default 2)
  HARNESS_ROUNDS   Max decision rounds (default 3)
  PROVIDER         scripted | openai-compatible | minimax (default scripted)
  OPENAI_BASE_URL   OpenAI-compatible base URL (MiniMax: https://api.minimax.io/v1)
  OPENAI_API_KEY    API key for openai-compatible/minimax
  MODEL             Model name (MiniMax: MiniMax-M2.7-highspeed)

Examples:
  PROVIDER=scripted GAME_SERVER=http://127.0.0.1:3101 npm run harness:model
  PROVIDER=minimax OPENAI_BASE_URL=https://api.minimax.io/v1 OPENAI_API_KEY=... MODEL=MiniMax-M2.7-highspeed npm run harness:model
`);
  process.exit(0);
}

interface HarnessBot {
  name: string;
  token: string;
  playerId: string;
  privateKey: string;
}

interface ModelDecision {
  reasoning: string;
  publicMessage: string;
  privateMessage: string;
  dmRecipient?: string;
  action: Record<string, unknown>;
}

interface ModelProvider {
  readonly name: string;
  decide(input: {
    bot: HarnessBot;
    visibleState: unknown;
    tools: unknown[];
    round: number;
  }): Promise<ModelDecision>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function jsonPrompt(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 12_000);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeDecision(raw: unknown): ModelDecision {
  const record = isRecord(raw) ? raw : {};
  const reasoning =
    typeof record.reasoning === 'string'
      ? record.reasoning
      : typeof record.rationale === 'string'
        ? record.rationale
        : 'No explicit reasoning returned; defaulting to pass.';
  const action = isRecord(record.action) ? record.action : { type: 'pass' };
  const type = typeof action.type === 'string' ? action.type : 'pass';
  const publicMessage =
    typeof record.publicMessage === 'string'
      ? record.publicMessage
      : typeof record.message === 'string'
        ? record.message
        : 'I am looking for a sustainable opening and am open to coordination.';
  const privateMessage =
    typeof record.privateMessage === 'string'
      ? record.privateMessage
      : 'Can we coordinate this round so we do not over-extract the commons?';
  const dmRecipient = typeof record.dmRecipient === 'string' ? record.dmRecipient : undefined;
  return { reasoning, publicMessage, privateMessage, dmRecipient, action: { ...action, type } };
}

class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';

  async decide(input: { bot: HarnessBot; round: number }): Promise<ModelDecision> {
    return {
      reasoning: `${input.bot.name}: scripted baseline for round ${input.round}; pass to validate harness, reasoning relay, and action submission without model spend.`,
      publicMessage: 'I am holding position this round and watching for cooperative signals.',
      privateMessage: 'I am open to a low-extraction pact if you are.',
      action: { type: 'pass' },
    };
  }
}

class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async decide(input: {
    bot: HarnessBot;
    visibleState: unknown;
    tools: unknown[];
    round: number;
  }): Promise<ModelDecision> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 1,
        top_p: 0.95,
        max_completion_tokens: 1024,
        reasoning_split: true,
        messages: [
          {
            role: 'system',
            content:
              'You are an autonomous game-playing agent in a Tragedy of the Commons negotiation game.\n\nReturn ONLY compact JSON with this exact shape:\n{"reasoning":"private decision trace, not chat","publicMessage":"short natural public negotiation message to all players","privateMessage":"short direct message to one other player","dmRecipient":"exact player name/handle you want to DM (optional)","action":{"type":"pass"}}\n\nValid actions with exact schemas:\n- pass: {"type":"pass"}\n- extract_commons: {"type":"extract_commons","ecosystemId":"<id>","level":"low|medium|high"}\n- build_settlement: {"type":"build_settlement","regionId":"<id>"}\n- offer_trade: {"type":"offer_trade","to":"<playerId>","give":{"grain":0,"timber":0,"ore":0,"fish":0,"water":0,"energy":0},"receive":{"grain":0,"timber":0,"ore":0,"fish":0,"water":0,"energy":0}}\n\nRules:\n1. Use ONLY the fields listed above for each action type.\n2. Do not invent extra fields or use wrong types.\n3. Prefer simple legal actions over complex invalid ones.\n4. publicMessage/privateMessage must read like chat between agents, not action justifications.\n5. Do not include provider reasoning in chat messages.\n6. READ the relayMessages in your state carefully. The handles map converts UUIDs to player names. Reference what other players said — respond to proposals, counter-offers, threats, and alliances. Be conversational and strategic.\n7. If trustCards are present, treat them as compact evidence summaries over viewer-visible game state only. They are not final reputation scores, and they do not reveal private DMs, hidden strategy, or model reasoning. Use their evidence refs and caveats to inform questions, caution, and cooperation strategy.\n8. dmRecipient: use the EXACT player name/handle (e.g. "Alicia Commons 89c33958") if you want to send a private DM. If omitted, no DM is sent.\n9. Coordinate with other players: propose extraction limits, warn about defectors, negotiate trades, form coalitions.',
          },
          {
            role: 'user',
            content: `Agent: ${input.bot.name}\nRound: ${input.round}\nAvailable tools:\n${jsonPrompt(input.tools)}\nVisible state:\n${jsonPrompt(input.visibleState)}\n\nIMPORTANT: Your visible state contains relayMessages (chat from other players), a handles map (UUID→name), and may contain trustCards. READ THEM. Respond to what others said. Reference their proposals by name. Use trustCards only as compact, viewer-visible evidence summaries with caveats — not as hidden knowledge or final reputation scores.\n\nChoose one legal action. publicMessage goes to all players. privateMessage + dmRecipient go to one specific player (use their EXACT name from handles/scoreboard). Negotiate over restraint, trades, alliances, warnings, or mutual monitoring. Do not include provider reasoning in chat messages.`,
          },
        ],
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`model ${response.status}: ${bodyText.slice(0, 500)}`);
    }
    const body = JSON.parse(bodyText) as unknown;
    const choice = isRecord(body)
      ? Array.isArray(body.choices)
        ? body.choices[0]
        : undefined
      : undefined;
    const message = isRecord(choice) ? choice.message : undefined;
    const messageRecord = isRecord(message) ? message : {};
    const content = typeof messageRecord.content === 'string' ? messageRecord.content : '';
    const parsed = extractJsonObject(content);
    const decision = normalizeDecision(parsed);
    const reasoningDetails = Array.isArray(messageRecord.reasoning_details)
      ? messageRecord.reasoning_details
          .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    return {
      ...decision,
      reasoning: reasoningDetails
        ? `${decision.reasoning}\n\n[provider reasoning summary]\n${reasoningDetails}`
        : decision.reasoning,
    };
  }
}

function createProvider(): ModelProvider {
  if (PROVIDER_NAME === 'scripted') return new ScriptedProvider();
  if (PROVIDER_NAME === 'openai-compatible' || PROVIDER_NAME === 'minimax') {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY or MINIMAX_API_KEY is required for openai-compatible provider',
      );
    }
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.minimax.io/v1';
    return new OpenAICompatibleProvider(baseUrl, apiKey, MODEL);
  }
  throw new Error(`Unknown PROVIDER=${PROVIDER_NAME}`);
}

async function createBots(): Promise<HarnessBot[]> {
  const bots: HarnessBot[] = [];
  const defaultNames = ['Alicia Commons', 'Bob Timber', 'Carol Current', 'Dave Ore'];
  const suffix = RUN_ID.slice(0, 8);
  for (let i = 0; i < BOT_COUNT; i++) {
    const wallet = ethers.Wallet.createRandom();
    const baseName = defaultNames[i] ?? `Harness Bot ${i + 1}`;
    const name = `${baseName} ${suffix}`;
    const auth = await authenticate(SERVER, wallet.privateKey, name);
    bots.push({ name, token: auth.token, playerId: auth.playerId, privateKey: wallet.privateKey });
  }
  return bots;
}

async function inspect(sessionId: string): Promise<Record<string, unknown>> {
  const token = process.env.INSPECTOR_TOKEN ?? 'local-inspector-token';
  const res = await fetch(`${SERVER}/api/admin/session/${sessionId}/inspect`, {
    headers: { 'X-Admin-Token': token },
  });
  const body = (await res.json()) as unknown;
  if (!res.ok || !isRecord(body)) throw new Error(`inspect failed for ${sessionId}`);
  return body;
}

function relayFor(decision: ModelDecision, provider: ModelProvider): Record<string, unknown> {
  return {
    type: 'reasoning',
    pluginId: 'reasoning',
    scope: 'all',
    data: {
      body: decision.reasoning,
      stage: 'decision',
      tags: { provider: provider.name, model: MODEL, runId: RUN_ID },
    },
  };
}

function chatRelayFor(
  decision: ModelDecision,
  provider: ModelProvider,
  scope: string | { kind: 'dm'; recipientHandle: string } = 'all',
  message = decision.publicMessage,
): Record<string, unknown> {
  const resolvedScope =
    typeof scope === 'string' && scope !== 'all' ? { kind: 'dm', recipientHandle: scope } : scope;
  return {
    type: 'messaging',
    pluginId: 'basic-chat',
    scope: resolvedScope,
    data: {
      body: message,
      tags: { provider: provider.name, model: MODEL, runId: RUN_ID, source: 'model-harness' },
    },
  };
}

function resolveDmTarget(
  bots: HarnessBot[],
  activeBot: HarnessBot,
  requestedRecipient: string | undefined,
): HarnessBot | undefined {
  const trimmedRecipient = requestedRecipient?.trim();
  if (trimmedRecipient) {
    const requestedTarget = bots.find(
      (bot) =>
        bot.name === trimmedRecipient ||
        bot.playerId === trimmedRecipient ||
        bot.name.includes(trimmedRecipient) ||
        bot.playerId.includes(trimmedRecipient),
    );
    if (requestedTarget && requestedTarget.playerId !== activeBot.playerId) return requestedTarget;
  }

  return bots.find((bot) => bot.playerId !== activeBot.playerId);
}

async function callTool(bot: HarnessBot, toolName: string, args: Record<string, unknown>) {
  return api(SERVER, '/api/player/tool', {
    method: 'POST',
    token: bot.token,
    body: { toolName, args },
  });
}

const RUN_ID = randomUUID();

async function main() {
  const provider = createProvider();
  console.log(`model-harness run=${RUN_ID} provider=${provider.name} model=${MODEL}`);
  console.log(`server=${SERVER} game=${GAME_TYPE} bots=${BOT_COUNT}`);

  const bots = await createBots();
  const lobby = await api(SERVER, '/api/lobbies/create', {
    method: 'POST',
    token: bots[0]?.token,
    body: { gameType: GAME_TYPE, teamSize: TEAM_SIZE },
  });
  const lobbyId = String(lobby.lobbyId);
  console.log(`lobby=${lobbyId}`);

  for (const bot of bots) {
    const joined = await api(SERVER, '/api/player/lobby/join', {
      method: 'POST',
      token: bot.token,
      body: { lobbyId },
    });
    console.log(`joined ${bot.name} phase=${String(joined.phase ?? 'unknown')}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const lobbyInspect = await inspect(lobbyId);
  const gameId = typeof lobbyInspect.gameId === 'string' ? lobbyInspect.gameId : null;
  if (!gameId) throw new Error(`Lobby did not start a game: ${JSON.stringify(lobbyInspect.lobby)}`);
  console.log(`game=${gameId}`);

  for (let roundLoop = 0; roundLoop < MAX_ROUNDS; roundLoop++) {
    const gameInspect = await inspect(gameId);
    const diagnostics = isRecord(gameInspect.gameInspect) ? gameInspect.gameInspect : {};
    const gameState = isRecord(diagnostics.gameState) ? diagnostics.gameState : {};
    const phase = typeof gameState.phase === 'string' ? gameState.phase : 'unknown';
    const round = getNumber(gameState.round, roundLoop + 1);
    if (phase === 'finished') break;
    console.log(`round=${round} phase=${phase}`);

    // Turn-by-turn loop: keep going until all players have acted or round ends
    const actedThisRound = new Set<string>();
    let maxTurnsPerRound = bots.length * 2; // safety limit
    while (actedThisRound.size < bots.length && maxTurnsPerRound-- > 0) {
      // Get game state to find whose turn it is
      const gameInspect = await inspect(gameId);
      const gs = isRecord(gameInspect.gameInspect) ? gameInspect.gameInspect : {};
      const st = isRecord(gs.gameState) ? gs.gameState : {};
      const currentPlayerIndex =
        typeof st.currentPlayerIndex === 'number' ? st.currentPlayerIndex : 0;
      const players = Array.isArray(st.players) ? st.players : [];
      const currentPlayerObj = isRecord(players[currentPlayerIndex])
        ? players[currentPlayerIndex]
        : null;
      const currentPlayerId = typeof currentPlayerObj?.id === 'string' ? currentPlayerObj.id : null;
      if (!currentPlayerId) {
        console.log('  cannot determine current player, breaking');
        break;
      }
      if (actedThisRound.has(currentPlayerId)) {
        console.log(`  ${currentPlayerId} already acted this round, breaking`);
        break;
      }
      // Find the bot that matches this player
      const activeBot = bots.find((b) => b.playerId === currentPlayerId);
      if (!activeBot) {
        console.log(`  no bot found for player ${currentPlayerId}, breaking`);
        break;
      }

      // Fetch THIS bot's state (fresh, after previous turn advances)
      const stateEnvelope = await api(SERVER, '/api/player/state', { token: activeBot.token });
      const rawState = isRecord(stateEnvelope.state) ? stateEnvelope.state : stateEnvelope;
      // Extract handles map so model can resolve UUIDs to human-readable names
      const handles =
        isRecord(stateEnvelope.meta) && isRecord(stateEnvelope.meta.handles)
          ? (stateEnvelope.meta.handles as Record<string, string>)
          : {};
      // Replace UUIDs with readable names in relay messages
      const rawRelay = Array.isArray(rawState.relayMessages) ? rawState.relayMessages : [];
      const enrichedRelay = rawRelay.map((msg: Record<string, unknown>) => {
        if (!isRecord(msg)) return msg;
        const sender = typeof msg.sender === 'string' ? msg.sender : '';
        const resolved = handles[sender] ?? sender;
        const scope = isRecord(msg.scope) ? { ...msg.scope } : msg.scope;
        // Resolve recipientHandle in DM scope too
        if (
          isRecord(scope) &&
          typeof scope.recipientHandle === 'string' &&
          handles[scope.recipientHandle]
        ) {
          scope.recipientHandle = handles[scope.recipientHandle];
        }
        return { ...msg, sender: resolved, scope };
      });
      // Build visible state with handles and enriched relay messages
      const visibleState = { ...rawState, handles, relayMessages: enrichedRelay };
      const hasRelayMessages = enrichedRelay.length > 0;
      console.log(
        `  ${activeBot.name}: relayMessages=${hasRelayMessages} count=${enrichedRelay.length}`,
      );
      const tools = Array.isArray(visibleState.currentPhase?.tools)
        ? visibleState.currentPhase.tools
        : [];
      const decision = await provider.decide({ bot: activeBot, visibleState, tools, round });

      // Publish reasoning relay
      await callTool(activeBot, 'plugin_relay', { relay: relayFor(decision, provider) });

      // Publish public chat relay
      await callTool(activeBot, 'plugin_relay', { relay: chatRelayFor(decision, provider) });

      // DM routing: match against BOTH name AND playerId. If the model produced
      // a private message but omitted a recipient, send it to a real peer instead
      // of silently dropping the private chat path during local harness runs.
      if (decision.privateMessage.trim()) {
        const dmTarget = resolveDmTarget(bots, activeBot, decision.dmRecipient);
        if (dmTarget) {
          await callTool(activeBot, 'plugin_relay', {
            relay: chatRelayFor(decision, provider, dmTarget.name, decision.privateMessage),
          });
          console.log(
            `  ${activeBot.name}: DM to ${dmTarget.name} (playerId=${dmTarget.playerId})`,
          );
        } else {
          console.log(`  ${activeBot.name}: no valid DM recipient found`);
        }
      }

      // Submit the game action (only if it's their turn)
      const isYourTurn = visibleState.isYourTurn === true;
      const { type, ...args } = decision.action;
      const toolName = typeof type === 'string' ? type : 'pass';
      if (isYourTurn) {
        try {
          console.log(
            `  ${activeBot.name}: attempting ${toolName} with args ${JSON.stringify(args)}`,
          );
          await callTool(activeBot, toolName, args);
          console.log(`  ${activeBot.name}: ${toolName}`);
          actedThisRound.add(currentPlayerId);
        } catch (err) {
          console.log(
            `  ${activeBot.name}: ${toolName} failed, falling back to pass (${String(err).slice(0, 160)})`,
          );
          try {
            await callTool(activeBot, 'pass', {});
            console.log(`  ${activeBot.name}: pass (fallback)`);
            actedThisRound.add(currentPlayerId);
          } catch (passErr) {
            console.log(
              `  ${activeBot.name}: pass fallback also failed (${String(passErr).slice(0, 160)})`,
            );
          }
        }
      } else {
        console.log(
          `  ${activeBot.name}: not their turn (currentPlayer=${currentPlayerId}), skipping`,
        );
        actedThisRound.add(currentPlayerId); // count as acted to avoid infinite loop
      }

      // Small delay to let server process turn advance
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const finalInspect = await inspect(gameId);
  const finalDiagnostics = isRecord(finalInspect.gameInspect) ? finalInspect.gameInspect : {};
  const relayMessages = Array.isArray(finalDiagnostics.relayMessages)
    ? finalDiagnostics.relayMessages
    : [];
  console.log(
    JSON.stringify(
      {
        runId: RUN_ID,
        lobbyId,
        gameId,
        inspectUrl: `http://127.0.0.1:5173/inspect/${gameId}`,
        gameUrl: `http://127.0.0.1:5173/game/${gameId}`,
        reasoningMessages: relayMessages.filter(
          (message) => isRecord(message) && message.type === 'reasoning',
        ).length,
        chatMessages: relayMessages.filter(
          (message) => isRecord(message) && message.type === 'messaging',
        ).length,
        dmMessages: relayMessages.filter(
          (message) =>
            isRecord(message) &&
            message.type === 'messaging' &&
            isRecord(message.scope) &&
            message.scope.kind === 'dm',
        ).length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
