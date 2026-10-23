// Voice input in the terminal: speak instead of typing, review the distilled prompt in the editor.
// A long dictation (or one that describes rather than asks) becomes a draft instead: a structured
// document that forms in a full-screen view while you talk (draft-session.ts, drafting.ts).
//
//   alt+d or /dictate      start listening; again (or Enter) to finish; Esc cancels
//   /dictate raw           the verbatim transcript of the last dictation (in the editor; for drafts, shown)
//   /dictate undo          restore the editor to what it was before the last dictation
//   /dictate send|review   after dictation, send right away or leave it in the editor (default)
//   /dictate status        recogniser, model and microphone in use

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadVoiceConfig, saveVoiceConfig, speechDir, type VoiceConfig, writePrivate } from "./config.ts";
import { Dictionary } from "./dictionary.ts";
import { distill, editorText } from "./distill.ts";
import { Draft } from "./draft.ts";
import { DraftSession } from "./draft-session.ts";
import {
	becomesDraft,
	Drafter,
	draftsDir,
	latestTranscript,
	MAX_MS,
	newSpeech,
	pruneTranscripts,
	readTranscript,
	stopReason,
	TranscriptFile,
	WARN_MS,
	vocabularyPrompt,
	wordCount,
} from "./drafting.ts";
import { Listening } from "./listening.ts";
import { inputDeviceName, level, type Mic, SILENT_PEAK, silenceAdvice, startMic } from "./mic.ts";
import { type Complete, registryComplete, sessionComplete } from "./model.ts";
import { chooseStt, prewarmApple, type SttProvider } from "./stt.ts";
import { gatherVocabulary, recognizerHints, type Vocabulary } from "./vocab.ts";

const WIDGET = "pi-speech-dictation";
const STATUS = "pi-speech-dictation";
// pi-mobile registers dictation itself and also bundles pi-speech: whichever loads first owns it.
const CLAIM = Symbol.for("pi-speech.dictation");
const BARS = " ▁▂▃▄▅▆▇█";

interface Last {
	raw: string;
	distilled: string;
	before: string;
	learned?: boolean;
	/** The dictation became a draft. */
	draft?: boolean;
	/** A draft moved to the editor: where its transcript is kept. */
	transcriptPath?: string;
}

/** The outside world dictation uses; each part can be replaced (tests use fakes, never the real mic). */
export interface DictationIO {
	config: () => VoiceConfig;
	/** pi-speech's state dir (transcripts go in its drafts folder). */
	dir: () => string;
	stt: (cfg: VoiceConfig) => SttProvider;
	vocabulary: (c: ExtensionContext) => Promise<Vocabulary>;
	startMic: (onData: (pcm: Buffer) => void, onError: (message: string) => void) => Promise<Mic>;
	now: () => number;
}

const realIO: DictationIO = {
	config: () => loadVoiceConfig(),
	dir: () => speechDir(),
	stt: (cfg) => chooseStt(cfg, speechDir()),
	vocabulary: (c) => gatherVocabulary(c.cwd, c.sessionManager.getBranch() as any[], new Dictionary(speechDir(), writePrivate).top()),
	startMic: (onData, onError) => startMic(onData, onError),
	now: () => Date.now(),
};

interface Deps {
	io: DictationIO;
	fast: Complete;
	careful: Complete;
	send: (text: string, idle: boolean) => void;
	onEnd: (r: Recording) => void;
	onResult: (l: Last) => void;
	/** alt+d from the draft view. */
	toggle: () => void;
	onDraft: (s: DraftSession) => void;
	onDraftClosed: (how: "sent" | "kept", markdown: string, said: string, s: DraftSession, r: Recording) => void;
}

/**
 * `complete`: the fast model for distillation, live drafting and changes by voice (default: a fast
 * model you have). The finishing check of a draft always uses the session's model.
 */
