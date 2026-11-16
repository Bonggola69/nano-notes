// ai.js — Hybrid AI engine for Nano Notes.
//
// Routing ladder for every summary / key-points request:
//   1. Firebase AI Logic (hybrid) — PREFER_ON_DEVICE with a cloud fallback
//      (Gemini Developer API backend, cloud model gemini-2.5-flash).
//      On-device runs on Gemini Nano via Chrome's Prompt API; the response's
//      `inferenceSource` tells us which side actually served the request.
//      Long documents (est. > LONG_DOC_TOKEN_BUDGET tokens) are routed to the
//      cloud first, because on-device context is small.
//   2. Direct Chrome Prompt API (LanguageModel) — on-device only, used when
//      no Firebase config is present but the browser has Gemini Nano.
//   3. Extractive fallback — a deterministic, clearly-labelled sentence
//      extractor. This is NOT AI and the UI always says so. It exists so the
//      app still does something useful on a device with no model and no
//      Firebase project, instead of failing or faking an AI answer.
//
// Verified against the official docs + SDK types on 2026-11-16 (see
// BUILD-NOTES.md): Firebase JS SDK 13.3.0 / @firebase/ai 3.1.0, Chrome
// Prompt API stable on the web since Chrome 148.

export const FIREBASE_SDK_VERSION = '13.3.0';
export const CLOUD_MODEL = 'gemini-2.5-flash';

// Heuristic: ~4 chars per token. Above this, prefer the cloud model.
export const LONG_DOC_TOKEN_BUDGET = 6000;

export const SOURCES = {
  ON_DEVICE: 'on_device', // Firebase hybrid served on-device (Gemini Nano)
  IN_CLOUD: 'in_cloud', // Firebase hybrid served in cloud (Gemini 2.5 Flash)
  PROMPT_API: 'on_device_prompt_api', // Direct LanguageModel Prompt API
  EXTRACTIVE: 'extractive', // Deterministic extractor, NOT AI
};

export function sourceLabel(source) {
  switch (source) {
    case SOURCES.ON_DEVICE:
      return { text: 'On-device · Gemini Nano', cls: 'badge-device', ai: true };
    case SOURCES.IN_CLOUD:
      return { text: 'Cloud · Gemini 2.5 Flash', cls: 'badge-cloud', ai: true };
    case SOURCES.PROMPT_API:
      return { text: 'On-device · Gemini Nano (Prompt API)', cls: 'badge-device', ai: true };
    case SOURCES.EXTRACTIVE:
      return { text: 'Extractive — no AI model available', cls: 'badge-extractive', ai: false };
    default:
      return { text: 'AI summary', cls: 'badge-cloud', ai: true };
  }
}

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ---------------------------------------------------------------------------
// Extractive fallback (deterministic, honest — never presented as AI output)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  ('a an the and or but if then else for of to in on at by with from as is are was were be been being ' +
    'it its this that these those i you he she we they them his her their our your my me him us ' +
    'do does did done have has had will would can could should may might must not no yes so very ' +
    'just also than then when where which who whom what how why all any both each few more most ' +
    'other some such only own same too under over into out up down off about between through after ' +
    'before during without within dan yang di ke dari untuk dengan pada adalah ini itu yang').split(' ')
);

function splitSentences(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function scoreSentences(sentences) {
  const freq = new Map();
  for (const s of sentences) {
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)) {
      if (w.length > 3 && !STOPWORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return sentences.map((s, i) => {
    let score = 0;
    for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)) {
      if (w.length > 3 && !STOPWORDS.has(w)) score += freq.get(w) || 0;
    }
    // Slight preference for earlier sentences; penalise very long ones.
    score = score / Math.sqrt(s.split(/\s+/).length) + (sentences.length - i) * 0.01;
    return { s, i, score };
  });
}

export function extractiveSummary(text, maxSentences = 3) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return 'Not enough text to summarize.';
  if (sentences.length <= maxSentences) return sentences.join(' ');
  return scoreSentences(sentences)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(' ');
}

