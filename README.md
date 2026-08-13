# Meeting Notes (BYOK)

A Chrome extension that transcribes your meetings **on your own machine** and turns them
into a summary, decisions, and action items using **your own Claude or ChatGPT API key**.

No subscription. No per-minute transcription fees. No server in the middle. Download the
folder, load it in Chrome, paste your key, and it is yours.

- **Transcription is free and local.** Chrome's built-in on-device speech recognition does
  the work. Audio never leaves your computer.
- **Summaries use your own credits.** You bring an Anthropic or OpenAI key and are billed
  by them directly, at cost. Typically a fraction of a cent per meeting.
- **Your data stays with you.** Transcripts live in your browser profile. Nothing is
  uploaded until you press **Summarize**, and then only the transcript text, only to the
  provider you picked.

---

## Read this before installing

Three limits are worth knowing up front, because they are real and no amount of code will
remove them.

**1. Zoom and Teams desktop apps will not work.** A Chrome extension can only see what
happens inside a browser tab. It cannot reach another application's audio. Supported:

| Platform | Works? |
|---|---|
| Google Meet | Yes |
| Zoom — **Web Client** (`app.zoom.us` in a tab) | Yes |
| Zoom — desktop app | **No** |
| Microsoft Teams — **web** (`teams.microsoft.com` in a tab) | Yes |
| Teams — desktop app | **No** |
| Any other meeting or video that plays in a tab | Yes |

To use it with Zoom or Teams, choose "join from browser" instead of opening the app.

**2. On-device speech recognition is not available on every machine.** It needs a Chrome
language pack, and it is currently unreliable on macOS
([Chromium issue 444393111](https://issues.chromium.org/issues/444393111)). Before your
first real meeting, open **Settings → Check on-device support**. If it reports a problem
you will get a clear explanation rather than a silently empty transcript.

**3. Your API key is stored unencrypted.** It lives in `chrome.storage.local`, because
Chrome gives extensions no secret store. Anyone with access to your computer profile could
read it. Use a key you can revoke, and revoke it if the machine is shared or lost.

---

## Install

No build step and no dependencies. The folder you download is the extension.

1. Download this repository (**Code → Download ZIP**, then unzip) or `git clone` it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the extension, then click its icon to open the side panel.

Requires Chrome 139 or later — earlier builds lack on-device speech recognition.

## Set up your API key

Click the **⚙** in the side panel, or right-click the extension icon → Options.

- **Claude** — get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
  Default model is `claude-opus-5`; Sonnet and Haiku are cheaper and selectable.
- **ChatGPT** — get a key at [platform.openai.com](https://platform.openai.com/api-keys).
  The model is a free-text field so you can set whatever your account has access to.

You only need one. Set the provider you want to use and press **Save**.

## Record a meeting

1. Open your meeting **in a browser tab**.
2. Click the extension icon to open the side panel.
3. Press **Start recording**. Grant microphone access the first time.
4. Talk. Transcript lines appear a few seconds behind the conversation, tagged **You**
   (your microphone) or **Others** (the meeting tab).
5. Press **Stop recording**, then **Summarize with AI**.

You still hear everyone normally while recording.

## What you get

The summary is generated as structured data, not free-form prose, so it renders the same
way every time:

- **Summary** — two or three sentences on what the meeting was about
- **Key points** — the substantive discussion
- **Decisions** — what was actually decided, empty if nothing was
- **Action items** — task, owner, and due date

Owner and due date are left blank unless the transcript actually states them. The model is
instructed not to guess, because an invented owner is worse than no owner.

Export either the summary or the raw transcript as Markdown, or copy it to the clipboard.

---

## How it works

```
meeting tab audio ─┐
                   ├─→ offscreen document ─→ Chrome on-device ─→ transcript ─→ your LLM key
your microphone ───┘    (audio graph)         speech recognition   (local)      (on request)
```

MV3 splits the extension across three contexts. A service worker has no DOM, and both
`getUserMedia` and `SpeechRecognition` need one, so an offscreen document owns the audio
graph and the recognizers while the service worker owns state and network calls.

Two details are easy to get wrong and worth calling out:

- **`chrome.tabCapture` mutes the tab it captures.** The captured stream is routed back to
  the speakers through an `AudioContext`, or you would go deaf for the whole meeting.
- **`SpeechRecognition` stops itself** on silence and on transient errors. A restart loop
  with backoff keeps it alive; without it, transcription dies quietly a few minutes in.

Two recognizers run at once — one on the tab, one on the microphone — which is where the
**You** / **Others** labels come from, with no diarization model involved.

```
manifest.json
src/
  sw.js                  service worker: lifecycle, storage, LLM dispatch
  offscreen.html/.js     audio capture, speaker re-pipe, both recognizers
  capture/
    source.js            TranscriptSource interface
    chrome-speech.js     on-device recognition + restart loop
  providers/
    provider.js          dispatch + Markdown rendering
    anthropic.js         Claude
    openai.js            ChatGPT
    prompt.js            shared system prompt and output schema
  ui/                    side panel and settings
  store.js               meeting persistence
  config.js              settings
test/                    runs on plain node, no dependencies
```

`TranscriptSource` is a deliberate seam. If Chrome's recognizer proves too patchy, a local
Whisper source can be added there without touching capture, storage, or summarization.

## Tests

```sh
npm test     # or: node test/run.mjs
```

No dependencies to install. The suites cover summary normalization, storage, provider
request shape and error handling, and the recognition restart loop — including that the
Anthropic request carries the CORS header without which no browser-side call works.

Things that genuinely need a browser are not covered and must be checked by hand:

- Load unpacked with no errors in `chrome://extensions`
- **You can still hear the meeting while recording** (the re-pipe)
- Both **You** and **Others** lines appear
- A ~15-minute recording with silent gaps still transcribes at the end (the restart loop)
- A wrong API key produces a readable error
- Google Meet, Zoom Web Client, and Teams Web

## Contributing

Issues and pull requests are welcome. The most useful contributions right now are reports
of on-device speech availability on different operating systems, and DOM/behaviour fixes
for meeting platforms other than Google Meet.

## Disclaimer

Provided as-is under the MIT licence, at your own risk. **Recording a meeting may require
the consent of everyone present**, and the rules differ by country and by state. You are
responsible for knowing and following the law where you are, and for complying with the
terms of service of the meeting platform you use it on. You are also responsible for the
costs your own API key incurs.

## Licence

[MIT](LICENSE)
