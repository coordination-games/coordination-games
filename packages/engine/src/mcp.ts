/**
 * Platform MCP — generic MCP tool visibility based on game phase.
 *
 * Provides phase-aware tool selection:
 * - Each phase has its own set of platform tools
 * - Plugin tools are injected dynamically from the PluginLoader
 * - get_guide is always available
 */

import type { ToolPlugin, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Phase tool definitions
// ---------------------------------------------------------------------------

const GUIDE_TOOL: ToolDefinition = {
  name: 'get_guide',
  description: 'Get game rules, active plugins, and current state guide',
  inputSchema: { type: 'object', properties: {} },
};

const WAIT_TOOL: ToolDefinition = {
  name: 'wait_for_update',
  description: 'Block until the next game state update',
  inputSchema: { type: 'object', properties: {} },
};

/** Platform tools available during team formation. */
const TEAM_FORMATION_TOOLS: ToolDefinition[] = [
  {
    name: 'propose_team',
    description: 'Propose a team with another player',
    inputSchema: {
      type: 'object',
      properties: { targetPlayerId: { type: 'string' } },
      required: ['targetPlayerId'],
    },
  },
  {
    name: 'accept_team',
    description: 'Accept a team invitation',
    inputSchema: {
      type: 'object',
      properties: { teamId: { type: 'string' } },
      required: ['teamId'],
    },
  },
  {
    name: 'leave_team',
    description: 'Leave your current team',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Platform tools available during class selection. */
const CLASS_SELECTION_TOOLS: ToolDefinition[] = [
  {
    name: 'choose_class',
    description: 'Choose your unit class (rogue, knight, or mage)',
    inputSchema: {
      type: 'object',
      properties: { unitClass: { type: 'string', enum: ['rogue', 'knight', 'mage'] } },
      required: ['unitClass'],
    },
  },
];

/** Platform tools available during gameplay. */
const GAMEPLAY_TOOLS: ToolDefinition[] = [
  {
    name: 'get_state',
    description: 'Get the current game state (fog-of-war filtered)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_move',
    description: 'Submit your move for this turn',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'array', items: { type: 'string' } } },
      required: ['path'],
    },
  },
];

/** Map of phase -> platform tools. */
const PHASE_TOOLS: Record<string, ToolDefinition[]> = {
  'lobby': [],
  'team-formation': TEAM_FORMATION_TOOLS,
  'class-selection': CLASS_SELECTION_TOOLS,
  'in_progress': GAMEPLAY_TOOLS,
  'finished': [],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get all available MCP tools for a given phase and set of active plugins.
 *
 * Always includes get_guide. Phase-specific platform tools come next.
 * Active plugin tools are appended last.
 */
export function getAvailableTools(
  phase: string,
  activePlugins: ToolPlugin[],
): ToolDefinition[] {
  const platformTools = PHASE_TOOLS[phase] ?? [];
  const pluginTools = activePlugins.flatMap((p) => p.tools ?? []);

  const tools = [GUIDE_TOOL, ...platformTools, ...pluginTools];

  // Add wait_for_update during gameplay
  if (phase === 'in_progress' || phase === 'team-formation' || phase === 'class-selection') {
    tools.push(WAIT_TOOL);
  }

  return tools;
}

/**
 * Generate a dynamic guide based on game type, active plugins, and player state.
 */
export function generateGuide(options: {
  gameType: string;
  gameRules?: string;
  activePlugins: ToolPlugin[];
  playerState?: Record<string, any>;
  phase: string;
}): string {
  const { gameType, gameRules, activePlugins, playerState, phase } = options;

  const sections: string[] = [];

  sections.push(`# ${gameType} — Game Guide`);
  sections.push(`**Current Phase:** ${phase}`);

  if (gameRules) {
    sections.push(`\n## Rules\n${gameRules}`);
  }

  if (activePlugins.length > 0) {
    sections.push('\n## Active Plugins');
    for (const plugin of activePlugins) {
      sections.push(`- **${plugin.id}** v${plugin.version}`);
      if (plugin.tools?.length) {
        for (const tool of plugin.tools) {
          sections.push(`  - \`${tool.name}\`: ${tool.description}`);
        }
      }
    }
  }

  const tools = getAvailableTools(phase, activePlugins);
  sections.push('\n## Available Tools');
  for (const tool of tools) {
    sections.push(`- \`${tool.name}\`: ${tool.description}`);
  }

  if (playerState) {
    sections.push('\n## Your Status');
    for (const [key, value] of Object.entries(playerState)) {
      sections.push(`- **${key}:** ${JSON.stringify(value)}`);
    }
  }

  return sections.join('\n');
}

// Export tool constants for testing
export { PHASE_TOOLS, GUIDE_TOOL, WAIT_TOOL };
