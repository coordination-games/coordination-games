import type { AgentInfo, ToolPlugin } from "@coordination-games/engine";

export interface RelayMessage {
	type: string;
	data: unknown;
	scope: "team" | "all" | string;
	pluginId: string;
	sender: string;
	turn: number;
	timestamp: number;
	index: number;
}

export interface ReasoningEntry {
	from: string;
	body: string;
	turn: number;
	scope: "team" | "all" | string;
	stage?: string;
	tags: Record<string, any>;
}

export function formatReasoningMessage(
	message: string,
	scope = "all",
	stage?: string,
) {
	return {
		type: "reasoning",
		data: {
			body: message,
			...(stage ? { stage } : {}),
		},
		scope,
		pluginId: "reasoning",
	};
}

export function extractReasoningEntries(
	relayMessages: RelayMessage[],
): ReasoningEntry[] {
	return relayMessages
		.filter((msg) => msg.type === "reasoning")
		.map((msg) => {
			const data = msg.data as {
				body?: string;
				stage?: string;
				tags?: Record<string, any>;
			};
			return {
				from: msg.sender,
				body: data.body ?? "",
				turn: msg.turn,
				scope: msg.scope,
				stage: data.stage,
				tags: {
					...data.tags,
					source: msg.pluginId,
					sender: msg.sender,
					timestamp: msg.timestamp,
				},
			} satisfies ReasoningEntry;
		});
}

export const ReasoningPlugin: ToolPlugin = {
	id: "reasoning",
	version: "0.1.0",
	modes: [{ name: "reasoning", consumes: [], provides: ["reasoning"] }],
	purity: "pure",
	tools: [
		{
			name: "share_reasoning",
			description:
				"Publish an explicit authored reasoning entry to the relay. Use this for observable strategy notes or justification, not hidden chain-of-thought.",
			inputSchema: {
				type: "object",
				properties: {
					message: {
						type: "string",
						description: "The reasoning or strategy note to publish.",
					},
					scope: {
						type: "string",
						description:
							'Who receives it: "team", "all", or a specific agentId for a DM-like reasoning.',
					},
					stage: {
						type: "string",
						description:
							"Optional phase label such as planning, negotiation, action, or reflection.",
					},
				},
				required: ["message"],
			},
			mcpExpose: true,
		},
	],
	handleData(_mode: string, inputs: Map<string, any>): Map<string, any> {
		const relayMessages: RelayMessage[] = inputs.get("relay-messages") ?? [];
		return new Map([["reasoning", extractReasoningEntries(relayMessages)]]);
	},
	handleCall(tool: string, args: unknown, _caller: AgentInfo): unknown {
		if (tool === "share_reasoning") {
			const { message, scope, stage } = args as {
				message: string;
				scope?: string;
				stage?: string;
			};
			return {
				relay: formatReasoningMessage(message, scope || "all", stage),
			};
		}
		return { error: `Unknown tool: ${tool}` };
	},
};
