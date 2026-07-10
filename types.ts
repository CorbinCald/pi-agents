export type AgentStatus = "needs_input" | "working" | "complete";

export interface PendingUiRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	placeholder?: string;
	prefill?: string;
	options?: string[];
}

export interface AgentRecord {
	id: string;
	backend?: "rpc" | "terminal";
	terminalServer?: string;
	terminalSession?: string;
	sessionId?: string;
	sessionFile?: string;
	name: string;
	prompt: string;
	originalCwd: string;
	cwd: string;
	model: { provider: string; id: string };
	thinkingLevel: string;
	status: AgentStatus;
	summary: string;
	recap?: string;
	recapPending?: boolean;
	waitingFor?: string;
	pendingUi?: PendingUiRequest;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	pinned: boolean;
	order: number;
	userRenamed: boolean;
	isRunning: boolean;
	isStreaming: boolean;
	stopped?: boolean;
	failed?: boolean;
	error?: string;
	repoRoot?: string;
	worktreePath?: string;
	branch?: string;
	isolated: boolean;
}

export interface DispatchRequest {
	prompt: string;
	cwd: string;
	model: { provider: string; id: string };
	thinkingLevel: string;
	projectTrusted: boolean;
}

export interface AgentMessagePart {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface AgentMessageRecord {
	role: string;
	content?: string | AgentMessagePart[];
	stopReason?: string;
	errorMessage?: string;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	[key: string]: unknown;
}

export interface JobEventRecord {
	type?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
	message?: AgentMessageRecord;
	[key: string]: unknown;
}

export interface SupervisorEvent {
	type: "event";
	event: "state" | "removed" | "job_event";
	job?: AgentRecord;
	jobId?: string;
	data?: JobEventRecord;
}

export interface MessageList {
	messages: AgentMessageRecord[];
}
