// Terminal dictation that becomes a draft, end to end with fakes (no microphone, no recogniser, no
// model): the recording forms the draft, a microphone failure keeps it, the check runs on the
// session's model, alt+d changes it by voice, Enter sends it and deletes the transcript, Esc keeps
// it as text with the words not drafted yet. Plus the OpenAI recogniser's live pieces.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { rgbColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { ALSO_NOT_DRAFTED } from "../src/draft-session.ts";
import type { DraftView } from "../src/draft-view.ts";
import { registerDictation } from "../src/dictation.ts";
import { DRAFT_SYSTEM, RECONCILE_SYSTEM } from "../src/drafting.ts";
import type { Complete } from "../src/model.ts";
import { openaiProvider, PIECE_MAX_MS, PIECE_MIN_MS } from "../src/stt.ts";

initTheme("dark", false);

const theme = {
	colors: { userMessageBg: rgbColor(40, 40, 40), accent: rgbColor(0, 160, 255) },
	getColorMode: () => "truecolor",
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
} as any;

const until = async (f: () => boolean, what: string, ms = 3000) => {
	const end = Date.now() + ms;
	while (!f()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
};

const SAID = "We need upload retries with exponential backoff. The queue should survive a restart of the app.";

/** A fake recogniser stream the test speaks into. */
function fakeLive() {
	let finals = "";
	let resolveEnd!: (t: { text: string; provider: string }) => void;
	const ended = new Promise<{ text: string; provider: string }>((r) => (resolveEnd = r));
	const live = {
		onPartial: (_t: string) => {},
		onFinal: undefined as undefined | ((s: string) => void),
		onVolatile: undefined as undefined | ((s: string) => void),
		write() {},
		end: () => {
			resolveEnd({ text: `${finals} ${live.volatile}`.trim(), provider: "fake" });
			return ended;
		},
		cancel() {},
		volatile: "",
		/** A settled segment. */
		settle(s: string) {
			finals = `${finals} ${s}`.trim();
			live.volatile = "";
			live.onFinal?.(s);
			live.onVolatile?.("");
			live.onPartial(finals);
		},
		/** Words heard after the settled ones, which may still change. */
		hear(words: string) {
			live.volatile = words;
			live.onVolatile?.(words);
			live.onPartial(`${finals} ${words}`.trim());
		},
	};
	return live;
}

function setup(opts: { fast?: Complete; check?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-speech-dictation-"));
	const clock = { t: 1_000_000 };
	const lives: ReturnType<typeof fakeLive>[] = [];
	const mics: { onError: (m: string) => void; stopped: number }[] = [];
	const log: string[] = [];
	const fast: Complete =
		opts.fast ??
		(async (system, user) => {
			if (system !== DRAFT_SYSTEM) throw new Error(`unexpected fast call: ${system.slice(0, 40)}`);
			const speech = /NEW SPEECH[^\n]*:\n([\s\S]*)$/.exec(user)![1]!;
			if (/drop the restart point/.test(speech)) {
				log.push("change");
				return JSON.stringify({ edits: [{ op: "remove", match: "survive a restart" }] });
			}
			log.push(`update: ${speech}`);
			const points = speech.split(/(?<=\.)\s+/).filter((s) => s.trim());
			return JSON.stringify({ kind: "description", edits: points.map((text) => ({ op: "add", section: "Requirements", text: text.replace(/\.$/, "") })) });
		});
	const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
	const shortcuts: Record<string, any> = {};
	const sent: { text: string; opts?: unknown }[] = [];
	const pi = {
		on: (ev: string, fn: any) => (handlers[ev] ??= []).push(fn),
		registerShortcut: (k: string, o: any) => (shortcuts[k] = o),
		registerCommand() {},
		sendUserMessage: (text: string, o?: unknown) => sent.push({ text, opts: o }),
	} as any;
	let view: DraftView | undefined;
	const ui = {
		theme,
		notes: [] as [string, string][],
		editor: "",
		editorSets: 0,
		notify(m: string, l = "info") {
			ui.notes.push([l, m]);
		},
		setWidget() {},
		setStatus() {},
		getEditorText: () => ui.editor,
		setEditorText(t: string) {
			ui.editor = t;
			ui.editorSets++;
		},
		onTerminalInput: () => () => {},
		custom(factory: any) {
			const tui = { terminal: { rows: 40, columns: 100 }, children: [], requestRender() {}, addInputListener: () => () => {} };
			view = factory(tui, theme, {}, () => {});
			return new Promise(() => {});
		},
	};
	const checks: string[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		ui,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		model: { provider: "test", id: "session-model" },
		modelRegistry: {
			streamSimple(model: any, c: any) {
				checks.push(`${model.id}: ${c.systemPrompt === RECONCILE_SYSTEM ? "check" : "other"}`);
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: opts.check ?? '{"edits": []}' }] }) };
			},
		},
	} as any;
	registerDictation(pi, fast, {
		config: () => ({ reducedMotion: true }),
		dir: () => dir,
		stt: () =>
			({
				name: "apple",
				transcribe: async () => ({ text: "", provider: "fake" }),
				live: () => {
					const l = fakeLive();
					lives.push(l);
					return l;
				},
			}) as any,
		vocabulary: async () => ({ project: "demo", files: [], recent: [], symbols: [] }) as any,
		startMic: async (_onData, onError) => {
			const m = { onError, stopped: 0 };
			mics.push(m);
			return {
				startedAt: clock.t,
				stop() {
					m.stopped++;
				},
			};
		},
		now: () => clock.t,
	});
	const altM = () => shortcuts["alt+d"].handler(ctx);
	const screen = () => (view ? view.render(100).map((l) => stripTerminalSequences(l)).join("\n") : "");
	const transcripts = () => (existsSync(join(dir, "drafts")) ? readdirSync(join(dir, "drafts")).map((f) => join(dir, "drafts", f)) : []);
	const shutdown = () => Promise.all((handlers.session_shutdown ?? []).map((h) => h({}, ctx)));
	/** Starts a dictation and talks until the draft view opens with a first update in it. */
	const formDraft = async () => {
		await altM();
		const live = lives.at(-1)!;
		live.settle(SAID);
		clock.t += 2000;
		await until(() => !!view && /Requirements/.test(screen()), "the draft view with the first update");
		return live;
	};
	return { dir, clock, lives, mics, log, sent, ui, checks, altM, screen, transcripts, shutdown, formDraft, view: () => view! };
}

