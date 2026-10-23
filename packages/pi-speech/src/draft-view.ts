// The draft view: a full-terminal overlay with pi's own footer kept at the bottom. The draft is
// rendered Markdown (one pi-tui Markdown per block, so each rendered line maps to its block); what
// dictation just changed glows and fades, removed text is struck through for a moment; typing shows
// the source of the one block under the cursor. The view follows the latest dictated change.

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	mixColors,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Block, type Draft, fenceOf, gapBefore, markdownBlocks, openFence, setGap } from "./draft.ts";

/** Accent mixed into the background, one step per second: the glow fades over about three seconds. */
export const GLOW_MIX = [0.55, 0.32, 0.14];
export const GLOW_STEP_MS = 1000;
export const REMOVED_MS = 2000;
/** Rows kept for pi's footer when it can't be found. */
const FALLBACK_FOOTER_ROWS = 2;

export type ViewState = "listening" | "checking" | "ready" | "changing";

export interface ViewStatus {
	state: ViewState;
	elapsedMs: number;
	/** "1 minute left" and the like, shown next to the clock. */
	warning?: string;
	/** The latest words, shown at once in the dim Hearing line. */
	hearing?: string;
	/** A short note (e.g. updates paused), shown where Hearing is when not listening. */
	note?: string;
}

export interface DraftViewOptions {
	status: () => ViewStatus;
	onEnter: () => void;
	onEscape: () => void;
	onAltM: () => void;
	now?: () => number;
	reducedMotion?: boolean;
	markdownTheme?: MarkdownTheme;
	/** Re-render on a timer while something moves (clock, fades, strike-through). Off in tests. */
	animate?: boolean;
	/** The key hints per state, where they differ (voice mode: "say that's it", "send it"). */
	hints?: (state: ViewState) => string | undefined;
}

export interface RenderedLine {
	text: string;
	blockId?: number;
}

/** Paints a full-width background under an already styled line, surviving the line's own resets. */
export function withBg(line: string, bg: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(line));
	const body = line.replace(/\x1b\[(?:0|49)?m/g, (m) => m + bg);
	return `${bg}${body}${" ".repeat(pad)}\x1b[49m`;
}

/** A key or a paste that is text to insert (tabs included), not a control key or an escape sequence. */
const isText = (data: string) => !!data && !data.startsWith("\x1b") && !/[\x00-\x08\x0a-\x1f\x7f]/.test(data);

/** Where `col` is in `src`: the line's start and end offsets and the column within the line. */
function lineAt(src: string, col: number): { start: number; end: number; x: number; first: boolean; last: boolean } {
	const start = src.lastIndexOf("\n", col - 1) + 1;
	const nl = src.indexOf("\n", col);
	const end = nl < 0 ? src.length : nl;
	return { start, end, x: col - start, first: start === 0, last: nl < 0 };
}

/** The end of `text` that fits `width` columns, cut at a word: the latest words stay visible. */
export function tail(text: string, width: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	if (visibleWidth(t) <= width) return t;
	const words = t.split(" ");
	let out = "";
	for (let i = words.length - 1; i >= 0; i--) {
		const next = out ? `${words[i]} ${out}` : words[i]!;
		if (visibleWidth(next) + 1 > width) break;
		out = next;
	}
	return `…${out || truncateToWidth(words[words.length - 1]!, width - 1, "")}`;
}

class Glow {
	private ansi: string[] = [];
	private theme: Theme;
	readonly motion: boolean;
	constructor(theme: Theme, reduced: boolean) {
		this.theme = theme;
		const mode = theme.getColorMode();
		this.motion = !reduced && (mode === "truecolor" || mode === "256color");
		this.rebuild();
	}
	rebuild(): void {
		if (!this.motion) return;
		const c = this.theme.colors;
		// There is no terminal-background token; the user message background is the closest neutral base.
		this.ansi = GLOW_MIX.map((m) => backgroundAnsi(mixColors(c.userMessageBg, c.accent, m), this.theme.getColorMode()));
	}
	/** The background for a block dictation changed at `t`, or undefined once it has faded. */
	bg(t: number | undefined, now: number): string | undefined {
		if (t === undefined || !this.motion || now < t) return undefined;
		return this.ansi[Math.floor((now - t) / GLOW_STEP_MS)];
	}
	get steps(): readonly string[] {
		return this.ansi;
	}
}

