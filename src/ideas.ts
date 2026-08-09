/**
 * The idea backlog: a Linear-style status board for anything that isn't a mission yet.
 *
 * Org-level, not per-repo or per-mission — same storage shape as workspaces.json/routines.json,
 * a single JSON file under ~/.missions. Deliberately flat (no cycles, labels, sub-issues): this is
 * a fast-triage dumping ground, not a project-management tool.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { missionsPath } from "./paths.js";

export type IdeaStatus = "backlog" | "now" | "later" | "done";

export const IDEA_STATUSES: IdeaStatus[] = ["backlog", "now", "later", "done"];

export interface Idea {
	id: string;
	title: string;
	description: string;
	status: IdeaStatus;
	createdAt: string;
	updatedAt: string;
}

function ideasPath(): string {
	return missionsPath("ideas.json");
}

/** Every idea, newest-created first. Empty array if the file doesn't exist yet. */
export function readIdeas(): Idea[] {
	const p = ideasPath();
	if (!existsSync(p)) return [];
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as Idea[];
	} catch {
		return [];
	}
}

function writeIdeas(ideas: Idea[]): void {
	writeFileSync(ideasPath(), JSON.stringify(ideas, null, 2));
}

export function createIdea(title: string, description: string): Idea {
	const now = new Date().toISOString();
	const idea: Idea = {
		id: `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		title,
		description,
		status: "backlog",
		createdAt: now,
		updatedAt: now,
	};
	const ideas = readIdeas();
	ideas.unshift(idea);
	writeIdeas(ideas);
	return idea;
}

export function updateIdea(id: string, patch: Partial<Pick<Idea, "title" | "description" | "status">>): Idea | undefined {
	const ideas = readIdeas();
	const idx = ideas.findIndex((i) => i.id === id);
	if (idx === -1) return undefined;
	const next: Idea = { ...ideas[idx], ...patch, updatedAt: new Date().toISOString() };
	ideas[idx] = next;
	writeIdeas(ideas);
	return next;
}

export function deleteIdea(id: string): boolean {
	const ideas = readIdeas();
	const next = ideas.filter((i) => i.id !== id);
	if (next.length === ideas.length) return false;
	writeIdeas(next);
	return true;
}