export function registerDictation(pi: ExtensionAPI, complete?: Complete, ioOverrides: Partial<DictationIO> = {}): void {
	const io: DictationIO = { ...realIO, ...ioOverrides };
	const g = globalThis as Record<symbol, unknown>;
	if (g[CLAIM]) return;
	const claim = {};
	g[CLAIM] = claim;
	let ctx: ExtensionContext | undefined;
	let rec: Recording | undefined;
	let draft: DraftSession | undefined;
	let last: Last | undefined;
	let clearTimer: NodeJS.Timeout | undefined;
	const done = complete ?? registryComplete(() => ctx!, () => io.config().model);
	// The check against the whole transcript runs on the session's model, whoever supplies the fast one.
	const careful = sessionComplete(() => ctx!);

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		// Only in a real interactive terminal (not tests, print or RPC modes).
		const cfg = io.config();
		if (c.mode === "tui" && process.stdout.isTTY && (cfg.stt ?? "auto") !== "openai") prewarmApple(io.dir(), cfg.locale);
		if (c.mode === "tui") {
			try {
				pruneTranscripts(draftsDir(io.dir()));
			} catch {}
		}
	});
	pi.on("session_shutdown", async () => {
		rec?.cancel("");
		draft?.dispose();
		draft = undefined;
		clearTimeout(clearTimer);
		// A reload loads both extensions again; let the next runtime claim dictation.
		if (g[CLAIM] === claim) delete g[CLAIM];
	});
	pi.on("input", async (e: any) => {
		if (!rec && ctx?.hasUI) ctx.ui.setWidget(WIDGET, undefined);
		// What you changed in a dictation before sending it is learned for next time.
		if (last && !last.learned && typeof e?.text === "string" && e.source !== "extension") {
			last.learned = true;
			try {
				new Dictionary(speechDir(), writePrivate).learn(last.distilled, e.text);
			} catch {}
		}
		return { action: "continue" as const };
	});

	const toggle = async (c: ExtensionContext) => {
		ctx = c;
		if (c.mode !== "tui") return c.ui.notify("Voice input needs the interactive terminal.", "warning");
		if (rec) return rec.finish();
		// The draft is open and ready: dictating again changes it.
		if (draft?.open && draft.state !== "ready") return;
		clearTimeout(clearTimer);
		const deps: Deps = {
			io,
			fast: done,
			careful: async (system, user, opts) => careful(system, user, opts),
			send: (text, idle) => (idle ? pi.sendUserMessage(text) : pi.sendUserMessage(text, { deliverAs: "steer" })),
			onEnd: (r) => {
				if (rec === r) rec = undefined;
			},
			onResult: (l) => {
				last = l;
				clearTimer = setTimeout(() => c.ui.setWidget(WIDGET, undefined), 20_000);
			},
			toggle: () => void toggle(c),
			onDraft: (s) => {
				draft = s;
			},
			onDraftClosed: (how, md, said, s, r) => {
				if (draft === s) draft = undefined;
				last = { raw: said, distilled: md, before: r.before, learned: true, draft: true, transcriptPath: how === "kept" ? s.transcript.path : undefined };
				const words = wordCount(said);
				const t = c.ui.theme;
				c.ui.setWidget(WIDGET, [
					t.fg(
						"dim",
						how === "sent"
							? `Draft sent (${words} words dictated) · /dictate raw shows what you said`
							: `Draft in the editor · /dictate raw shows what you said (kept 7 days) · /dictate undo restores`,
					),
				]);
				clearTimeout(clearTimer);
				clearTimer = setTimeout(() => c.ui.setWidget(WIDGET, undefined), 20_000);
			},
		};
		rec = new Recording(c, deps, draft?.open ? draft : undefined);
		await rec.start();
	};

	pi.registerShortcut("alt+d", { description: "Voice input: start or finish dictation", handler: toggle });

	pi.registerCommand("dictate", {
		description: "Voice input: dictate, get a clean prompt or a draft to review (alt+d). raw | undo | send | review | status",
		getArgumentCompletions: (prefix) =>
			["raw", "undo", "send", "review", "status"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, c) => {
			ctx = c;
			const sub = args.trim().toLowerCase();
			if (!sub) return toggle(c);
			if (sub === "raw" && (!last || last.draft)) {
				// A draft's transcript is long: show it without touching the editor (which may hold the draft).
				const found = last ? { path: last.transcriptPath, text: (last.transcriptPath && readTranscript(last.transcriptPath)) || last.raw } : latestTranscript(draftsDir(io.dir()));
				if (!found?.text) return c.ui.notify("No dictation yet. Press alt+d to start.", "info");
				await c.ui.editor(`What you said${found.path ? ` (${found.path})` : ""}`, found.text);
				return;
			}
			if (sub === "raw" || sub === "undo") {
				if (!last) return c.ui.notify("No dictation yet. Press alt+d to start.", "info");
				c.ui.setEditorText(sub === "raw" ? (last.before ? `${last.before} ${last.raw}` : last.raw) : last.before);
				return;
			}
			if (sub === "send" || sub === "review") {
				saveVoiceConfig({ ...loadVoiceConfig(), afterDictation: sub });
				return c.ui.notify(sub === "send" ? "Dictation is sent as soon as it is distilled." : "Dictation goes to the editor for review.", "info");
			}
			if (sub === "status") {
				const cfg = loadVoiceConfig();
				let stt = "";
				try {
					stt = chooseStt(cfg, speechDir()).name;
				} catch (e: any) {
					stt = `unavailable (${e.message})`;
				}
				const mic = await inputDeviceName();
				return c.ui.notify(
					`Voice input: recogniser ${stt}${cfg?.locale ? ` (${cfg.locale})` : ""} · model ${cfg?.model ?? "auto (fast model you have)"} · after dictation: ${cfg?.afterDictation ?? "review"} · mic ${mic ? `${mic}${process.env.PI_SPEECH_MIC || process.env.PI_MOBILE_MIC ? "" : " (system default)"}` : "system default"}`,
					"info",
				);
			}
			c.ui.notify("Usage: /dictate [raw|undo|send|review|status]  (alt+d starts and finishes dictation)", "info");
		},
	});
}

