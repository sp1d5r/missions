"use client";

import { Component, type ReactNode } from "react";

/**
 * A panel fed content a model wrote can fail in ways `try/catch` around one render call can't
 * catch — a bad prop shape three components deep, a null the author didn't expect. Mermaid's own
 * parse errors are already handled locally (see arch-diagram.tsx); this is the backstop for
 * everything else in a panel, so one broken feature never takes the rest of the mission page with
 * it. Reports the error text so the fallback says something more useful than "Something broke."
 */
export class PanelErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: string | null }> {
	constructor(props: { label: string; children: ReactNode }) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error: unknown): { error: string } {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	render() {
		if (this.state.error) {
			return (
				<div className="faint" style={{ padding: "10px 0", fontSize: 11.5 }}>
					{this.props.label} failed to render — {this.state.error}
				</div>
			);
		}
		return this.props.children;
	}
}
