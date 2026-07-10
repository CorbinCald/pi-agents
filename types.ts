export type AgentStatus = "needs_input" | "working" | "complete";

export interface AgentRecord {
	id: string;
	backend?: "terminal";
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

export interface SupervisorEvent {
	type: "event";
	event: "state" | "removed";
	job?: AgentRecord;
	jobId?: string;
}
