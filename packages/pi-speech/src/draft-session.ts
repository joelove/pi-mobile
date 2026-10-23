// One draft on screen: opens the draft view, takes dictated updates and the finishing check, lets
// the developer refine it by voice or by typing, and ends with Enter (sent to pi) or Esc (moved
// to pi's editor). The recording that feeds it lives in dictation.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { Draft } from "./draft.ts";
import { DraftView, type ViewState, type ViewStatus } from "./draft-view.ts";
import { reconcile, requestUpdate, type TranscriptFile, wordCount } from "./drafting.ts";
import type { Complete } from "./model.ts";

export interface DraftSessionOptions {
	draft: Draft;
	transcript: TranscriptFile;
	/** Editor text before dictation started; kept when the draft is moved to the editor. */
	before: string;
	/** The fast model (live updates, changes by voice). */
	fast: Complete;
	/** The session's model (the finishing check); falls back to the fast one. */
	careful: Complete;
	reducedMotion?: boolean;
	/** The workspace's names for this speech (see vocabularyPrompt). */
	vocabulary?: (speech: string) => string;
	send: (text: string, idle: boolean) => void;
	/** alt+d while the view is open (the shortcut doesn't reach pi while the overlay has focus). */
	onAltM: () => void;
	/** Esc or Ctrl+C while a recording feeds the draft: stop it without losing what was said. */
	onStopRecording: () => void;
	/**
	 * Words heard but not drafted yet (the drafter's pending speech). Esc keeps them below the draft,
	 * under ALSO_NOT_DRAFTED, so nothing said is only on disk.
	 */
	pending?: () => string;
	/** Everything heard so far; Esc on an empty draft keeps it (else the transcript on disk). */
	heard?: () => string;
	/** `said`: the transcript as it was when the draft closed. */
	onClose: (how: "sent" | "kept", markdown: string, said: string) => void;
	/** Key hints where they differ from dictation's (voice mode). */
	hints?: (state: ViewState) => string | undefined;
}

/** The heading Esc puts above words that were heard but not drafted yet. */
export const ALSO_NOT_DRAFTED = "Also mentioned (not drafted yet)";

export class DraftSession {
	state: ViewState = "listening";
	hearing = "";
	note = "";
	/** Clock of the recording feeding the draft. */
	clock: () => { elapsedMs: number; warning?: string } = () => ({ elapsedMs: 0 });
	/** Stops the recording feeding the draft (Esc): the first one, or the one changing it by voice. */
	stopRecording: () => void = () => this.o.onStopRecording();
	private view?: DraftView;
	private tui?: TUI;
	private done?: (r: null) => void;
	private offAltM?: () => void;
	private checking?: AbortController;
	private closed = false;
	private c: ExtensionContext;
	private o: DraftSessionOptions;

	constructor(c: ExtensionContext, o: DraftSessionOptions) {
		this.c = c;
		this.o = o;
	}

	get draft(): Draft {
		return this.o.draft;
	}

	get transcript(): TranscriptFile {
		return this.o.transcript;
	}

	get open(): boolean {
		return !this.closed;
	}

