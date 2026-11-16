# BUILD-NOTES.md — Nano Notes

What was verified, what works, what was tested, and what is still open.
Written 2026-11-16, during the build.

## 1. API verification (done before writing any code)

### Firebase AI Logic — hybrid on-device inference on web: REAL, documented

- Official docs (crawled 2026-11-16, fresh):
  `https://firebase.google.com/docs/ai-logic/hybrid-on-device-inference`
- On-device inference is supported for web apps using **Firebase AI Logic SDK
  v12.5.0+** running on **Chrome on Desktop v139+**. On-device uses Chrome's
  Prompt API; cloud uses the Gemini Developer API or Vertex AI Gemini API.
- Modes: `PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `PREFER_IN_CLOUD`,
  `ONLY_IN_CLOUD`. On-device = single-turn text generation (text-only or
  text+image JPEG/PNG), streaming or not, structured output supported.
  Not supported on-device: chat, tools/function calling, audio/video/PDF
  input, image generation — all fall back to cloud instead.
- `initializeDeviceModel()` **must** be called on a user gesture, before
  `generateContent()`.

### SDK version pin — why 13.3.0, not 12.5.0

- The docs say "v12.5.0+", but I checked the actual shipped types:
  - `firebase@12.5.0` → `@firebase/ai@2.5.0`: `HybridParams` and
    `InferenceMode` exist, but **`initializeDeviceModel` does NOT exist**
    in the types, and the 12.5.0 CDN bundle (`firebase-ai.js`) does not
    contain the string at all (while `generateContent` appears 16× — so
    public names are not mangled; the method is genuinely absent).
  - `firebase@13.3.0` → `@firebase/ai@3.1.0`: `initializeDeviceModel(
    onDownloadProgress?: (progressValue: number) => void): Promise<void>`
    **exists** in the types.
- Conclusion: the docs describe the current SDK. The app pins
  **firebase 13.3.0** (latest stable on npm, verified 2026-11-16) via CDN.
  All three CDN files return HTTP 200:
  `firebase-app.js`, `firebase-ai.js`, `firebase-app-check.js`.

### Exact API used (all verified in @firebase/ai 3.1.0 types)

```js
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";
const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  inCloudParams: { model: 'gemini-2.5-flash' }, // cloud model is explicit
});
await model.initializeDeviceModel((progress) => /* 0..1 */);
const result = await model.generateContentStream(prompt);
for await (const chunk of result.stream) { chunk.text(); }
const finalResponse = await result.response;
finalResponse.inferenceSource; // "on_device" | "in_cloud"
```

- `HybridParams` shape: `{ mode, onDeviceParams?, inCloudParams?: ModelParams }`.
  The cloud model is specified inside `inCloudParams` — confirmed in the
  types and in Firebase's own configuration docs ("you need to explicitly
  specify a cloud model to use when you create the generativeModel
  instance").
- `InferenceSource` enum values are `"on_device"` / `"in_cloud"`.

### Chrome Prompt API — stable on the web

- `LanguageModel` (not the old `window.ai`): `LanguageModel.availability()`
  → `'available' | 'downloadable' | 'downloading' | 'unavailable'`,
  `LanguageModel.create({ monitor })`, `session.prompt()` /
  `session.promptStreaming()`.
- Stable for extensions since Chrome 138, **on the web since Chrome 148**
  (released 5 May 2026). Summarizer API stable since Chrome 138.
- Hardware gate: desktop Chrome, 22 GB free disk, 4 GB+ VRAM GPU
  (or 16 GB RAM + 4-core CPU fallback). Gemini Nano is downloaded once by
  Chrome and shared across origins. Languages: en, ja, es, de, fr (149+).

### Quota — NO Sprint Google Account Quota request needed

- The app's cloud model is `gemini-2.5-flash`, a standard model on the
  Gemini Developer API free tier. The Sprint quota windows (Nov 18 / Nov 25,
  10 AM PT) are for **advanced** models. This app does not use any.
  **Flagged and resolved on 2026-11-16: no quota request required.**

## 2. What works (in the app as built)

- Notes CRUD + autosave + search, fully offline (IndexedDB).
- Summarize / key-points routing ladder: Firebase hybrid → direct Prompt API
  → extractive fallback, with the engine badge always reflecting reality.
- Long-document routing: est. > 6,000 tokens (~24,000 chars) prefers cloud.
  The threshold is a heuristic (Nano's context is small; the exact
  `inputQuota` is checked at runtime on the direct Prompt API path).
- Streaming output for both AI paths; progress bar for the model download.
- Firebase loads only when `firebase-config.js` exists; otherwise the app
  never touches the network for AI (on-device Prompt API needs no network).
- No secrets in the repo: `firebase-config.js` is gitignored; only the
  `.example.js` template is committed.

## 3. What was tested (this VM, 2026-11-16)

- **Node unit checks** (`../test/test-ai-unit.mjs`): **11/11 passed** —
  extractive summarizer/key-points computed from input text (not canned),
  token estimator, source labels (extractive honestly flagged non-AI).
- **Headless Chromium E2E** (`../test/test-app.mjs`, Playwright,
  Chromium 159 headless): **14/14 checks passed** — app loads with no page
  errors (the only console 404s are the expected favicon + absent
  `firebase-config.js`); 3 sample notes seed; select/edit/autosave
  (debounced) work; search filters; delete works; Summarize on the long
  sample note returns a 332-char summary derived from the note with the
  honest badge **"Extractive — no AI model available"**; Key points returns
  a bullet list; engine line correctly reports
  "Chrome 159 · Gemini Nano unavailable on this device · Firebase not
  configured". Screenshot: `../test/screenshot.png` (UI renders cleanly).
- **Syntax**: `node --check` passes on `ai.js` and `app.js`; all files
  serve HTTP 200 from a static server; `firebase-config.js` correctly 404s
  (gitignored, does not exist yet).

## 4. What was NOT tested (cannot be tested in this VM)

- **Real Gemini Nano summarization** — this VM has no desktop Chrome with
  the Nano model downloaded (headless Chromium does not ship it). The
  Firebase hybrid path and the direct Prompt API path are implemented
  exactly per the verified docs/SDK types, but the first live run must
  happen in real Chrome 139+ on a desktop. Expected first-run behaviour:
  click Summarize → download progress → on-device summary with the green
  badge.
- **Firebase cloud fallback** — no Firebase project exists yet (Ezra's
  Google sign-in). The code path is implemented per the verified SDK types;
  the first live call needs a real `firebase-config.js`.

## 5. Still needs Ezra (his sign-ins only — nothing here can do them)

1. **Firebase project** (free, his Google account): console → AI Services →
   AI Logic → Get started → Gemini Developer API; register a Web app; copy
   `firebase-config.example.js` → `firebase-config.js` with the real values.
   If App Check enforcement is on, add the site key / debug token (README).
2. **GitHub (or GitLab) account** (free): create the public repo, push this
   `app/` folder, keep the MIT LICENSE file.
3. **Devpost account** (free): register and submit by **Dec 1, 2026 05:00 WIB**.
4. **Demo video ≤ 3 min on YouTube** (English or English subtitles) — record
   at the end, in real Chrome: create a note → Summarize (show the on-device
   badge) → paste a long note → Summarize (show the cloud badge) → show the
   offline behaviour.
5. **First live verification in real Chrome**: open the app, confirm the
   engine badge says "On-device · Gemini Nano" on a short note.

## 6. Design decisions worth knowing

- **Why not the Summarizer API?** Chrome's dedicated Summarizer API
  (stable since 138) would also work, but the hackathon requires Firebase
  AI Logic, and the hybrid SDK already routes to Nano internally. Using the
  Firebase hybrid model as the primary path keeps one AI layer and one
  badge source of truth.
- **Why an extractive fallback at all?** So the app is demonstrably useful
  on any machine (judges may open it in a browser without Nano and without
  Firebase). It is a real algorithm computed from the note text, and the UI
  never calls it AI.
- **Why vanilla JS, no build step?** One less thing to break in review and
  in the demo; the app runs from any static server.