/** The workspace's names for the drafting model (as distillation gets them). */
function draftVocabulary(speech: string, v: Vocabulary | undefined): string {
	return v ? vocabularyPrompt(speech, v) : "";
}

/**
 * One recording. Mode "dictate": a short one becomes a prompt in the editor (distilled, as always);
 * a long one becomes a draft. Mode "change": speech that changes an open, finished draft.
 */
class Recording {
	before = "";
	private mic?: Mic;
	private listening?: Listening;
	private transcript?: TranscriptFile;
	private drafter?: Drafter;
	private vocab?: Vocabulary;
	private partial = "";
	/** Settled segments this recording wrote to the transcript. */
	private written = "";
	private lastFinal = "";
	private levels: number[] = [];
	private peak = 0;
	private lastVoice: number;
	private startedAt: number;
	private timer?: NodeJS.Timeout;
	private unsubscribe?: () => void;
	private state: "starting" | "listening" | "thinking" | "done" = "starting";
	private abort = new AbortController();
	private c: ExtensionContext;
	private deps: Deps;
	/** Set in "change" mode, or once a dictation became a draft. */
	private session?: DraftSession;
	/** "change" mode: this recording changes an open, finished draft. */
	private changing: boolean;

	constructor(c: ExtensionContext, deps: Deps, session?: DraftSession) {
		this.c = c;
		this.deps = deps;
		this.session = session;
		this.changing = !!session;
		this.startedAt = this.lastVoice = deps.io.now();
	}

	private now(): number {
		return this.deps.io.now();
	}

