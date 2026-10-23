// pi-speech settings and state: ~/.pi/agent/pi-speech/ (config.json, voice-dictionary.json, bin/).
// Voice settings used to live under "voice" in pi-mobile's config; they are copied over once.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface VoiceConfig {
	/** Speech recognition on this computer: a local server via PI_SPEECH_STT_URL, Apple on-device (macOS 26+), OpenAI (OPENAI_API_KEY), or the first that works. */
	stt?: "auto" | "apple" | "openai";
	/** `provider/id` of the model that distils dictation and writes spoken briefs (default: a fast model you have). */
	model?: string;
	/** Recognition language, e.g. "en-US", "fi-FI" (default: the system language). */
	locale?: string;
	/** Voice mode: realtime speech model via your ChatGPT/Codex sign-in or OPENAI_API_KEY, or the cascaded pipeline. */
	realtime?: "auto" | "off";
	/** Realtime model and voice. */
	realtimeModel?: string;
	realtimeVoice?: string;
	/** Realtime end-of-turn detection: "semantic" (default, waits for the end of a thought) or "server" (fixed silence). */
	turnDetection?: "semantic" | "server";
	/** Basic voice mode's speech from the computer: any OpenAI-compatible /v1 base URL (e.g. Voicebox or Kokoro on this machine). */
	ttsUrl?: string;
	ttsKey?: string;
	ttsModel?: string;
	ttsVoice?: string;
	/** "off" keeps OPENAI_API_KEY from being used for speech; the phone then speaks with its own voice. */
	tts?: "auto" | "off";
	/** Terminal voice input: put the distilled text in the editor ("review", default) or send it ("send"). */
	afterDictation?: "review" | "send";
	/** Draft view: no glow-and-fade; what dictation changed gets a margin mark until the next key press. */
	reducedMotion?: boolean;
	/** Terminal voice mode (`/voice`): "quiet" (sounds only), "eyes-free" (longer spoken briefs) or "normal" (default). */
	voiceSwitch?: "normal" | "quiet" | "eyes-free";
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** "en-FI", "fi_FI.UTF-8" → "en", "fi": the language part, as speech transcription wants it. */
export function languageOf(locale: string | undefined): string | undefined {
	const l = String(locale ?? "")
		.trim()
		.split(/[-_.@]/)[0]!
		.toLowerCase();
	return /^[a-z]{2,3}$/.test(l) ? l : undefined;
}

function appleLocale(): string | undefined {
	try {
		return execFileSync("defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

/**
 * The language the developer speaks, when the config doesn't say: on macOS the system locale (the one
 * the on-device recogniser uses), elsewhere LC_ALL / LC_MESSAGES / LANG, then the runtime's locale.
 */
export function systemLanguage(env = process.env, platform = process.platform, readAppleLocale = appleLocale): string | undefined {
	if (platform === "darwin") {
		const l = languageOf(readAppleLocale());
		if (l) return l;
	}
	for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) if (v && !/^(?:C|POSIX)(?:[.@]|$)/.test(v) && languageOf(v)) return languageOf(v);
	try {
		return languageOf(Intl.DateTimeFormat().resolvedOptions().locale);
	} catch {
		return undefined;
	}
}

export function speechDir(): string {
	const dir = join(agentDir(), "pi-speech");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		migrateFromPiMobile(dir);
	}
	return dir;
}

/** One-time copy of the voice settings and learned dictionary from pi-mobile, where they lived before the split. */
export function migrateFromPiMobile(dir: string, from = join(agentDir(), "pi-mobile")): void {
	try {
		const voice = JSON.parse(readFileSync(join(from, "config.json"), "utf8")).voice;
		if (voice && typeof voice === "object" && !existsSync(join(dir, "config.json"))) writePrivate(join(dir, "config.json"), `${JSON.stringify(voice, null, 2)}\n`);
	} catch {}
	try {
		if (!existsSync(join(dir, "voice-dictionary.json"))) copyFileSync(join(from, "voice-dictionary.json"), join(dir, "voice-dictionary.json"));
	} catch {}
}

export function writePrivate(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function loadVoiceConfig(dir = speechDir()): VoiceConfig {
	try {
		return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as VoiceConfig;
	} catch {
		return {};
	}
}

export function saveVoiceConfig(config: VoiceConfig, dir = speechDir()): void {
	writePrivate(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}
