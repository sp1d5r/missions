export interface BehavioralResult {
	ran: boolean;
	passed: boolean;
	score?: number;
	evidence: string;
}

/** A Target adapter is the only repo-specific piece: recon + how to validate behavior. */
export interface Target {
	name: string;
	/** Short top-level recon string handed to the orchestrator. */
	recon(cwd: string): string;
	/** A sensible default scrutiny check command, if the repo has one. */
	defaultCheckCommand(cwd: string): string | undefined;
	/** Run an end-to-end behavioral scenario. May be a no-op (ran:false) for generic repos. */
	runBehavioral(cwd: string, scenario: string, threshold?: number): Promise<BehavioralResult>;
}