	async start(): Promise<void> {
		this.before = this.c.ui.getEditorText();
		if (this.session) {
			this.session.clock = () => this.clock();
			// Esc while changing stops this recording (not the one that formed the draft).
			this.session.stopRecording = () => this.stopKeeping();
			this.session.setState("changing");
		} else {
			this.render();
			// Keys while listening: Enter or alt+d finishes, Esc cancels; everything else is swallowed so a
			// stray key doesn't edit the draft underneath. (Once the draft view is open, it takes the keys.)
			this.unsubscribe = this.c.ui.onTerminalInput((data) => {
				if (this.state === "done" || this.session) return undefined;
				if (data === "\x1b" || data === "\x03") {
					this.cancel("Dictation cancelled.");
					return { consume: true };
				}
				if (this.state === "thinking") return { consume: true };
				if (data === "\r" || data === "\n" || data === "\x1bm" || data === "µ") void this.finish();
				return { consume: true };
			});
		}
		try {
			const io = this.deps.io;
			const stt = io.stt(io.config());
			const vocab = await io.vocabulary(this.c);
			if (this.state === "done") return;
			this.vocab = vocab;
			this.transcript = this.session?.transcript ?? new TranscriptFile(draftsDir(io.dir()));
			if (this.changing) this.transcript.append("(changing the draft by voice)");
			this.listening = new Listening(stt, recognizerHints(vocab));
			this.listening.onText = (t) => {
				this.partial = t;
				this.drafter?.heard(t);
				this.session?.heard(this.hearing());
			};
			this.listening.onVolatile = () => this.session?.heard(this.hearing());
			this.listening.onFinal = (s, settled) => {
				// Settled text goes to disk at once; it is also what drives the next draft update.
				this.transcript?.append(s);
				this.written = this.written ? `${this.written} ${s}` : s;
				this.lastFinal = s;
				this.drafter?.settled(settled);
				this.session?.heard(this.hearing());
			};
			if (!this.changing) {
				this.drafter = new Drafter({
					complete: this.deps.fast,
					draft: new Draft(),
					now: io.now,
					vocabulary: (s) => draftVocabulary(s, this.vocab),
					onUpdate: (ids) => this.session?.dictated(ids),
					onError: () => this.session?.refresh(),
				});
			}
			this.mic = await io.startMic(
				(pcm) => {
					this.listening?.write(pcm);
					const l = level(pcm);
					if (l > this.peak) this.peak = l;
					this.levels.push(l);
					if (this.levels.length > 24) this.levels.shift();
					if (l > 0.04) this.lastVoice = this.now();
				},
				(msg) => {
					// With a draft open, a microphone failure ends the recording but keeps everything said so far.
					if (this.session && this.state === "listening") {
						this.c.ui.notify(`Voice input: ${msg}`, "warning");
						void this.finish();
					} else this.cancel(msg, "error");
				},
			);
			// Cancelled while the microphone was starting.
			if ((this.state as string) === "done") return this.mic.stop();
			this.startedAt = this.now();
			this.lastVoice = this.now();
			this.state = "listening";
			this.timer = setInterval(() => this.tick(), 100);
		} catch (e: any) {
			if (this.session && this.changing) {
				this.state = "done";
				this.cleanup();
				this.session.setState("ready", `Voice input: ${e?.message ?? e}`);
			} else this.cancel(`Voice input: ${e?.message ?? e}`, "error");
		}
	}

	/**
	 * The Hearing line: the words the recogniser hasn't settled yet (they appear at once); right after
	 * a pause, the segment it just settled. A recogniser that doesn't settle segments shows everything.
	 */
	private hearing(): string {
		const l = this.listening;
		if (!l) return "";
		if (!l.settled && !l.volatile) return this.partial;
		return l.volatile || this.lastFinal;
	}

	private clock(): { elapsedMs: number; warning?: string } {
		const elapsedMs = this.state === "starting" ? 0 : this.now() - this.startedAt;
		const left = Math.max(0, Math.ceil((MAX_MS - elapsedMs) / 1000));
		return { elapsedMs, warning: elapsedMs >= WARN_MS ? `stops in ${left}s` : undefined };
	}

	private tick(): void {
		if (this.state !== "listening") return;
		const now = this.now();
		const elapsedMs = now - this.startedAt;
		// Pauses are thinking: only the limit ends a recording, or long silence when nothing was said at all.
		if (stopReason({ elapsedMs, silentMs: now - this.lastVoice, heard: !!this.partial.trim() })) {
			void this.finish();
			return;
		}
		if (elapsedMs >= WARN_MS) this.c.ui.setStatus(STATUS, this.c.ui.theme.fg("warning", `Dictation stops in ${this.clock().warning?.replace(/^stops in /, "")}`));
		if (this.drafter) {
			this.drafter.tick(now);
			if (!this.session && !this.drafter.broken && becomesDraft({ elapsedMs, words: wordCount(this.partial), kind: this.drafter.kind })) this.becomeDraft();
		}
		this.render();
	}