class BlockRenderer {
	private cache = new Map<number, { src: string; width: number; lines: string[] }>();
	private md: MarkdownTheme;
	constructor(md: MarkdownTheme) {
		this.md = md;
	}
	render(b: Block, width: number): string[] {
		const hit = this.cache.get(b.id);
		if (hit && hit.src === b.src && hit.width === width) return hit.lines;
		// Rendered alone, a nested item loses its indentation; put it back.
		const indent = /^\s*/.exec(b.src)![0].length;
		const lines = b.src.trim()
			? new Markdown(b.src.trimStart(), 0, 0, this.md).render(Math.max(1, width - indent)).map((l) => " ".repeat(indent) + l.trimEnd())
			: [""];
		while (lines.length > 1 && !stripTerminalSequences(lines[lines.length - 1]!).trim()) lines.pop();
		this.cache.set(b.id, { src: b.src, width, lines });
		return lines;
	}
	clear(): void {
		this.cache.clear();
	}
}

export class DraftView implements Component, Focusable {
	focused = false;
	private renderer: BlockRenderer;
	private glow: Glow;
	private scroll = 0;
	private follow = true;
	private followId?: number;
	private cursor?: { id: number; col: number };
	private lastKeyAt = -Infinity;
	private bodyHeight = 10;
	/** The clock second last drawn (the timer redraws only when it changes). */
	private shownSecond = -1;
	/** A bracketed paste that arrived in pieces. */
	private pasteBuf?: string;
	private timer?: ReturnType<typeof setInterval>;
	private now: () => number;

	private tui: TUI;
	private theme: Theme;
	private draft: Draft;
	private opts: DraftViewOptions;

	constructor(tui: TUI, theme: Theme, draft: Draft, opts: DraftViewOptions) {
		this.tui = tui;
		this.theme = theme;
		this.draft = draft;
		this.opts = opts;
		this.now = opts.now ?? Date.now;
		this.renderer = new BlockRenderer(opts.markdownTheme ?? getMarkdownTheme());
		this.glow = new Glow(theme, !!opts.reducedMotion);
		if (opts.animate !== false) {
			this.timer = setInterval(() => this.frame(), 250);
			this.timer.unref?.();
		}
	}

	/**
	 * One timer frame: prunes struck-through blocks and redraws only when something on screen moves (the
	 * clock's second, a glow fading, a strike-through ending). An idle draft isn't redrawn. Returns whether it drew.
	 */
	frame(now = this.now()): boolean {
		const pruned = this.draft.prune(now, REMOVED_MS);
		const st = this.opts.status();
		const ticking = (st.state === "listening" || st.state === "changing") && Math.floor(st.elapsedMs / 1000) !== this.shownSecond;
		const fading =
			this.glow.motion && this.draft.blocks.some((b) => b.changedAt !== undefined && now >= b.changedAt && now - b.changedAt < GLOW_MIX.length * GLOW_STEP_MS + GLOW_STEP_MS);
		if (!pruned && !ticking && !fading) return false;
		this.tui.requestRender();
		return true;
	}

	/** True when changes glow and fade; false for the no-motion margin mark. */
	get motion(): boolean {
		return this.glow.motion;
	}

	/** Glow backgrounds, strongest first (for tests and checks). */
	get glowSteps(): readonly string[] {
		return this.glow.steps;
	}

	/** Dictation changed these blocks: follow the change again. */
	dictated(ids: number[]): void {
		const live = this.draft.live();
		const target = [...ids].reverse().find((id) => live.some((b) => b.id === id)) ?? ids[ids.length - 1];
		if (target !== undefined) {
			this.follow = true;
			this.followId = target;
		}
		this.tui.requestRender();
	}

	// ── input ──