test("a microphone failure keeps the draft; the check runs on the session's model; alt+d changes it; Enter sends and deletes the transcript", async () => {
	const t = setup({ check: JSON.stringify({ edits: [{ op: "add", section: "Also mentioned", text: "The app is for field workers" }] }) });
	try {
		const live = await t.formDraft();
		assert.deepEqual(t.log, [`update: ${SAID}`]);
		live.hear("and log every retry.");
		// The microphone fails: the recording ends, but everything said so far is drafted and checked.
		t.mics[0]!.onError("microphone stopped (1): device unplugged");
		await until(() => /Ready/.test(t.screen()), "ready after the check");
		assert.ok(t.ui.notes.some(([l, m]) => l === "warning" && /device unplugged/.test(m)));
		assert.equal(t.ui.editorSets, 0, "the draft stays open, nothing went to the editor");
		assert.equal(t.mics[0]!.stopped, 1);
		assert.deepEqual(t.log, [`update: ${SAID}`, "update: and log every retry."]);
		// The check ran on the session's model even though pi-mobile supplied the fast one.
		assert.deepEqual(t.checks, ["session-model: check"]);
		// A correction that came with a new section heading counts once.
		assert.match(t.screen(), /1 correction \(highlighted\)/);
		const [file] = t.transcripts();
		assert.match(readFileSync(file!, "utf8"), /survive a restart of the app\.\nand log every retry\./);

		// alt+d with the draft ready: a change by voice.
		await t.altM();
		assert.equal(t.lives.length, 2);
		t.lives[1]!.settle("drop the restart point");
		await t.altM();
		await until(() => t.log.includes("change") && /Ready/.test(t.screen()), "the change applied");
		assert.equal(t.mics[1]!.stopped, 1);
		assert.match(readFileSync(file!, "utf8"), /\(changing the draft by voice\)\ndrop the restart point\n$/);

		// Enter sends the draft to pi and deletes the transcript.
		t.view().handleInput("\r");
		assert.equal(t.sent.length, 1);
		assert.equal(
			t.sent[0]!.text,
			"## Requirements\n\n- We need upload retries with exponential backoff\n- and log every retry\n\n## Also mentioned\n\n- The app is for field workers",
		);
		assert.ok(!existsSync(file!));
	} finally {
		await t.shutdown();
	}
});

test("Esc keeps the draft as text with the words not drafted yet; the transcript stays", async () => {
	const t = setup();
	try {
		t.ui.editor = "typed before";
		const live = await t.formDraft();
		// Heard, but no update has taken it yet (no pause).
		live.hear("and the error message should say when it retries");
		t.view().handleInput("\x1b");
		assert.equal(t.mics[0]!.stopped, 1, "Esc stops the microphone");
		assert.equal(
			t.ui.editor,
			`typed before\n\n## Requirements\n\n- We need upload retries with exponential backoff\n- The queue should survive a restart of the app\n\n## ${ALSO_NOT_DRAFTED}\n\nand the error message should say when it retries`,
		);
		assert.equal(t.sent.length, 0);
		await until(() => /when it retries/.test(readFileSync(t.transcripts()[0]!, "utf8")), "the end of what was said on disk");
	} finally {
		await t.shutdown();
	}
});