	/** The dictation is long (or a description): the full-screen draft view takes over. */
	private becomeDraft(): void {
		if (this.session || !this.drafter || !this.transcript) return;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.c.ui.setWidget(WIDGET, undefined);
		const cfg = this.deps.io.config();
		const drafter = this.drafter;
		const s: DraftSession = new DraftSession(this.c, {
			draft: this.drafter.draft,
			transcript: this.transcript,
			before: this.before,
			fast: this.deps.fast,
			careful: this.deps.careful,
			reducedMotion: cfg.reducedMotion,
			vocabulary: (sp) => draftVocabulary(sp, this.vocab),
			send: this.deps.send,
			onAltM: this.deps.toggle,
			onStopRecording: () => this.stopKeeping(),
			pending: () => drafter.pending(),
			heard: () => drafter.heardText,
			onClose: (how, md, said) => this.deps.onDraftClosed(how, md, said, s, this),
		});
		s.clock = () => this.clock();
		s.heard(this.hearing());
		this.session = s;
		this.deps.onDraft(s);
		s.show();
	}

	async finish(): Promise<void> {
		if (this.state !== "listening") return;
		this.state = "thinking";
		this.mic?.stop();
		clearInterval(this.timer);
		this.c.ui.setStatus(STATUS, undefined);
		const elapsedMs = this.now() - this.startedAt;
		this.session?.setState("checking");
		this.render();
		try {
			let raw: string;
			try {
				raw = (await this.listening!.end()).trim();
			} catch (e) {
				// With a draft open, what was heard so far is still worth keeping.
				if (!this.session || !this.partial.trim()) throw e;
				raw = this.partial.trim();
			}
			if (this.state !== "thinking") return;
			if (this.changing) return await this.finishChange(raw);
			this.transcript?.complete(raw);
			const drafts = this.drafter && !this.drafter.broken;
			if (this.session || (drafts && becomesDraft({ elapsedMs, words: wordCount(raw), kind: this.drafter!.kind }))) return await this.finishDraft(raw);
			this.drafter?.stop();
			if (!raw) {
				if (this.peak < SILENT_PEAK) return this.cancel(silenceAdvice(await inputDeviceName()), "warning");
				return this.cancel("Heard sound but no words. Speak a little closer, or check /dictate status for the microphone and recogniser.", "warning");
			}
			this.partial = raw;
			this.render();
			const vocab = this.vocab ?? (await this.deps.io.vocabulary(this.c));
			const d = await distill(raw, vocab, this.c.sessionManager.getBranch() as any[], this.deps.fast, {
				draft: this.before,
				signal: this.abort.signal,
			});
			if (this.state !== "thinking") return;
			const text = d.by === "model" ? editorText(d) : this.before ? `${this.before} ${editorText(d)}` : editorText(d);
			this.state = "done";
			this.cleanup();
			const send = this.deps.io.config().afterDictation === "send" && !d.unclear.length;
			const words = raw.split(/\s+/).length;
			const secs = Math.round((this.now() - this.startedAt) / 1000);
			const t2 = this.c.ui.theme;
			this.deps.onResult({ raw, distilled: text, before: this.before });
			// A prompt keeps its transcript in memory (/dictate raw); the file was only the safety net.
			this.transcript?.delete();
			if (send) {
				this.c.ui.setEditorText("");
				this.deps.send(text, this.c.isIdle());
			} else this.c.ui.setEditorText(text);
			const how = d.by === "model" ? "distilled" : `cleaned up locally${d.error ? ` (model unavailable: ${d.error.slice(0, 80)})` : ""}`;
			this.c.ui.setWidget(WIDGET, [
				t2.fg("dim", `Dictated ${secs}s, ${words} words → ${how}${send ? " and sent" : ""}${d.unclear.length ? ` · ${d.unclear.length} unclear point${d.unclear.length > 1 ? "s" : ""} noted` : ""} · /dictate raw for the transcript · /dictate undo restores`),
			]);
		} catch (e: any) {
			if (this.state === "thinking") this.cancel(`Voice input: ${e?.message ?? e}`, "error");
		}
	}

