/**
 * Plugin Loader — registers plugins and builds execution pipelines.
 *
 * Plugins declare what they consume and provide. The loader builds
 * a topologically sorted pipeline for execution.
 */

import type { PluginMode, ToolDefinition, ToolPlugin } from './types.js';

// ---------------------------------------------------------------------------
// Pipeline step — a plugin + the mode it's executing in
// ---------------------------------------------------------------------------

export interface PipelineStep {
  plugin: ToolPlugin;
  mode: PluginMode;
}

// ---------------------------------------------------------------------------
// PluginPipeline — executes steps in order
// ---------------------------------------------------------------------------

export class PluginPipeline {
  readonly steps: PipelineStep[];

  constructor(steps: PipelineStep[]) {
    this.steps = steps;
  }

  /**
   * Execute the pipeline. Each step receives accumulated data,
   * processes it, and adds its outputs.
   */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  execute(initialData: Map<string, any>): Map<string, any> {
    const data = new Map(initialData);

    for (const step of this.steps) {
      // Gather inputs for this step
      // Producers (no consumes) get all accumulated data so they can
      // read raw inputs like relay-messages. Consumers get only their
      // declared consumed capabilities.
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      let inputs: Map<string, any>;
      if (step.mode.consumes.length === 0) {
        inputs = new Map(data);
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
        inputs = new Map<string, any>();
        for (const cap of step.mode.consumes) {
          if (data.has(cap)) {
            inputs.set(cap, data.get(cap));
          }
        }
      }

      // Execute the step
      const outputs = step.plugin.handleData(step.mode.name, inputs);

      // Merge outputs into accumulated data
      for (const [key, value] of outputs) {
        data.set(key, value);
      }
    }

    return data;
  }
}

// ---------------------------------------------------------------------------
// PluginLoader — registry + pipeline builder
// ---------------------------------------------------------------------------

export class PluginLoader {
  private registry: Map<string, ToolPlugin> = new Map();

  /** Register a plugin. */
  register(plugin: ToolPlugin): void {
    this.registry.set(plugin.id, plugin);
  }

  /** Get a plugin by ID. */
  getPlugin(id: string): ToolPlugin | undefined {
    return this.registry.get(id);
  }

  /** List all registered plugin IDs. */
  listPlugins(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Build an execution pipeline from active plugins.
   *
   * 1. Collect all modes from active plugins
   * 2. Producers first (no consumes)
   * 3. Topological sort on dependency graph
   * 4. Independent providers merge (run in insertion order)
   * 5. Cycles = error
   */
  buildPipeline(activePluginIds: string[]): PluginPipeline {
    // Collect all steps (plugin + mode pairs)
    const steps: PipelineStep[] = [];
    for (const id of activePluginIds) {
      const plugin = this.registry.get(id);
      if (!plugin) {
        throw new Error(`Unknown plugin: ${id}`);
      }
      for (const mode of plugin.modes) {
        steps.push({ plugin, mode });
      }
    }

    if (steps.length === 0) {
      return new PluginPipeline([]);
    }

    // Build adjacency list: step index -> indices that must come after
    // If step B consumes what step A provides, A must come before B
    const adj: Set<number>[] = steps.map(() => new Set());
    const inDegree: number[] = steps.map(() => 0);

    for (let i = 0; i < steps.length; i++) {
      for (let j = 0; j < steps.length; j++) {
        if (i === j) continue;
        // Does step j consume something step i provides?
        // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
        const provides = new Set(steps[i].mode.provides);
        // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
        const consumes = steps[j].mode.consumes;
        if (consumes.some((cap) => provides.has(cap))) {
          // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
          if (!adj[i].has(j)) {
            // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
            adj[i].add(j);
            // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
            inDegree[j]++;
          }
        }
      }
    }

    // Kahn's algorithm for topological sort
    const queue: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (inDegree[i] === 0) {
        queue.push(i);
      }
    }

    const sorted: PipelineStep[] = [];
    let processed = 0;

    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const idx = queue.shift()!;
      // @ts-expect-error TS2345: Argument of type 'PipelineStep | undefined' is not assignable to parameter of ty — TODO(2.3-followup)
      sorted.push(steps[idx]);
      processed++;

      // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
      for (const neighbor of adj[idx]) {
        // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (processed !== steps.length) {
      // Find the cycle participants for a helpful error
      const inCycle = steps
        // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
        .filter((_, i) => inDegree[i] > 0)
        .map((s) => `${s.plugin.id}:${s.mode.name}`);
      throw new Error(`Plugin dependency cycle detected: ${inCycle.join(' → ')}`);
    }

    return new PluginPipeline(sorted);
  }

  /** Get MCP tool definitions for active plugins. */
  getTools(activePluginIds: string[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const id of activePluginIds) {
      const plugin = this.registry.get(id);
      if (plugin?.tools) {
        tools.push(...plugin.tools);
      }
    }
    return tools;
  }
}
