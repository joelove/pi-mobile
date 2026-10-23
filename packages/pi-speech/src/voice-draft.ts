// A monologue in voice mode as a draft on screen (monologue.ts decides when and drives it): the same
// draft, continuous drafting, transcript on disk and full-screen view as a long dictation
// (draft.ts, drafting.ts, draft-session.ts, draft-view.ts).
//
// What the draft hears: the realtime session's own transcription of each turn (gpt-4o-mini-transcribe,
// in the configured or system language). It is already running for the conversation, so it costs
// nothing more; it is turn-aligned with the commands ("that's it", "no, just answer that", "send it"),
// so they are left out exactly and the turns said before the draft opened are its first words; and
// each turn is transcribed on its own, so a long monologue can't degrade a stream. In the end-to-end
// run it was word-perfect on a two-minute description where Apple's on-device recogniser (fed the
// same microphone) heard "three retries" as "free retries" and "offline" as "a flying". The cost:
// the Hearing line shows each phrase when its pause ends (about a second late), not word by word.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadVoiceConfig, speechDir, writePrivate } from "./config.ts";
import { Dictionary } from "./dictionary.ts";
import { Draft, shapeOf } from "./draft.ts";
import { DraftSession } from "./draft-session.ts";
import type { ViewState } from "./draft-view.ts";
import { Drafter, draftsDir, TranscriptFile, vocabularyPrompt, wordCount } from "./drafting.ts";
import type { Complete } from "./model.ts";
import { cleanReadBack, type DraftFacts, type DraftPort, draftFacts, heuristicReadBack, type OpenDraft, READBACK_SYSTEM, readBackPrompt } from "./monologue.ts";
import { gatherVocabulary, type Vocabulary } from "./vocab.ts";

/** The fast model took 4-6 s for the sentence in testing; the finishing check has already run by then. */
const READBACK_TIMEOUT_MS = 10_000;
export const MISSED = "(a stretch could not be transcribed: say it again)";

export interface VoiceDraftDeps {
	ctx: ExtensionContext;
	/** The fast model (live updates, changes by voice, the read-back sentence). */
	fast: Complete;
	/** The session's model (the finishing check). */
	careful: Complete;
	/** Enter or "send it": to pi, or to the other session the voice talks to. */
	send(markdown: string): void;
	/** The other session ("api @devbox") when the voice is switched there, for the hints. */
	target(): string | undefined;
	log?(entry: Record<string, unknown>): void;
}

export class VoiceDraft implements DraftPort {
	readonly draft = new Draft();
	readonly transcript: TranscriptFile;
	readonly session: DraftSession;
	private drafter: Drafter;
	private vocab?: Vocabulary;
	/** Everything said into the draft so far. */
	private heardText = "";
	private listening = true;
	private finishing?: Promise<void>;
	private changedByVoice = false;
	private timer?: NodeJS.Timeout;
	private d: VoiceDraftDeps;

	constructor(d: VoiceDraftDeps, o: OpenDraft, events: { finish(): void; closed(how: "sent" | "kept"): void }) {
		this.d = d;
		const shape = shapeOf(o.shape);
		if (shape) this.draft.shape = shape;
		this.transcript = new TranscriptFile(draftsDir(speechDir()));
		const vocabulary = (speech: string) => (this.vocab ? vocabularyPrompt(speech, this.vocab) : "");
		this.drafter = new Drafter({
			complete: d.fast,
			draft: this.draft,
			vocabulary,
			onUpdate: (ids) => this.session.dictated(ids),
			onError: (e: any) => {
				d.log?.({ draft: "update failed", error: String(e?.message ?? e) });
				this.session.refresh();
			},
		});
		this.session = new DraftSession(d.ctx, {
			draft: this.draft,
			transcript: this.transcript,
			before: d.ctx.ui.getEditorText(),
			fast: d.fast,
			careful: d.careful,
			reducedMotion: loadVoiceConfig().reducedMotion,
			vocabulary,
			// Esc keeps the words heard but not drafted yet, below the draft.
			pending: () => this.drafter.pending(),
			send: (md) => d.send(md),
			// Enter or alt+d while listening: finished, as "that's it".
			onAltM: () => (this.listening ? events.finish() : undefined),
			onStopRecording: () => this.stopListening(),
			onClose: (how) => {
				this.stopListening();
				events.closed(how);
			},
			hints: (state) => voiceHints(state, d.target()),
		});
		// The clock starts where the monologue did.
		this.session.clock = () => ({ elapsedMs: Date.now() - o.since });
		this.session.show();
		void gatherVocabulary(d.ctx.cwd, d.ctx.sessionManager.getBranch() as any[], new Dictionary(speechDir(), writePrivate).top()).then(
			(v) => (this.vocab = v),
			() => {},
		);
		this.timer = setInterval(() => this.drafter.tick(), 250);
		this.timer.unref?.();
		// What was said before the draft opened is its first speech.
		if (o.seed.trim()) this.content(o.seed);
	}

