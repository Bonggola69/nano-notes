# Nano Notes — #BuildHybridAI 2026 entry

An **offline-first notes app** for Chrome where every summary is produced by
**hybrid AI**: on-device with **Gemini Nano** when possible, cloud with
**Gemini 2.5 Flash** when the document is long or the device model is
unavailable — all through **Firebase AI Logic**, with the engine that served
each answer shown honestly next to it.

Built for [#BuildHybridAI 2026](https://firebasehybridaihackathon.devpost.com/)
(Google & Firebase, Devpost). Solo entry, single platform (Web / Chrome).

## What it does

- **Notes, fully offline** — create, edit, delete; stored in IndexedDB in the
  browser. No account, no server, no sync. Autosaves as you type.
- **One-tap Summarize** — 3–5 bullet summary of the open note.
- **Key points** — the 5 most important points as a bullet list.
- **Search** across all notes, live as you type.
- **Honest engine badge** — every AI result is labelled with the engine that
  produced it: `On-device · Gemini Nano`, `Cloud · Gemini 2.5 Flash`, or
  `Extractive — no AI model available`.
- **Sample notes** seeded on first run (deletable) so the demo works instantly.

## How the hybrid flow works

```
Summarize pressed
  │
  ├─ Firebase AI Logic configured?
  │    ├─ YES → hybrid model, PREFER_ON_DEVICE
  │    │         ├─ short note → on-device Gemini Nano (download starts on
  │    │         │   first use, with a progress bar)
  │    │         └─ long note (> ~6,000 tokens ≈ 24,000 chars) → cloud
  │    │             Gemini 2.5 Flash
  │    └─ NO  → Chrome Prompt API (LanguageModel) directly, on-device
  │
  └─ No model available at all?
       └─ Extractive fallback: a deterministic sentence extractor,
          clearly labelled "not AI". Never faked, never canned text.
```

The response's `inferenceSource` (`on_device` / `in_cloud`) is read from the
Firebase SDK itself, so the badge always reflects what really happened.

## Run it

No build step. Serve the folder over HTTP (modules + dynamic imports need
`http://`, not `file://`):

```bash
cd app
python3 -m http.server 8080
# open http://localhost:8080
```

Or any static server (`npx serve`, `npx http-server`, VS Code Live Server…).

### Requirements for the on-device path

- **Chrome 139+ on desktop** (Windows 10/11, macOS 13+, Linux, Chromebook
  Plus). The Prompt API is stable on the web since Chrome 148.
- **Gemini Nano downloaded once by Chrome** (~22 GB free disk, 4 GB+ VRAM
  GPU or 16 GB RAM fallback). The app starts the download on first use and
  shows progress; you can pre-download it from DevTools with
  `await LanguageModel.create()`.
- Optional flag for multimodal input (not needed for text notes):
  `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`.

## Add the cloud fallback (Firebase)

Without this the app still works (on-device + extractive). To enable the
cloud model:

1. Create a Firebase project in the
   [Firebase console](https://console.firebase.google.com) (your Google
   sign-in).
2. Go to **AI Services → AI Logic → Get started** and choose the
   **Gemini Developer API** backend (free tier; no billing needed).
3. Register a Web app (**Project settings → Your apps → Web**) and copy the
   config object.
4. Copy `firebase-config.example.js` to `firebase-config.js` and paste your
   values. The file is gitignored — never commit it.

**App Check note:** the AI Logic guided setup enforces App Check. If your
project enforces it, add your reCAPTCHA Enterprise site key to
`firebase-config.js` (`appCheckSiteKey`). For localhost development, set
`appCheckDebug: true` and register the debug token printed in the browser
console under **Firebase console → Security → App Check → Apps → Manage
debug tokens**. If App Check is not enforced, leave both unset.

## Project layout

```
app/
├── index.html                  App shell
├── styles.css                  UI
├── app.js                      Notes store (IndexedDB) + UI controller
├── ai.js                       Hybrid AI engine (Firebase / Prompt API / extractive)
├── firebase-config.example.js  Template — copy to firebase-config.js (gitignored)
├── README.md                   This file
├── BUILD-NOTES.md              What was verified, what was tested, what is still open
└── LICENSE                     MIT
```

## Known limits (honest)

- On-device AI is **Chrome desktop only**; other browsers get the cloud or
  extractive path.
- The on-device model needs its **first download** (~minutes, once); the app
  shows progress and falls back to cloud meanwhile only if Firebase is
  configured.
- On-device inference is **single-turn text only** (no chat, no tools) — that
  is all this app needs.
- The cloud model is `gemini-2.5-flash`, a standard model. No Sprint Google
  Account Quota request is needed for this app.

## License

MIT — see [LICENSE](LICENSE).
