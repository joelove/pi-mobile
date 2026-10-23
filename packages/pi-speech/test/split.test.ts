// pi-speech as its own extension: settings moved out of pi-mobile, and one dictation owner per pi.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadVoiceConfig, migrateFromPiMobile, saveVoiceConfig } from "../src/config.ts";
import { registerDictation } from "../src/dictation.ts";

test("voice settings and the learned dictionary are copied once from pi-mobile", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-speech-"));
	const from = join(root, "pi-mobile");
	const dir = join(root, "pi-speech");
	mkdirSync(from);
	mkdirSync(dir);
	writeFileSync(join(from, "config.json"), JSON.stringify({ port: 7878, voice: { locale: "fi-FI", afterDictation: "send" } }));
	writeFileSync(join(from, "voice-dictionary.json"), '{"get user":"fetchUser"}');
	migrateFromPiMobile(dir, from);
	assert.deepEqual(loadVoiceConfig(dir), { locale: "fi-FI", afterDictation: "send" });
	assert.equal(readFileSync(join(dir, "voice-dictionary.json"), "utf8"), '{"get user":"fetchUser"}');
	// Settings changed in pi-speech are never overwritten by the old ones.
	saveVoiceConfig({ locale: "en-US" }, dir);
	migrateFromPiMobile(dir, from);
	assert.deepEqual(loadVoiceConfig(dir), { locale: "en-US" });
});

test("no pi-mobile settings: nothing to copy", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-speech-"));
	migrateFromPiMobile(root, join(root, "missing"));
	assert.deepEqual(loadVoiceConfig(root), {});
});

function fakePi() {
	const commands: string[] = [];
	const shortcuts: string[] = [];
	const handlers = new Map<string, ((...a: any[]) => any)[]>();
	const pi: any = {
		registerCommand: (name: string) => commands.push(name),
		registerShortcut: (key: string) => shortcuts.push(key),
		on: (event: string, h: (...a: any[]) => any) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		sendUserMessage: () => {},
	};
	const emit = async (event: string) => {
		for (const h of handlers.get(event) ?? []) await h({}, {});
	};
	return { pi, commands, shortcuts, emit };
}

test("dictation is registered once when both pi-mobile and pi-speech load, and again after a reload", async () => {
	const a = fakePi();
	const b = fakePi();
	registerDictation(a.pi);
	registerDictation(b.pi);
	assert.deepEqual(a.commands, ["dictate"]);
	assert.deepEqual(a.shortcuts, ["alt+d"]);
	assert.deepEqual(b.commands, []);
	assert.deepEqual(b.shortcuts, []);
	// A reload shuts the old runtime down, then loads the extensions again.
	await a.emit("session_shutdown");
	const c = fakePi();
	registerDictation(c.pi);
	assert.deepEqual(c.commands, ["dictate"]);
	await c.emit("session_shutdown");
});
