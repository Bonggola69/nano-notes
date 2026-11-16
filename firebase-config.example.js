// firebase-config.example.js — COPY this file to `firebase-config.js` and fill
// in your own values. `firebase-config.js` is gitignored: never commit real keys.
//
// How to get these values:
//   1. Go to the Firebase console (https://console.firebase.google.com) and
//      create a project (your Google sign-in).
//   2. In the console, go to AI Services > AI Logic and click "Get started"
//      (this sets up the Gemini Developer API backend and enforces App Check).
//   3. Register a Web app: Project settings > Your apps > Add app > Web.
//      The config object shown there goes below.
//
// Without this file the app still works: on-device summarization uses the
// Chrome Prompt API directly, and anything else falls back to the clearly
// labelled extractive summarizer. The cloud fallback is what this file adds.

export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

export const firebaseOptions = {
  // Cloud model used when the on-device model is unavailable or the
  // document is long. gemini-2.5-flash is a standard model — it does NOT
  // need the Sprint Google Account Quota (that is only for advanced models).
  cloudModel: 'gemini-2.5-flash',

  // Optional: reCAPTCHA Enterprise site key, only if your Firebase project
  // enforces App Check (the AI Logic guided setup turns enforcement on).
  // Without it, cloud calls are rejected once enforcement is enabled.
  // appCheckSiteKey: 'YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY',

  // Set to true while developing on localhost IF App Check is enforced:
  // the app then uses the App Check debug provider. Register the debug
  // token printed in the browser console under
  // Firebase console > Security > App Check > Apps > Manage debug tokens.
  appCheckDebug: false,
};
