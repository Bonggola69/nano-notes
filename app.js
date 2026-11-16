// app.js — Nano Notes UI controller + offline notes store (IndexedDB).
import { HybridAI, promptApiStatus, chromeVersion, estimateTokens, sourceLabel, SOURCES } from './ai.js';

const $ = (sel) => document.querySelector(sel);
const DB_NAME = 'nano-notes';
const DB_VERSION = 1;
const STORE = 'notes';
const SAMPLE_FLAG = 'nano-notes-seeded-v1';

// ---------------------------------------------------------------------------
// IndexedDB store
// ---------------------------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const request = fn(store.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const store = {
  async all() {
    const db = await openDB();
    return tx(db, 'readonly', (s) => s.getAll());
  },
  async get(id) {
    const db = await openDB();
    return tx(db, 'readonly', (s) => s.get(id));
  },
  async put(note) {
    const db = await openDB();
    return tx(db, 'readwrite', (s) => s.put(note));
  },
  async del(id) {
    const db = await openDB();
    return tx(db, 'readwrite', (s) => s.delete(id));
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ai = new HybridAI();
let notes = [];
let currentId = null;
let saveTimer = null;
let aiRunning = false;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const now = () => Date.now();
const fmtDate = (ts) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const snippet = (body) => (body || '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Empty note';
const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

// ---------------------------------------------------------------------------
// Sample notes (seeded once, deletable)
// ---------------------------------------------------------------------------

const SAMPLE_NOTES = [
  {
    title: 'Welcome to Nano Notes',
    body: [
      'Nano Notes is an offline-first notes app with hybrid AI summarization.',
      '',
      'Write or paste any note, then press Summarize. If your device has Gemini Nano, the summary is generated entirely on-device — your text never leaves the laptop. Long documents are handed to the cloud model instead, and everything is labelled so you always know which engine did the work.',
      '',
      'Your notes live in IndexedDB in this browser. No account, no server, no sync. Delete this note whenever you like — the app is yours.',
    ].join('\n'),
  },
  {
    title: 'Why hybrid AI matters (long note)',
    body: [
      'Running a language model entirely on a laptop used to mean downloading gigabytes of weights, finding a GPU, and babysitting a local server. Chrome changed that by shipping Gemini Nano inside the browser itself: one download, shared across every site, no API key, no per-token bill.',
      '',
      'The catch is that the on-device model is small. It is brilliant for short, focused jobs — summarizing a meeting note, pulling out the key points of an article, rewriting a paragraph. It is not the right tool for a fifty-page report, both because its context window is limited and because a bigger cloud model will simply do a better job on that scale.',
      '',
      'That is the whole idea behind hybrid inference. The app tries the on-device model first: private, free, and available offline. When the document is long, or the device cannot run the model, the same request is routed to a cloud model instead. The user sees one button and one answer, but the badge next to the answer always says which engine produced it.',
      '',
      'Firebase AI Logic is the glue. One SDK call, one model object, and an inference mode that expresses the preference: prefer on-device, prefer cloud, or only one of them. The SDK checks availability, starts the model download when needed, and falls back automatically. The response even reports its own source, so the app can label it honestly.',
      '',
      'For a notes app this is the perfect shape. Most notes are short, so most summaries are free and private. The rare long document gets the cloud, and the user is never asked to understand any of the machinery — only to notice the badge.',
    ].join('\n'),
  },
  {
    title: 'Weekend ideas',
    body: [
      '- Try the farmers market on Saturday morning before it gets crowded.',
      '- Fix the squeaky kitchen drawer (hinge screws, not the runner).',
      '- Call Maya about the cabin weekend in December.',
      '- Read two chapters of the library book before Monday.',
      '',
      'Idea for the demo video: record the summarize button on the long note, then show the badge switching between on-device and cloud.',
    ].join('\n'),
  },
];

async function seedSamples() {
  if (localStorage.getItem(SAMPLE_FLAG)) return;
  const ts = now();
  for (const s of SAMPLE_NOTES) {
    await store.put({
      id: uid(),
      title: s.title,
      body: s.body,
      createdAt: ts,
      updatedAt: ts,
      summary: null,
      summarySource: null,
      summaryAt: null,
    });
  }
  localStorage.setItem(SAMPLE_FLAG, '1');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderList(filter = '') {
  const list = $('#noteList');
  const q = filter.trim().toLowerCase();
  const visible = notes
    .filter((n) => !q || (n.title + '\n' + n.body).toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('#noteCount').textContent = `${visible.length} note${visible.length === 1 ? '' : 's'}`;
  if (visible.length === 0) {
    list.innerHTML = `<li class="empty-list">${q ? 'No notes match your search.' : 'No notes yet. Click “New note” to start.'}</li>`;
    return;
  }
  list.innerHTML = visible
    .map(
      (n) => `<li data-id="${n.id}" class="${n.id === currentId ? 'active' : ''}">
        <div class="note-title">${escapeHtml(n.title || 'Untitled')}</div>
        <div class="note-snippet">${escapeHtml(snippet(n.body))}</div>
        <div class="note-meta">${fmtDate(n.updatedAt)}${n.summary ? ' · ✦ summarized' : ''}</div>
      </li>`
    )
    .join('');
  list.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => selectNote(li.dataset.id));
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderEditor() {
  const note = notes.find((n) => n.id === currentId);
  const hasNote = !!note;
  $('#noteTitle').disabled = !hasNote;
  $('#noteBody').disabled = !hasNote;
  $('#btnDelete').disabled = !hasNote;
  $('#btnSummarize').disabled = !hasNote || aiRunning;
  $('#btnKeyPoints').disabled = !hasNote || aiRunning;
  if (!note) {
    $('#noteTitle').value = '';
    $('#noteBody').value = '';
    $('#metaLine').textContent = 'Select a note or create a new one.';
    $('#summaryBox').classList.add('hidden');
    updateCounts('');
    return;
  }
  $('#noteTitle').value = note.title;
  $('#noteBody').value = note.body;
  $('#metaLine').textContent = `Updated ${fmtDate(note.updatedAt)} · ${wordCount(note.body)} words · ~${estimateTokens(note.body)} tokens`;
  updateCounts(note.body);
  if (note.summary) {
    showSummary(note.summary, note.summarySource, note.summaryAt, false);
  } else {
    $('#summaryBox').classList.add('hidden');
  }
}

function updateCounts(body) {
  $('#counts').textContent = `${wordCount(body)} words · ${body.length} characters · ~${estimateTokens(body)} tokens`;
}

function showSummary(text, source, at, isNew = true) {
  const box = $('#summaryBox');
  const label = sourceLabel(source);
  box.classList.remove('hidden');
  $('#summaryBadge').textContent = label.text;
  $('#summaryBadge').className = 'badge ' + label.cls;
  $('#summaryText').textContent = text;
  $('#summaryMeta').textContent =
    (isNew ? 'Generated just now' : `Saved ${at ? fmtDate(at) : ''}`) +
    (label.ai ? '' : ' · computed locally from your text — not AI output');
  $('#summaryBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setStatus(text, kind = '') {
  const el = $('#engineStatus');
  el.textContent = text;
  el.className = 'pill ' + kind;
}

function setAiProgress(text, frac = null) {
  const bar = $('#aiProgress');
  const label = $('#aiStatus');
  if (text == null) {
    bar.classList.add('hidden');
    label.textContent = '';
    return;
  }
  bar.classList.remove('hidden');
  label.textContent = text;
  if (frac != null) $('#aiBarFill').style.width = `${Math.round(frac * 100)}%`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function refreshNotes() {
  notes = await store.all();
  renderList($('#searchInput').value);
}

async function selectNote(id) {
  await saveCurrent(true);
  currentId = id;
  renderList($('#searchInput').value);
  renderEditor();
}

async function newNote() {
  await saveCurrent(true);
  const note = {
    id: uid(),
    title: '',
    body: '',
    createdAt: now(),
    updatedAt: now(),
    summary: null,
    summarySource: null,
    summaryAt: null,
  };
  await store.put(note);
  notes.push(note);
  currentId = note.id;
  renderList($('#searchInput').value);
  renderEditor();
  $('#noteTitle').focus();
}

async function saveCurrent(immediate = false) {
  if (!currentId) return;
  const note = notes.find((n) => n.id === currentId);
  if (!note) return;
  const title = $('#noteTitle').value;
  const body = $('#noteBody').value;
  if (note.title === title && note.body === body) return;
  note.title = title;
  note.body = body;
  note.updatedAt = now();
  await store.put(note);
  $('#metaLine').textContent = `Saved ${fmtDate(note.updatedAt)} · ${wordCount(body)} words · ~${estimateTokens(body)} tokens`;
  if (!immediate) renderList($('#searchInput').value);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrent(false), 600);
  updateCounts($('#noteBody').value);
}

async function deleteCurrent() {
  if (!currentId) return;
  const note = notes.find((n) => n.id === currentId);
  if (!note || !confirm(`Delete “${note.title || 'Untitled'}”?`)) return;
  await store.del(currentId);
  notes = notes.filter((n) => n.id !== currentId);
  currentId = notes.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;
  renderList($('#searchInput').value);
  renderEditor();
}

async function runAi(kind) {
  if (aiRunning || !currentId) return;
  const note = notes.find((n) => n.id === currentId);
  if (!note || !note.body.trim()) {
    alert('Write something in the note first.');
    return;
  }
  aiRunning = true;
  renderEditor();
  setAiProgress(kind === 'summary' ? 'Starting…' : 'Starting…');
  try {
    const onToken = (text) => {
      $('#summaryBox').classList.remove('hidden');
      $('#summaryBadge').textContent = 'Generating…';
      $('#summaryBadge').className = 'badge badge-working';
      $('#summaryText').textContent = text;
      $('#summaryMeta').textContent = '';
    };
    const onProgress = (frac) => setAiProgress(`Downloading on-device model… ${Math.round(frac * 100)}%`, frac);
    const onRoute = (info) => {
      if (info.rung === 'firebase') {
        setAiProgress(info.longDoc ? 'Long document — routing to cloud model…' : 'Trying on-device model…');
      } else if (info.rung === 'prompt-api') {
        setAiProgress('Using on-device Gemini Nano (Prompt API)…');
      } else if (info.rung === 'extractive') {
        setAiProgress('No AI model available — using local extractive summary…');
      }
    };
    const result =
      kind === 'summary'
        ? await ai.summarize(note.body, { onToken, onProgress, onRoute })
        : await ai.keyPoints(note.body, { onToken, onProgress, onRoute });
    setAiProgress(null);
    note.summary = result.text;
    note.summarySource = result.source;
    note.summaryAt = now();
    await store.put(note);
    showSummary(result.text, result.source, note.summaryAt, true);
    if (result.source === SOURCES.EXTRACTIVE) {
      setStatus('Extractive fallback active — no AI model on this device', 'warn');
    } else if (result.source === SOURCES.IN_CLOUD) {
      setStatus('Cloud model served this request', 'cloud');
    } else {
      setStatus('On-device model ready', 'ok');
    }
    renderList($('#searchInput').value);
  } catch (e) {
    setAiProgress(null);
    alert('Summarization failed: ' + (e?.message || e));
  } finally {
    aiRunning = false;
    renderEditor();
  }
}

// ---------------------------------------------------------------------------
// Engine status panel
// ---------------------------------------------------------------------------

async function refreshEngineStatus() {
  const ver = chromeVersion();
  const parts = [];
  if (ver) parts.push(`Chrome ${ver}`);
  const status = await promptApiStatus();
  const statusText = {
    available: 'Gemini Nano ready on-device',
    downloadable: 'Gemini Nano downloadable',
    downloading: 'Gemini Nano downloading…',
    unavailable: 'Gemini Nano unavailable on this device',
    unsupported: 'Prompt API not supported in this browser',
  }[status];
  parts.push(statusText);
  parts.push(ai.firebaseReady ? 'Firebase AI Logic connected' : 'Firebase not configured');
  $('#engineLine').textContent = parts.join(' · ');
  if (status === 'available' || ai.firebaseReady) setStatus('AI ready', 'ok');
  else if (status === 'downloadable' || status === 'downloading') setStatus('Model download available', 'warn');
  else setStatus('No AI model — extractive fallback', 'warn');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  $('#btnNew').addEventListener('click', newNote);
  $('#btnDelete').addEventListener('click', deleteCurrent);
  $('#btnSummarize').addEventListener('click', () => runAi('summary'));
  $('#btnKeyPoints').addEventListener('click', () => runAi('keypoints'));
  $('#btnCopySummary').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#summaryText').textContent);
      $('#btnCopySummary').textContent = 'Copied ✓';
      setTimeout(() => ($('#btnCopySummary').textContent = 'Copy'), 1500);
    } catch {
      /* clipboard unavailable */
    }
  });
  $('#btnClearSummary').addEventListener('click', async () => {
    const note = notes.find((n) => n.id === currentId);
    if (!note) return;
    note.summary = null;
    note.summarySource = null;
    note.summaryAt = null;
    await store.put(note);
    $('#summaryBox').classList.add('hidden');
  });
  $('#searchInput').addEventListener('input', () => renderList($('#searchInput').value));
  $('#noteTitle').addEventListener('input', scheduleSave);
  $('#noteBody').addEventListener('input', scheduleSave);

  await seedSamples();
  await refreshNotes();
  currentId = notes.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;
  renderList('');
  renderEditor();

  // Firebase init is best-effort and never blocks the app.
  const res = await ai.init();
  if (res.firebaseReady) {
    $('#firebaseState').textContent = 'Connected — hybrid mode (on-device preferred, cloud fallback).';
  } else if (res.reason === 'no-config') {
    $('#firebaseState').textContent =
      'Not configured — add firebase-config.js (see README) to enable the cloud fallback.';
  } else {
    $('#firebaseState').textContent = 'Init failed — on-device / extractive paths still work.';
  }
  await refreshEngineStatus();
}

boot().catch((e) => {
  console.error(e);
  $('#metaLine').textContent = 'Failed to start: ' + (e?.message || e);
});