	/** A turn of the realtime transcription: on disk at once, shown in the Hearing line, drafted at the next update. */
	content(text: string): void {
		const t = text.trim();
		if (!t || !this.listening) return;
		this.transcript.append(t);
		this.heardText = this.heardText ? `${this.heardText} ${t}` : t;
		this.drafter.heard(this.heardText);
		this.drafter.settled(this.heardText);
		this.session.heard(t);
	}

	missed(): void {
		if (this.listening) this.session.heard(MISSED);
	}

	private stopListening(): void {
		this.listening = false;
		clearInterval(this.timer);
	}

	finish(): Promise<void> {
		this.finishing ??= this.doFinish();
		return this.finishing;
	}

	private async doFinish(): Promise<void> {
		this.stopListening();
		this.session.setState("checking");
		const full = this.heardText;
		this.d.log?.({ draft: "heard", words: wordCount(full) });
		await this.drafter.settle();
		if (!this.session.open) return;
		const before = draftFacts(this.draft).questions;
		await this.session.finish(full);
		this.d.log?.({ draft: "checked", note: this.session.note, questions: { before, after: draftFacts(this.draft).questions } });
	}

	async change(speech: string): Promise<void> {
		if (!this.changedByVoice) this.transcript.append("(changing the draft by voice)");
		this.changedByVoice = true;
		this.transcript.append(speech);
		await this.session.change(speech);
	}

	facts(): DraftFacts {
		return draftFacts(this.draft);
	}

	/** The one spoken sentence: the fast model, or the count and the first points without one. */
	async readBack(f: DraftFacts): Promise<string> {
		if (!f.points.length) return heuristicReadBack(f);
		try {
			const out = await this.d.fast(READBACK_SYSTEM, readBackPrompt(f), { signal: AbortSignal.timeout(READBACK_TIMEOUT_MS), maxTokens: 120 });
			const line = cleanReadBack(out);
			if (!line) this.d.log?.({ draft: "read-back unusable", out });
			return line ?? heuristicReadBack(f);
		} catch (e: any) {
			this.d.log?.({ draft: "read-back failed", error: String(e?.message ?? e) });
			return heuristicReadBack(f);
		}
	}

	asking(question: string | undefined): void {
		if (this.session.state === "ready") this.session.setState("ready", question ? `Asking: ${question}` : "");
	}

	send(): void {
		if (this.session.state === "checking") return;
		this.session.send();
	}

	keep(): void {
		this.session.keep();
	}

	discard(): void {
		this.stopListening();
		this.drafter.stop();
		this.session.dispose();
	}

	/** Voice mode ended with the draft open: it is finished and stays for Enter or Esc. */
	orphan(): void {
		if (this.session.open && this.listening) void this.finish();
	}
}

/** The view's key hints in voice mode: what to say as well as which key. */
export function voiceHints(state: ViewState, target?: string): string | undefined {
	const to = target ? ` to ${target}` : "";
	if (state === "listening") return `Say "that's it" or Enter to finish · "no, just answer that" undoes · Esc keep as text · ↑↓ type`;
	if (state === "ready") return `Say "send it" or Enter to send${to} · Esc keep as text · say a change, or ↑↓ type`;
	return undefined;
}