	show(): void {
		void this.c.ui
			.custom<null>(
				(tui, theme, _kb, done) => {
					this.tui = tui;
					this.done = done;
					this.view = new DraftView(tui, theme, this.o.draft, {
						status: () => this.status(),
						onEnter: () => this.enter(),
						onEscape: () => this.escape(),
						onAltM: () => this.o.onAltM(),
						reducedMotion: this.o.reducedMotion,
						hints: this.o.hints,
					});
					this.offAltM = tui.addInputListener((data) => {
						if (this.closed || !(matchesKey(data, "alt+d"))) return undefined;
						this.o.onAltM();
						return { consume: true };
					});
					if (this.closed) queueMicrotask(() => this.dispose());
					return this.view;
				},
				{ overlay: true, overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%" } },
			)
			.catch(() => {});
	}

	status(): ViewStatus {
		return { state: this.state, ...this.clock(), hearing: this.hearing, note: this.note };
	}

	refresh(): void {
		this.tui?.requestRender();
	}

	setState(s: ViewState, note = ""): void {
		this.state = s;
		this.note = note;
		if (s !== "listening" && s !== "changing") this.hearing = "";
		this.refresh();
	}

	heard(text: string): void {
		this.hearing = text;
		this.refresh();
	}

	dictated(ids: number[]): void {
		if (ids.length) this.view?.dictated(ids);
		else this.refresh();
	}

	/** The speaker finished: one check of the whole draft against everything said, then it waits for refining. */
	async finish(transcript: string): Promise<void> {
		if (this.closed) return;
		this.setState("checking");
		const abort = new AbortController();
		this.checking = abort;
		let note = "";
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]);
		try {
			const vocabulary = this.o.vocabulary?.(transcript);
			const ids = await reconcile(this.o.careful, this.o.draft, transcript, Date.now, { signal, vocabulary }).catch((e) => {
				if (abort.signal.aborted) throw e;
				return reconcile(this.o.fast, this.o.draft, transcript, Date.now, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]), vocabulary });
			});
			if (this.closed) return;
			this.dictated(ids);
			// Corrections are points: a section heading that came with one isn't counted (as on the phone).
			const n = ids.filter((id) => this.o.draft.blocks.find((b) => b.id === id)?.kind !== "heading").length;
			note = n ? `Checked against everything you said: ${n} correction${n > 1 ? "s" : ""} (highlighted).` : "Checked against everything you said: nothing missing.";
		} catch (e: any) {
			if (this.closed || abort.signal.aborted) return;
			note = `Couldn't check the draft against what you said (${String(e?.message ?? e).slice(0, 80)}). /dictate raw has the transcript.`;
		}
		this.checking = undefined;
		if (this.o.draft.empty && wordCount(transcript)) note = "The draft is empty: no model could write it. Esc puts the transcript in the editor.";
		this.setState("ready", note);
	}

	/** A change said while the draft was ready ("drop the third point"), applied as section edits that glow. */
	async change(speech: string): Promise<void> {
		if (this.closed) return;
		if (!speech.trim()) return this.setState("ready", "Didn't catch a change.");
		this.setState("checking");
		const abort = new AbortController();
		this.checking = abort;
		const asked = Date.now();
		try {
			const u = await requestUpdate(this.o.fast, this.o.draft, speech, {
				mode: "change",
				vocabulary: this.o.vocabulary?.(speech),
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
			});
			if (this.closed) return;
			if (!u.ok) throw new Error("the model returned something unreadable");
			const ids = this.o.draft.apply(u, Date.now(), { protect: (b) => (b.typedAt ?? -Infinity) >= asked });
			this.dictated(ids);
			this.setState("ready", ids.length ? "" : `Nothing changed for “${speech.slice(0, 60)}”.`);
		} catch (e: any) {
			if (this.closed || abort.signal.aborted) return;
			this.setState("ready", `Couldn't apply the change (${String(e?.message ?? e).slice(0, 80)}).`);
		} finally {
			this.checking = undefined;
		}
	}

	private enter(): void {
		if (this.state === "listening" || this.state === "changing") return this.o.onAltM();
		if (this.state === "ready") this.send();
	}

	private escape(): void {
		if (this.state === "listening" || this.state === "changing") this.stopRecording();
		this.keep();
	}

	send(): void {
		const md = this.o.draft.markdown();
		if (!md.trim()) {
			this.note = "The draft is empty. Esc closes it.";
			return this.refresh();
		}
		this.dispose();
		this.o.send(md, this.c.isIdle());
		const said = this.o.transcript.text();
		this.o.transcript.delete();
		this.o.onClose("sent", md, said);
	}

	/**
	 * Esc: the draft goes to pi's editor as ordinary text (after anything typed there before); the
	 * transcript stays. Words heard but not drafted yet (up to an update's worth, or all that's left
	 * while the check runs) go below it, so the editor has everything said.
	 */
	keep(): void {
		if (this.closed) return;
		let md: string;
		if (this.o.draft.empty) md = (this.o.heard?.().trim() || this.o.transcript.text()).replace(/\s*\n\s*/g, " ");
		else {
			const rest = this.o.pending?.().trim();
			md = this.o.draft.markdown();
			if (rest && wordCount(rest)) md = `${md}\n\n## ${ALSO_NOT_DRAFTED}\n\n${rest}`;
		}
		this.dispose();
		this.c.ui.setEditorText(this.o.before.trim() ? `${this.o.before}\n\n${md}` : md);
		this.o.onClose("kept", md, this.o.transcript.text());
	}

	dispose(): void {
		this.closed = true;
		this.checking?.abort();
		this.view?.dispose();
		this.offAltM?.();
		this.offAltM = undefined;
		const done = this.done;
		this.done = undefined;
		try {
			done?.(null);
		} catch {}
	}
}