	handleInput(data: string): void {
		this.lastKeyAt = this.now();
		if (this.pasteBuf !== undefined || data.includes("\x1b[200~")) return this.pasteChunk(data);
		if (matchesKey(data, "alt+d")) return this.opts.onAltM();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.opts.onEscape();
		if (matchesKey(data, "shift+enter") || matchesKey(data, "alt+enter")) return this.newLine();
		if (matchesKey(data, "enter")) return this.opts.onEnter();
		if (matchesKey(data, "pageUp")) return this.scrollBy(-Math.max(1, this.bodyHeight - 2));
		if (matchesKey(data, "pageDown")) return this.scrollBy(Math.max(1, this.bodyHeight - 2));
		// Several lines at once without paste brackets: a terminal that doesn't bracket pastes.
		if (data.length > 1 && /[\r\n]/.test(data) && !data.startsWith("\x1b")) return this.paste(data);

		if (!this.draft.live().length) {
			if (!isText(data)) return this.tui.requestRender();
			// An empty draft: the first key starts a block.
			this.startBlock();
		}
		const live = this.draft.live();
		const { cur, col, at } = this.here(live);
		const now = this.now();
		const line = lineAt(cur.src, col);

		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const up = matchesKey(data, "up");
			if (!this.cursor) this.cursor = { id: cur.id, col };
			else if (up && !line.first) {
				// Within a block of several lines (a paragraph, a fence) first.
				const prev = lineAt(cur.src, line.start - 1);
				this.cursor = { id: cur.id, col: prev.start + Math.min(line.x, prev.end - prev.start) };
			} else if (!up && !line.last) {
				const next = lineAt(cur.src, line.end + 1);
				this.cursor = { id: cur.id, col: next.start + Math.min(line.x, next.end - next.start) };
			} else {
				const to = live[Math.max(0, Math.min(live.length - 1, at + (up ? -1 : 1)))]!;
				if (to === cur) this.cursor = { id: cur.id, col };
				else {
					const l = up ? lineAt(to.src, to.src.length) : lineAt(to.src, 0);
					this.cursor = { id: to.id, col: l.start + Math.min(line.x, l.end - l.start) };
				}
			}
		} else if (matchesKey(data, "left")) this.cursor = { id: cur.id, col: Math.max(0, col - 1) };
		else if (matchesKey(data, "right")) this.cursor = { id: cur.id, col: Math.min(cur.src.length, col + 1) };
		else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) this.cursor = { id: cur.id, col: line.start };
		else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) this.cursor = { id: cur.id, col: line.end };
		else if (matchesKey(data, "backspace")) {
			const prev = live[at - 1];
			if (col > 0) {
				this.draft.typed(cur, cur.src.slice(0, col - 1) + cur.src.slice(col), now);
				this.cursor = { id: cur.id, col: col - 1 };
			} else if (!cur.src) {
				// Backspace on an empty line removes it.
				this.draft.blocks.splice(this.draft.blocks.indexOf(cur), 1);
				this.cursor = prev ? { id: prev.id, col: prev.src.length } : undefined;
			} else if (prev && this.cursor) {
				// At the start of a block: it joins the one before, as lines do in an editor.
				const join = prev.src.length;
				this.draft.typed(prev, prev.src + cur.src, now);
				this.draft.blocks.splice(this.draft.blocks.indexOf(cur), 1);
				this.cursor = { id: prev.id, col: join };
			} else this.cursor = { id: cur.id, col };
		} else if (matchesKey(data, "delete")) {
			if (col < cur.src.length) this.draft.typed(cur, cur.src.slice(0, col) + cur.src.slice(col + 1), now);
			this.cursor = { id: cur.id, col };
		} else {
			// Typed text goes in as typed (a printable key, a tab); control keys and escape sequences are ignored.
			const text = data.replace(/\x1b\[20[01]~/g, "");
			if (!isText(text)) return;
			this.draft.typed(cur, cur.src.slice(0, col) + text + cur.src.slice(col), now);
			this.cursor = { id: cur.id, col: col + text.length };
		}
		this.typing();
	}

	/** The block under the cursor (the last one when there is no cursor yet), the cursor's column in it and its index. */
	private here(live: Block[]): { cur: Block; col: number; at: number } {
		const idx = this.cursor ? live.findIndex((b) => b.id === this.cursor!.id) : -1;
		const at = idx >= 0 ? idx : live.length - 1;
		const cur = live[at]!;
		const col = this.cursor && idx >= 0 ? Math.min(this.cursor.col, cur.src.length) : cur.src.length;
		return { cur, col, at };
	}

	/** Typing stops the following until the next dictated change. */
	private typing(): void {
		this.follow = false;
		this.followId = this.cursor?.id;
		this.tui.requestRender();
	}

	/** A new, empty block typed at the end (an empty draft gets its first one). */
	private startBlock(): Block {
		const b = this.draft.block("");
		b.typedAt = this.now();
		this.draft.blocks.push(b);
		this.cursor = { id: b.id, col: 0 };
		return b;
	}

	/** A bracketed paste, which may arrive in pieces. */
	private pasteChunk(data: string): void {
		const buf = this.pasteBuf === undefined ? data.slice(data.indexOf("\x1b[200~") + 6) : this.pasteBuf + data;
		const end = buf.indexOf("\x1b[201~");
		if (end < 0) {
			this.pasteBuf = buf;
			return;
		}
		this.pasteBuf = undefined;
		this.paste(buf.slice(0, end));
		const rest = buf.slice(end + 6);
		if (rest) this.handleInput(rest);
	}

	/**
	 * Pasted text keeps its lines and tabs (terminal escapes and other control characters go). Its line
	 * breaks make blocks as typed Markdown does: a paragraph keeps its soft breaks, list items and
	 * headings get their own blocks, a code fence stays whole; the block under the cursor takes the first.
	 */
	private paste(raw: string): void {
		const text = stripTerminalSequences(raw)
			.replace(/\r\n?/g, "\n")
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
		if (!text) return this.tui.requestRender();
		const now = this.now();
		if (!this.draft.live().length) this.startBlock();
		const { cur, col } = this.here(this.draft.live());
		const after = cur.src.slice(col);
		if (!text.includes("\n")) {
			this.draft.typed(cur, cur.src.slice(0, col) + text + after, now);
			this.cursor = { id: cur.id, col: col + text.length };
			return this.typing();
		}
		const parts = markdownBlocks(cur.src.slice(0, col) + text + after);
		if (!parts.length) return this.tui.requestRender();
		let i = this.draft.blocks.indexOf(cur);
		let last = cur;
		parts.forEach((p, n) => {
			const b = n === 0 ? cur : this.draft.block(p.src);
			if (n > 0) {
				this.draft.blocks.splice(++i, 0, b);
				setGap(last, b, p.gap);
			}
			this.draft.typed(b, p.src, now);
			last = b;
		});
		// The cursor goes where the paste ended: before the text that was after it.
		this.cursor = { id: last.id, col: last.src.endsWith(after) ? last.src.length - after.length : last.src.length };
		this.typing();
	}

	/**
	 * shift+enter: a new block at the cursor (the rest of the line moves into it). Inside a code fence it
	 * is a new line of the fence instead.
	 */
	private newLine(): void {
		if (!this.draft.live().length) {
			this.startBlock();
			return this.typing();
		}
		const { cur, col } = this.here(this.draft.live());
		const now = this.now();
		const closing = cur.src.lastIndexOf("\n") + 1;
		if (fenceOf(cur.src) && (openFence(cur.src) || (col > 0 && col < closing))) {
			this.draft.typed(cur, `${cur.src.slice(0, col)}\n${cur.src.slice(col)}`, now);
			this.cursor = { id: cur.id, col: col + 1 };
			return this.typing();
		}
		const rest = cur.src.slice(col);
		if (rest) this.draft.typed(cur, cur.src.slice(0, col), now);
		const b = this.draft.block(rest);
		b.typedAt = now;
		this.draft.blocks.splice(this.draft.blocks.indexOf(cur) + 1, 0, b);
		this.cursor = { id: b.id, col: 0 };
		this.typing();
	}

	private scrollBy(n: number): void {
		this.follow = false;
		this.followId = undefined;
		this.scroll = Math.max(0, this.scroll + n);
		this.tui.requestRender();
	}

	// ── render ──

	/** The draft's lines at `width`, each with the block it came from. */
	bodyLines(width: number, now = this.now()): RenderedLine[] {
		const th = this.theme;
		const out: RenderedLine[] = [];
		let prev: Block | undefined;
		for (const b of this.draft.blocks) {
			if (b.removedAt !== undefined && now - b.removedAt >= REMOVED_MS) continue;
			if (prev && gapBefore(prev, b)) out.push({ text: "" });
			prev = b;
			const editing = this.cursor?.id === b.id && b.removedAt === undefined;
			let lines: string[];
			if (b.removedAt !== undefined) {
				// The Markdown styling goes first: its resets would cancel the dim colour.
				lines = this.renderer.render(b, width).map((l) => th.fg("dim", th.strikethrough(stripTerminalSequences(l).trimEnd())));
			} else if (editing) {
				// Live preview: only the block under the cursor shows its Markdown source.
				const col = Math.min(this.cursor!.col, b.src.length);
				const ch = b.src[col];
				const marker = this.focused ? CURSOR_MARKER : "";
				// At a line's end the cursor is a space before the break; tabs show as spaces.
				const at = ch === undefined || ch === "\n" ? `\x1b[7m \x1b[27m${ch ?? ""}` : `\x1b[7m${ch}\x1b[27m`;
				const shown = `${b.src.slice(0, col)}${marker}${at}${b.src.slice(col + 1)}`.replace(/\t/g, "   ");
				lines = wrapTextWithAnsi(th.fg("muted", shown), width);
			} else lines = this.renderer.render(b, width);
			const bg = b.removedAt === undefined && !editing ? this.glow.bg(b.changedAt, now) : undefined;
			for (const l of lines) out.push({ text: bg ? withBg(l, bg, width) : l, blockId: b.id });
		}
		return out;
	}

	/** pi's footer, rendered each frame: the last child of the TUI root (not a public API, so guarded). */
	private footerLines(width: number): string[] | undefined {
		const children = (this.tui as any).children;
		const footer = Array.isArray(children) ? children[children.length - 1] : undefined;
		if (!footer || typeof footer.render !== "function" || footer === this) return undefined;
		try {
			const lines = footer.render(width);
			return Array.isArray(lines) ? lines.map((l: unknown) => truncateToWidth(String(l), width)) : undefined;
		} catch {
			return undefined;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const now = this.now();
		const st = this.opts.status();
		const rows = Math.max(1, this.tui.terminal.rows);
		let footer = this.footerLines(width) ?? Array<string>(FALLBACK_FOOTER_ROWS).fill("");
		if (rows - footer.length < 4) footer = [];
		const height = rows - footer.length;
		const inner = Math.max(1, width - 2); // one column of margin each side

		const secs = Math.floor(st.elapsedMs / 1000);
		this.shownSecond = secs;
		const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
		const right =
			st.state === "listening" || st.state === "changing"
				? `${st.warning ? `${th.fg("warning", st.warning)}  ` : ""}${th.fg("error", "●")} ${th.fg("dim", clock)}`
				: st.state === "checking"
					? th.fg("accent", "◌ Checking")
					: th.fg("success", "Ready");
		const title = truncateToWidth(th.bold(`Draft${this.draft.title ? ` · ${this.draft.title}` : ""}`), Math.max(1, inner - visibleWidth(right) - 2));
		const header = [title + " ".repeat(Math.max(1, inner - visibleWidth(title) - visibleWidth(right))) + right, ""];

		const listening = st.state === "listening" || st.state === "changing";
		const label = "Hearing: ";
		const hearing = listening
			? th.fg("dim", th.italic(`${label}${st.hearing ? tail(st.hearing, inner - label.length) : "…"}`))
			: st.note
				? th.fg("dim", truncateToWidth(st.note, inner))
				: "";
		const hints: Record<ViewState, string> = {
			listening: "Enter or alt+d finish · Esc keep as text · ↑↓ type · PgUp/PgDn scroll",
			changing: "Enter or alt+d done · Esc keep as text",
			checking: "Checking the draft against everything you said…  Esc keep as text",
			ready: "Enter send · Esc keep as text · alt+d change it by voice · ↑↓ type · PgUp/PgDn scroll",
		};
		const bottom = ["", hearing, "", th.fg("muted", this.opts.hints?.(st.state) ?? hints[st.state])];

		const bodyH = Math.max(1, height - header.length - bottom.length);
		this.bodyHeight = bodyH;
		let body = this.bodyLines(inner, now);
		if (!body.length) body = [{ text: th.fg("dim", st.state === "listening" ? "Keep talking: the draft forms at the next pause." : "The draft is empty.") }];
		const maxScroll = Math.max(0, body.length - bodyH);
		if (this.followId !== undefined && (this.follow || this.cursor?.id === this.followId)) {
			const first = body.findIndex((l) => l.blockId === this.followId);
			let last = first;
			while (last + 1 < body.length && body[last + 1]!.blockId === this.followId) last++;
			if (first >= 0) {
				if (last >= this.scroll + bodyH) this.scroll = last - bodyH + 1 + (this.follow ? 1 : 0);
				if (first < this.scroll) this.scroll = first;
			}
		}
		this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
		const visible = body.slice(this.scroll, this.scroll + bodyH);
		while (visible.length < bodyH) visible.push({ text: "" });
		const more = [this.scroll > 0 ? "↑" : " ", this.scroll < maxScroll ? "↓" : " "];
		// Without motion, a margin mark shows what dictation changed since the last key press.
		const marked = (id?: number) => {
			if (this.motion || id === undefined) return false;
			const b = this.draft.blocks.find((x) => x.id === id);
			return !!b && b.removedAt === undefined && b.changedAt !== undefined && b.changedAt > this.lastKeyAt;
		};

		const rowsOut = [
			...header.map((text) => ({ text, mark: false })),
			...visible.map((l) => ({ text: l.text, mark: marked(l.blockId) })),
			...bottom.map((text) => ({ text, mark: false })),
		].map((l, i) => {
			const edge = i === header.length ? more[0]! : i === header.length + bodyH - 1 ? more[1]! : " ";
			const content = truncateToWidth(l.text, inner);
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(content)));
			return truncateToWidth(`${l.mark ? th.fg("accent", "▎") : " "}${content}${pad}${th.fg("dim", edge)}`, width);
		});
		const main = rowsOut.slice(0, height);
		while (main.length < height) main.push("");
		return [...main, ...footer].slice(0, rows);
	}

	invalidate(): void {
		this.renderer.clear();
		this.glow.rebuild();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