test("Esc during the check keeps the words its last update was still drafting", async () => {
	let hold = false;
	const updates: string[] = [];
	const t = setup({
		fast: async (_system, user) => {
			const speech = /NEW SPEECH:\n([\s\S]*)$/.exec(user)![1]!;
			updates.push(speech);
			if (hold) await new Promise(() => {});
			return JSON.stringify({ kind: "description", edits: [{ op: "add", section: "Requirements", text: speech }] });
		},
	});
	try {
		const live = await t.formDraft();
		hold = true;
		live.hear("Also cap the backoff at a minute.");
		void t.altM(); // finish: the last update is sent and never answers
		await until(() => updates.length === 2 && /Checking/.test(t.screen()), "the last update in flight");
		t.view().handleInput("\x1b");
		assert.match(t.ui.editor, new RegExp(`## ${ALSO_NOT_DRAFTED.replace(/[()]/g, "\\$&")}\n\nAlso cap the backoff at a minute\\.$`));
	} finally {
		await t.shutdown();
	}
});

test("Esc while changing the draft by voice stops that recording", async () => {
	const t = setup();
	try {
		const live = await t.formDraft();
		void live;
		await t.altM(); // finish
		await until(() => /Ready/.test(t.screen()), "ready");
		await t.altM(); // change by voice
		await until(() => t.mics.length === 2, "the change's microphone");
		t.view().handleInput("\x1b");
		assert.equal(t.mics[1]!.stopped, 1);
		assert.match(t.ui.editor, /^## Requirements/);
	} finally {
		await t.shutdown();
	}
});

// ── the OpenAI recogniser, live ──

const RATE = 16000;
const chunk = (ms: number, amp: number) => {
	const b = Buffer.alloc((RATE * 2 * ms) / 1000);
	for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? amp : -amp, i);
	return b;
};

test("OpenAI live: about a minute at a time, cut at a pause (or the quietest moment), each piece settled as it's transcribed", async () => {
	const calls: number[] = [];
	const fakeFetch = (async (_url: string, init: any) => {
		const file = (init.body as FormData).get("file") as Blob;
		calls.push(file.size - 44);
		return new Response(JSON.stringify({ text: `Piece ${calls.length}.` }), { status: 200 });
	}) as typeof fetch;
	const live = openaiProvider("sk-test", fakeFetch).live!(RATE, ["uploadPhoto"]);
	const finals: string[] = [];
	const partials: string[] = [];
	live.onFinal = (s) => finals.push(s);
	live.onPartial = (s) => partials.push(s);
	const ms = (n: number) => (RATE * 2 * n) / 1000;
	// 55 s of speech: past the minimum, but no pause yet.
	for (let i = 0; i < 550; i++) live.write(chunk(100, 8000));
	assert.equal(calls.length, 0);
	// A pause: the piece ends there.
	for (let i = 0; i < 7; i++) live.write(chunk(100, 50));
	assert.equal(calls.length, 1);
	assert.equal(calls[0], ms(55_700));
	await until(() => finals.length === 1, "the first piece settled");
	assert.deepEqual(finals, ["Piece 1."]);
	assert.deepEqual(partials, ["Piece 1."]);
	// Talking without a pause: cut at the quietest moment of the last stretch before the maximum.
	for (let i = 0; i < PIECE_MAX_MS / 100; i++) live.write(chunk(100, i === 650 ? 2000 : 8000));
	assert.equal(calls.length, 2);
	assert.equal(calls[1], ms(65_100));
	// Near-silence isn't sent; the end transcribes the rest.
	const done = await live.end();
	assert.equal(calls.length, 3);
	assert.equal(calls[2], ms(PIECE_MAX_MS - 65_100));
	assert.equal(done.text, "Piece 1. Piece 2. Piece 3.");
	assert.deepEqual(finals, ["Piece 1.", "Piece 2.", "Piece 3."]);
	assert.ok(PIECE_MIN_MS < 60_000 && PIECE_MAX_MS > 60_000);

	// A piece that fails twice fails the end (the pieces before it were delivered).
	let n = 0;
	const failing = openaiProvider("sk-test", (async () => {
		n++;
		return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
	}) as typeof fetch).live!(RATE, []);
	failing.write(chunk(1000, 8000));
	await assert.rejects(failing.end(), /quota/);
	assert.equal(n, 2, "tried once more");
	// Silence alone is never sent.
	const quiet = openaiProvider("sk-test", (async () => assert.fail("sent silence")) as typeof fetch).live!(RATE, []);
	quiet.write(chunk(2000, 20));
	assert.equal((await quiet.end()).text, "");
});
