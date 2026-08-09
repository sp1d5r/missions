import type { ReactNode } from "react";

/**
 * Overseer answers and orchestrator assessments are LLM prose: **bold**, `code`, lists, the
 * occasional pipe table. Rendered raw (as every mission surface did before this), a table reads
 * as a wall of pipes and asterisks — plausible when you're not looking closely, actively
 * misleading when you are. This renders real elements, never `dangerouslySetInnerHTML`, so it
 * cannot introduce an injection surface no matter what a model writes into `**bold**`.
 */

function inline(text: string, keyPrefix: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
	let last = 0;
	let key = 0;
	let m: RegExpExecArray | null = re.exec(text);
	while (m) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		if (m[1] !== undefined) nodes.push(<strong key={`${keyPrefix}-${key++}`}>{m[1]}</strong>);
		else nodes.push(<code key={`${keyPrefix}-${key++}`}>{m[2]}</code>);
		last = re.lastIndex;
		m = re.exec(text);
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

function isTableRow(line: string): boolean {
	const t = line.trim();
	return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function isTableRule(line: string): boolean {
	return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim()) && line.includes("-");
}

function splitCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

export function renderMarkdown(text: string, keyPrefix = "md"): ReactNode[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let i = 0;
	let key = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}

		if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
			const header = splitCells(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && isTableRow(lines[i])) {
				rows.push(splitCells(lines[i]));
				i++;
			}
			const bk = `${keyPrefix}-b${key++}`;
			blocks.push(
				<div className="mdtable-wrap" key={bk}>
					<table className="mdtable">
						<thead>
							<tr>
								{header.map((h, idx) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional, never reordered
									<th key={idx}>{inline(h, `${bk}-th-${idx}`)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((r, ridx) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, never reordered
								<tr key={ridx}>
									{r.map((c, cidx) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional, never reordered
										<td key={cidx}>{inline(c, `${bk}-td-${ridx}-${cidx}`)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}

		const ulm = /^[-*]\s+(.*)$/.exec(line);
		const olm = /^\d+\.\s+(.*)$/.exec(line);
		if (ulm || olm) {
			const ordered = Boolean(olm);
			const items: string[] = [(ulm ?? olm)?.[1] ?? ""];
			i++;
			while (i < lines.length) {
				const nm = ordered ? /^\d+\.\s+(.*)$/.exec(lines[i]) : /^[-*]\s+(.*)$/.exec(lines[i]);
				if (!nm) break;
				items.push(nm[1]);
				i++;
			}
			const bk = `${keyPrefix}-b${key++}`;
			const Tag = ordered ? "ol" : "ul";
			blocks.push(
				<Tag key={bk}>
					{items.map((it, idx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: list items are positional, never reordered
						<li key={idx}>{inline(it, `${bk}-li-${idx}`)}</li>
					))}
				</Tag>,
			);
			continue;
		}

		const para: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !isTableRow(lines[i])) {
			para.push(lines[i]);
			i++;
		}
		blocks.push(<p key={`${keyPrefix}-b${key++}`}>{inline(para.join(" "), `${keyPrefix}-p${key}`)}</p>);
	}

	return blocks;
}

export function Markdown({ text }: { text: string }) {
	return <>{renderMarkdown(text)}</>;
}