export function extractiveKeyPoints(text, maxPoints = 5) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return ['Not enough text to extract key points.'];
  if (sentences.length <= maxPoints) return sentences;
  return scoreSentences(sentences)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPoints)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export async function promptApiStatus() {
  if (typeof LanguageModel === 'undefined') return 'unsupported';
  try {
    const status = await LanguageModel.availability();
    return status; // 'available' | 'downloadable' | 'downloading' | 'unavailable'
  } catch {
    return 'unavailable';
  }
}

export function chromeVersion() {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Hybrid AI service
// ---------------------------------------------------------------------------

const SUMMARIZE_PROMPT =
  'Summarize the following note in 3-5 short bullet points, in the same language as the note. ' +
  'Keep only the essential information. No preamble, no title, just the bullet points.\n\nNOTE:\n';

const KEYPOINTS_PROMPT =
  'List the 5 most important points from the following note as a short bullet list, ' +
  'in the same language as the note. No preamble, just the bullet points.\n\nNOTE:\n';

export class HybridAI {
  constructor() {
    this.firebaseReady = false;
    this.firebaseError = null;
    this.deviceModel = null; // PREFER_ON_DEVICE instance
    this.cloudModel = null; // PREFER_IN_CLOUD instance
    this.deviceInitDone = false;
    this.cloudModelName = CLOUD_MODEL;
  }

  // Loads ./firebase-config.js (gitignored) if present, then dynamically
  // imports the Firebase SDK from the CDN. Never throws: on any failure the
  // service simply reports firebaseReady === false and the ladder falls
  // through to the on-device Prompt API / extractive fallback.
  async init() {
    let config = null;
    try {
      const mod = await import('./firebase-config.js');
      config = mod.firebaseConfig || null;
      if (mod.firebaseOptions?.cloudModel) this.cloudModelName = mod.firebaseOptions.cloudModel;
      this._firebaseOptions = mod.firebaseOptions || {};
    } catch {
      return { firebaseReady: false, reason: 'no-config' };
    }
    if (!config || !config.apiKey || String(config.apiKey).includes('YOUR_')) {
      return { firebaseReady: false, reason: 'no-config' };
    }
    try {
      const [{ initializeApp }, aiMod] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-ai.js`),
      ]);
      this._aiMod = aiMod;
      const app = initializeApp(config);

      // App Check is optional: only initialised when a site key is provided.
      // On localhost with appCheckDebug, the debug provider is enabled first
      // (requires the debug token to be registered in the Firebase console).
      const opts = this._firebaseOptions;
      if (opts.appCheckSiteKey) {
        try {
          const isLocal =
            location.hostname === 'localhost' || location.hostname === '127.0.0.1';
          if (isLocal && opts.appCheckDebug) {
            self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
          }
          const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import(
            `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-check.js`
          );
          initializeAppCheck(app, {
            provider: new ReCaptchaEnterpriseProvider(opts.appCheckSiteKey),
            isTokenAutoRefreshEnabled: true,
          });
        } catch (e) {
          console.warn('App Check init failed (continuing without it):', e);
        }
      }

      const ai = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
      this.deviceModel = aiMod.getGenerativeModel(ai, {
        mode: aiMod.InferenceMode.PREFER_ON_DEVICE,
        inCloudParams: { model: this.cloudModelName },
      });
      this.cloudModel = aiMod.getGenerativeModel(ai, {
        mode: aiMod.InferenceMode.PREFER_IN_CLOUD,
        inCloudParams: { model: this.cloudModelName },
      });
      this.firebaseReady = true;
      return { firebaseReady: true, reason: 'ok' };
    } catch (e) {
      this.firebaseError = e;
      console.warn('Firebase AI Logic init failed:', e);
      return { firebaseReady: false, reason: 'init-error', error: e };
    }
  }

  // Must be called on a user gesture (button click) before on-device use.
  async ensureDeviceModelInitialized(onProgress) {
    if (this.deviceInitDone || !this.deviceModel) return;
    try {
      await this.deviceModel.initializeDeviceModel(onProgress);
    } catch (e) {
      // Not fatal: PREFER_ON_DEVICE falls back to cloud on generateContent.
      console.warn('initializeDeviceModel failed (will fall back):', e);
    }
    this.deviceInitDone = true;
  }

  async _firebaseGenerate(model, prompt, onToken) {
    const result = await model.generateContentStream(prompt);
    let text = '';
    for await (const chunk of result.stream) {
      const t = chunk.text();
      if (t) {
        text += t;
        onToken?.(text);
      }
    }
    const finalResponse = await result.response;
    const source = finalResponse.inferenceSource === 'on_device' ? SOURCES.ON_DEVICE : SOURCES.IN_CLOUD;
    return { text: text.trim(), source };
  }

  async _promptApiGenerate(prompt, onToken, onProgress) {
    const status = await promptApiStatus();
    if (status === 'unsupported' || status === 'unavailable') {
      throw new Error('Prompt API unavailable: ' + status);
    }
    const session = await LanguageModel.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
      },
    });
    try {
      const tokens = estimateTokens(prompt);
      if (session.inputQuota && tokens > session.inputQuota) {
        throw new Error(`Prompt exceeds on-device input quota (${session.inputQuota} tokens)`);
      }
      let text = '';
      if (typeof session.promptStreaming === 'function') {
        const stream = session.promptStreaming(prompt);
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += value;
          onToken?.(text);
        }
      } else {
        text = await session.prompt(prompt);
        onToken?.(text);
      }
      return { text: text.trim(), source: SOURCES.PROMPT_API };
    } finally {
      try {
        session.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  // Main entry point. callbacks: { onProgress(frac), onToken(text), onRoute(info) }
  async summarize(text, callbacks = {}) {
    return this._run(text, SUMMARIZE_PROMPT, false, callbacks);
  }

  async keyPoints(text, callbacks = {}) {
    return this._run(text, KEYPOINTS_PROMPT, true, callbacks);
  }

  async _run(text, promptPrefix, asBullets, callbacks = {}) {
    const tokens = estimateTokens(text);
    const longDoc = tokens > LONG_DOC_TOKEN_BUDGET;
    const prompt = promptPrefix + text;

    // Rung 1 — Firebase AI Logic hybrid.
    if (this.firebaseReady) {
      try {
        const model = longDoc ? this.cloudModel : this.deviceModel;
        if (!longDoc) await this.ensureDeviceModelInitialized(callbacks.onProgress);
        callbacks.onRoute?.({ rung: 'firebase', longDoc, tokens });
        const out = await this._firebaseGenerate(model, prompt, callbacks.onToken);
        return { ...out, tokens, longDoc, bullets: asBullets };
      } catch (e) {
        console.warn('Firebase hybrid path failed, falling through:', e);
        callbacks.onRoute?.({ rung: 'firebase-failed', error: String(e), longDoc, tokens });
      }
    }

    // Rung 2 — direct Chrome Prompt API (on-device), short docs only.
    if (!longDoc) {
      try {
        callbacks.onRoute?.({ rung: 'prompt-api', longDoc, tokens });
        const out = await this._promptApiGenerate(prompt, callbacks.onToken, callbacks.onProgress);
        return { ...out, tokens, longDoc, bullets: asBullets };
      } catch (e) {
        console.warn('Prompt API path failed, falling through:', e);
        callbacks.onRoute?.({ rung: 'prompt-api-failed', error: String(e), longDoc, tokens });
      }
    }

    // Rung 3 — extractive fallback. Honest label, never presented as AI.
    callbacks.onRoute?.({ rung: 'extractive', longDoc, tokens });
    const out = asBullets
      ? extractiveKeyPoints(text).map((s) => '• ' + s).join('\n')
      : extractiveSummary(text);
    callbacks.onToken?.(out);
    return { text: out, source: SOURCES.EXTRACTIVE, tokens, longDoc, bullets: asBullets };
  }
}
