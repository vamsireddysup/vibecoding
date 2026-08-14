# Meeting Notes (BYOK)

A Chrome extension that transcribes your meetings **on your own machine** and turns them
into a summary, decisions, and action items using **your own Claude or ChatGPT API key** —
or a local model, in which case nothing leaves your computer at all.

No subscription. No per-minute transcription fees. No server in the middle. Download the
folder, load it in Chrome, paste your key, and it is yours.

- **Transcription is free and local.** Chrome's built-in on-device speech recognition does
  the work. Audio never leaves your computer.
- **Summaries use your own credits.** Bring an Anthropic or OpenAI key and you are billed
  by them directly, at cost — typically a fraction of a cent per meeting. Or point it at
  Ollama or LM Studio and pay nothing.
- **You see the bill before you pay it.** An estimated token count and cost appear next to
  the Summarize button, before anything is sent.
- **Your data stays with you.** Transcripts live in your browser profile. Nothing is
  uploaded until you press **Summarize** or ask a question.

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

## Set up a model

Click the **⚙** in the side panel, or right-click the extension icon → Options.

**Claude** — get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
Default model is `claude-opus-5`; Sonnet and Haiku are cheaper and selectable.

**ChatGPT or anything OpenAI-compatible** — set the base URL and key. One-click presets are
provided for the common ones:

| Endpoint | Base URL | Key needed |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | Yes |
| Ollama | `http://localhost:11434/v1` | No |
| LM Studio | `http://localhost:1234/v1` | No |
| OpenRouter | `https://openrouter.ai/api/v1` | Yes |

Chrome will ask permission the first time you save a custom host. **With a local endpoint
the whole pipeline is offline** — audio, transcript, and summary all stay on the machine.
Small local models sometimes ignore the output schema; if a summary comes back unparseable,
try a larger one.

## Record a meeting

1. Open your meeting **in a browser tab**.
2. **Click the Meeting Notes icon in the toolbar while that tab is open.** This both opens
   the side panel and gives the extension permission to capture that specific tab — see
   below for why this step is not optional.
3. Press **Start recording**. Grant microphone access the first time. The panel tells you
   which tab it is about to record, and disables the button if there isn't one.
4. Talk. Transcript lines appear a few seconds behind the conversation, labelled with the
   speaker's name where the extension can identify them, otherwise **You** / **Others**.
5. Press **Stop recording**, then **Summarize with AI**.

You still hear everyone normally while recording.

<kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> starts and stops without opening the panel
at all. A keyboard shortcut counts as invoking the extension, so it records the focused tab
directly and step 2 does not apply.

### Why you have to click the toolbar icon

Chrome will not let an extension capture a tab unless the extension was **invoked on that
tab** — by an icon click, a keyboard shortcut, or a context-menu entry. The grant then
sticks to the tab until it navigates elsewhere.

A button inside the side panel does **not** count: that gesture happens in the panel's own
document, not in the page being recorded. If you see

> Extension has not been invoked for the current page (see activeTab permission)

click the toolbar icon on the meeting tab and press Start again. If the tab has navigated
to a different site since you clicked, the grant is gone and you need to click once more.

## What you get

The summary is generated as structured data, not free-form prose, so it renders the same
way every time and streams in as it is written:

- **Summary** — two or three sentences on what the meeting was about
- **Key points** — the substantive discussion
- **Decisions** — what was actually decided, empty if nothing was
- **Action items** — task, owner, and due date

Owner and due date are left blank unless the transcript actually states them. The model is
instructed not to guess, because an invented owner is worse than no owner.

Three summary styles are available — full notes, executive summary, or decisions and
actions only — plus a custom instruction box. Custom instructions are *added to* the
built-in ones rather than replacing them, so the rules that stop the model inventing owners
stay in force whatever you write.

**Ask** lets you interrogate a meeting afterwards ("what did Priya commit to?"). Answers
come only from the transcript. The transcript is cached on Anthropic between questions, so
follow-ups re-read it at roughly a tenth of the input price instead of paying full price
every time.

Export the summary or the raw transcript as Markdown, or copy either to the clipboard.

### Speaker names