	/** The speaker finished a draft: the last speech goes in, then one check against the whole transcript. */
	private async finishDraft(raw: string): Promise<void> {
		if (!this.session) this.becomeDraft();
		const s = this.session!;
		s.setState("checking");
		this.drafter!.heard(raw);
		await this.drafter!.settle();
		this.state = "done";
		this.cleanup();
		await s.finish(s.transcript.text() || raw);
	}

	private async finishChange(raw: string): Promise<void> {
		const rest = newSpeech(this.written, raw);
		if (rest) this.transcript?.append(rest);
		this.state = "done";
		this.cleanup();
		await this.session!.change(raw);
	}

	/** Esc with the draft open: stop listening at once, but still write the end of what was said to disk. */
	stopKeeping(): void {
		if (this.state === "done") return;
		const was = this.state;
		this.state = "done";
		this.mic?.stop();
		this.drafter?.stop();
		this.c.ui.setStatus(STATUS, undefined);
		this.cleanup();
		if (was !== "listening" || !this.listening) return;
		this.listening
			.end()
			.then((raw) => {
				if (this.changing) {
					const rest = newSpeech(this.written, raw);
					if (rest) this.transcript?.append(rest);
				} else this.transcript?.complete(raw);
			})
			.catch(() => {});
	}

	cancel(message: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.state === "done") return;
		if (this.session) {
			// A draft is never thrown away: stop listening and keep it open.
			this.stopKeeping();
			if (message) this.c.ui.notify(message, level);
			return;
		}
		this.state = "done";
		this.abort.abort();
		this.mic?.stop();
		this.listening?.cancel();
		this.drafter?.stop();
		this.c.ui.setStatus(STATUS, undefined);
		this.cleanup();
		this.c.ui.setWidget(WIDGET, undefined);
		// What was said stays on disk for a week (/dictate raw), even when the dictation was cancelled.
		if (this.partial.trim() && this.transcript) this.deps.onResult({ raw: this.partial.trim(), distilled: "", before: this.before, learned: true });
		if (message) this.c.ui.notify(message, level);
	}

	private cleanup(): void {
		clearInterval(this.timer);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.deps.onEnd(this);
	}

	private render(): void {
		if (!this.c.hasUI || this.session) return;
		const t = this.c.ui.theme;
		const { elapsedMs, warning } = this.clock();
		const secs = Math.floor(elapsedMs / 1000);
		const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
		const meter = this.levels.map((l) => BARS[Math.min(BARS.length - 1, Math.round(Math.sqrt(l) * (BARS.length - 1)))]).join("");
		const head =
			this.state === "starting"
				? `${t.fg("dim", "○")} ${t.fg("dim", "Starting the microphone…  Esc cancels")}`
				: this.state === "listening"
					? `${t.fg("error", "●")} ${t.bold("Listening")} ${t.fg("dim", clock)}${warning ? ` ${t.fg("warning", warning)}` : ""} ${t.fg("accent", meter)}  ${t.fg("dim", "Enter/alt+d finish · Esc cancel")}`
					: `${t.fg("accent", "◌")} ${t.bold("Distilling")} ${t.fg("dim", "what you meant…  Esc cancels")}`;
		const text = this.partial ? wrap(this.partial, 6).map((l) => t.fg("dim", l)) : [];
		this.c.ui.setWidget(WIDGET, [head, ...text]);
	}
}

/** The tail of the live transcript, wrapped to at most `maxLines` lines of the terminal width. */
function wrap(text: string, maxLines: number): string[] {
	const width = Math.max(20, (process.stdout.columns || 100) - 4);
	const lines: string[] = [];
	let cur = "";
	for (const w of text.split(/\s+/)) {
		if ((cur ? cur.length + 1 : 0) + w.length > width) {
			lines.push(cur);
			cur = w;
		} else cur = cur ? `${cur} ${w}` : w;
	}
	if (cur) lines.push(cur);
	return lines.length > maxLines ? ["…", ...lines.slice(-maxLines + 1)] : lines;
}
