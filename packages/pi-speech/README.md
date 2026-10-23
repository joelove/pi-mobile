# pi-speech

Voice for [pi](https://pi.dev): dictation in the terminal that turns what you say into the prompt you meant, voice mode in the terminal, and the computer side of hands-free voice mode used by [pi-mobile](https://github.com/jkeskikangas/pi-mobile).

```bash
pi install npm:pi-speech
```

## Dictation

Press **alt+d** (or `/dictate`), talk, then press **Enter**. Esc cancels.

What lands in the editor is the message you meant, not a transcript: corrections applied ("null, no wait, undefined" → `undefined`), fillers gone, several asks turned into a list, and spoken names matched to real ones in your repo ("get user by ID in off dot ts" → `getUserById` in `src/auth.ts`). Anything ambiguous is noted as *unclear* instead of guessed. You review it and send.

- **Edit by voice.** With text in the editor, "make that a list" or "drop the second point" edits it. Names you correct before sending are remembered.
- `/dictate raw` (verbatim), `/dictate undo`, `/dictate send` or `/dictate review` (what happens after dictation), `/dictate status`.

### Talk it through, get a draft

Keep talking. After about 30 seconds (sooner when you're describing something rather than asking for one thing), the dictation becomes a **draft**: a structured document that forms on a full screen while you talk.

- It's updated at each pause: points are added, changed or moved, and what changed glows for a moment. When you correct yourself, the later version wins and the draft says so. Asides go under *Also mentioned*, ambiguities under *Open questions*. Nothing is added that you didn't say.
- The shape follows what you say (a request, a spec, design notes, a task list, a bug report); say "make this a spec" to choose.
- Pauses don't end it. **Enter** or **alt+d** finishes (the limit is 10 minutes; the status line warns a minute before). The draft is then checked once against everything you said, and corrections glow too.
- Then refine it: **alt+d** to change it by voice ("drop the third point"), or type (↑↓ to move, only the line you're on shows its Markdown). **Enter** sends it to pi; **Esc** puts it in the editor.
- What you say is saved as you speak to `~/.pi/agent/pi-speech/drafts/`, deleted once the draft is sent or after 7 days. `/dictate raw` shows it.

## Voice mode

`/voice` (or **alt+v**; alt+shift+v on Windows and WSL) starts a spoken conversation with pi through headphones; again to stop. The status line shows what it's doing.

- **One sentence, everything else is text.** The voice says how a request went and when you're needed (pi's questions, a failed deploy or push). That sentence starts pi's answer in the transcript as a *said* line; the details are on screen and never read aloud.
- **It waits while you type** (1.5 s without a key). A question or failure plays a sound at once and is spoken at the next pause.
- **Quiet and Eyes-free:** "go quiet" (sounds only), "I can't look" (longer briefs), "normal"; or `/voice quiet|eyes-free|normal`. Remembered.
- **Speak and type one request.** "Rename it to the following" puts your words in the editor, marked; type the rest and press Enter (or say "send"). Esc keeps it as plain text. Nothing parked is ever sent by itself.
- **The voice never knows; pi knows.** Questions that need a file, a tool or current information ("what's the weather in Ireland?") go to pi; lookups get a "Checking.".
- **Interrupting the voice never stops pi.** Talk over it and it stops; "stop pi" or "cancel that" stops pi.
- **Thinking out loud becomes a draft.** Describe a feature, list requirements or reason through a design and the voice opens the same full-screen draft as long dictation (so does talking for more than about 20 seconds); it stays silent while you talk. "No, just answer that" undoes it. "That's it" (or Enter, or "yes" to "is that everything?" after a long pause) finishes it: one spoken sentence sums it up, then the voice asks the open questions one at a time and your answers edit the draft. "Send it" or Enter sends it; Esc puts it in the editor.

It uses OpenAI's realtime model (`gpt-realtime-2`) over WebRTC with your ChatGPT sign-in in pi (`/login openai-codex`) or `OPENAI_API_KEY`, `ffmpeg` for the microphone and speaker, and no native modules (WebRTC and Opus in JavaScript and wasm). Headphones assumed: there is no echo cancellation. `PI_SPEECH_PLAYER=file:<wav>` records instead of playing (tests); `PI_SPEECH_VOICE_LOG=<file>` logs the conversation's events.

## Recognition

- **macOS 26:** Apple's on-device SpeechAnalyzer. Free, private, live text while you talk. A small Swift helper compiles on first use (needs the Xcode command-line tools).
- **Anywhere else:** set `OPENAI_API_KEY` for `gpt-4o-transcribe`.
- **Local server:** set `PI_SPEECH_STT_URL` to an OpenAI-compatible base URL (for example a whisper.cpp server run with `--inference-path /audio/transcriptions`, at `http://127.0.0.1:8080`). It takes precedence over the two above; `PI_SPEECH_STT_KEY` overrides the placeholder key.
- The microphone is captured with `ffmpeg`. `PI_SPEECH_MIC` picks a device (`PI_SPEECH_FFMPEG` points at ffmpeg if it isn't on `PATH`).

The cleanup uses a fast model you already have in pi.

## Settings

`~/.pi/agent/pi-speech/config.json`: `stt` (`auto`/`apple`/`openai`), `locale` (e.g. `"fi-FI"`), `model` (`provider/id` for cleanup and spoken briefs), `afterDictation` (`review`/`send`), `reducedMotion` (`true`: changes in a draft get a margin mark instead of a fading glow), `voiceSwitch` (`normal`/`quiet`/`eyes-free`), `turnDetection` (`server`, the terminal's default, or `semantic`), `realtimeModel`, `realtimeVoice`, plus the voice-mode settings documented in pi-mobile. Settings from pi-mobile's older `"voice"` section are copied over on first run.

## With pi-mobile

pi-mobile depends on pi-speech and includes it, so you don't need both. If both are installed, dictation and voice mode are registered once.

Design and verification: [docs/voice.md](https://github.com/jkeskikangas/pi-mobile/blob/main/docs/voice.md).