Where the extension can read the participant list and active-speaker indicator from the
meeting page, transcript lines carry real names. That detection is **best effort**: it
depends on each platform's markup and will break when they reskin. When it does, lines fall
back to **Others** and you can rename any speaker from the transcript view — click the chip
and type a name. The rename applies across the whole meeting, is reversible, and is
suggested from the participant names seen on the call.

---

## How it works

```
meeting tab audio ─┐
                   ├─→ offscreen document ─→ Chrome on-device ─→ transcript ─→ your model
your microphone ───┘    (audio graph)         speech recognition   (local)      (on request)
```

MV3 splits the extension across three contexts. A service worker has no DOM, and both
`getUserMedia` and `SpeechRecognition` need one, so an offscreen document owns the audio
graph and the recognizers while the service worker owns state and network calls.

Details that are easy to get wrong, and are load-bearing here:

- **`chrome.tabCapture` mutes the tab it captures.** The captured stream is routed back to
  the speakers through an `AudioContext`, or you would go deaf for the whole meeting.
- **`SpeechRecognition` stops itself** on silence and on transient errors. A restart loop
  with backoff keeps it alive; without it, transcription dies quietly a few minutes in.
- **That restart loop re-emits words**, so each new phrase is checked against the tail of
  the previous one and the overlap dropped. Duplicated phrases in a transcript become
  duplicated points in a summary.
- **Transcript lines are stored in chunks.** Keeping them in one growing array made every
  append rewrite the whole transcript — quadratic in meeting length, and paid while the
  meeting is running. Chunking keeps the cost per line flat.
- **Prompt caching is prefix-matched**, so the transcript block sits before the varying
  question. Reversing that order would mean nothing ever cached.

Two recognizers run at once — one on the tab, one on the microphone — which is where the
**You** / **Others** split comes from, with no diarization model involved.

```
manifest.json
src/
  sw.js                  service worker: lifecycle, storage, model dispatch
  offscreen.html/.js     audio capture, speaker re-pipe, both recognizers
  capture/
    source.js            TranscriptSource interface
    chrome-speech.js     on-device recognition + restart loop
    dedupe.js            drops phrases re-emitted after a restart
  content/
    participants.js      reads participant names and who is speaking
  providers/
    provider.js          dispatch, cost estimation, Markdown rendering
    anthropic.js         Claude, with prompt caching
    openai.js            any OpenAI-compatible endpoint
    prompt.js            system prompts, styles, output schema
    partial-json.js      renders streamed JSON before it is complete
    http.js              retry on rate limits, SSE reading
  ui/                    side panel and settings
  store.js               chunked meeting persistence
  config.js              settings
test/                    runs on plain node, no dependencies
```

`TranscriptSource` is a deliberate seam. If Chrome's recognizer proves too patchy, a local
Whisper source can be added there without touching capture, storage, or summarization.

## Tests

```sh
npm test     # or: node test/run.mjs
```

No dependencies to install. Seven suites cover summary normalization, chunked storage,
provider request shape and error handling, the recognition restart loop, streaming and
retry, restart-boundary deduplication, and the partial-JSON reader — including that the
Anthropic request carries the CORS header without which no browser-side call works, and a
benchmark asserting transcript appends stay flat rather than going quadratic again.

Things that genuinely need a browser are not covered and must be checked by hand:

- Load unpacked with no errors in `chrome://extensions`
- **You can still hear the meeting while recording** (the re-pipe)
- Both **You** and **Others** lines appear
- A ~15-minute recording with silent gaps still transcribes at the end (the restart loop)
- Speaker names appear on Google Meet; the manual rename works everywhere
- A custom base URL against a local Ollama produces a summary with no key set
- Summary text appears progressively rather than after a blank wait
- A wrong API key produces a readable error
- Google Meet, Zoom Web Client, and Teams Web

## Contributing

Issues and pull requests are welcome. The most useful contributions right now are reports
of on-device speech availability on different operating systems, and fixes to the
participant selectors in `src/content/participants.js` when a platform changes its markup —
they are all in one table for exactly that reason.

## Disclaimer

Provided as-is under the MIT licence, at your own risk. **Recording a meeting may require
the consent of everyone present**, and the rules differ by country and by state. You are
responsible for knowing and following the law where you are, and for complying with the
terms of service of the meeting platform you use it on. You are also responsible for the
costs your own API key incurs.

## Licence

[MIT](LICENSE)
