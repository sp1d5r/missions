export interface BehavioralResult {
	ran: boolean;
	passed: boolean;
	score?: number;
	evidence: string;
}

/**
 * What a fresh `git worktree add` does NOT carry, but a worker needs anyway.
 *
 * `git worktree add` gives you tracked files and nothing else — no gitignored env
 * files, no installed dependencies, no sibling checkouts. A worker dropped into that
 * tree either burns its budget re-bootstrapping or, worse, silently falls back to the
 * main checkout's env and packages.
 */
export interface WorktreeBootstrapSpec {
	/**
	 * Repo-relative gitignored env files to COPY into the worktree (never symlink —
	 * python-dotenv loads with override=True, so a shared file would beat mission
	 * overrides). Missing entries are skipped.
	 */
	envFiles: string[];
	/**
	 * Repo-relative gitignored directories to SYMLINK into the worktree — installed
	 * dependencies and sibling checkouts far too large to copy per mission. Shared, so
	 * treat them as read-only: installing into one mutates every tree.
	 */
	linkDirs: string[];
	/**
	 * Repo-relative source roots that must resolve inside the worktree rather than from
	 * installed packages. Become an absolute, worktree-rooted PYTHONPATH.
	 */
	sourceRoots: string[];
}

/** A Target adapter is the only repo-specific piece: recon, bootstrap, and how to validate behavior. */
export interface Target {
	name: string;
	/** Short top-level recon string handed to the orchestrator. */
	recon(cwd: string): string;
	/** A sensible default scrutiny check command, if the repo has one. */
	defaultCheckCommand(cwd: string): string | undefined;
	/** What the worktree needs beyond tracked files. */
	bootstrapSpec(cwd: string): WorktreeBootstrapSpec;
	/**
	 * Ground truth about this repo's environments, handed verbatim to workers and to the
	 * orchestrator. Says which credentials are real and what a mistake actually costs.
	 */
	envDoctrine?: string;
	/** Run an end-to-end behavioral scenario. May be a no-op (ran:false) for generic repos. */
	runBehavioral(cwd: string, scenario: string, threshold?: number): Promise<BehavioralResult>;
}
