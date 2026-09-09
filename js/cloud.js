// Albert's Odyssey · capa de datos en la nube (Firebase Auth + Firestore)
// Las páginas siguen leyendo y escribiendo en localStorage. Este módulo:
//  1. exige inicio de sesión con correo y contraseña,
//  2. al entrar, baja los datos de la nube (la nube manda) y sube lo que solo exista aquí,
//  3. replica cada escritura local en Firestore y aplica en vivo los cambios de otros dispositivos.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CONFIG = {
  apiKey: "AIzaSyBq2mzuegZEzsbukGJuMWaxnS2dejx0UQs",
  authDomain: "alberts-odyssey.firebaseapp.com",
  projectId: "alberts-odyssey",
  storageBucket: "alberts-odyssey.firebasestorage.app",
  messagingSenderId: "794834512156",
  appId: "1:794834512156:web:9140a3906052f26364f2d9"
};
const PREFIX = 'ao_';
const DENY = new Set(['ao_session_v1', 'ao_gh_token', 'ao_gh_repo']);
const CHUNK = 200000; // caracteres por documento; Firestore limita cada documento a 1 MB
const CLIENT = (() => { try { let c = sessionStorage.getItem('ao_client'); if (!c) { c = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('ao_client', c); } return c; } catch (e) { return Math.random().toString(36).slice(2, 10); } })();

if (window.AO_NO_CLOUD) {
  document.body.classList.remove('auth-pending');
} else {
  main();
}

function main() {
  const app = initializeApp(CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const origSet = Storage.prototype.setItem, origRemove = Storage.prototype.removeItem;
  let uid = null, col = null, cloud = {}, unsub = null, started = false;
  const pending = new Map(); let flushTimer = null, reloadTimer = null;

  injectStyles();
  const ui = buildLogin();
  try { origRemove.call(localStorage, 'ao_session_v1'); } catch (e) {}

  window.aoCloud = {
    email: () => auth.currentUser ? auth.currentUser.email : '',
    signOut: async () => {
      if (!confirm('Cerrar sesión en este navegador. Tus datos siguen en la nube y volverán al entrar de nuevo.')) return;
      try { await flush(); } catch (e) {}
      clearLocal();
      await signOut(auth);
      location.reload();
    },
    flushNow: () => { clearTimeout(flushTimer); return flush(); },
    forceUpload: async () => {
      if (!uid) return;
      const keys = localKeys();
      keys.forEach(k => pending.set(k, localStorage.getItem(k)));
      await flush();
      status('Subidos ' + keys.length + ' bloques de datos de este navegador', 'ok');
    }
  };

  onAuthStateChanged(auth, async user => {
    if (!user) { uid = null; stopSync(); showLogin(); return; }
    uid = user.uid; col = collection(db, 'users', uid, 'store');
    hideLogin();
    try { await startSync(); }
    catch (e) { console.error('[cloud] error al sincronizar', e); status('Sin conexión con la nube', 'err'); }
  });

  // ── Inicio de sesión ──────────────────────────────────────
  function showLogin() { ui.root.classList.remove('hidden'); document.body.classList.add('auth-pending'); setTimeout(() => ui.email.focus(), 50); }
  function hideLogin() { ui.root.classList.add('hidden'); document.body.classList.remove('auth-pending'); document.body.classList.remove('locked'); }
  ui.form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = ui.email.value.trim(), pwd = ui.pwd.value;
    if (!email || !pwd) { ui.err.textContent = 'Escribe el correo y la contraseña.'; return; }
    ui.btn.disabled = true; ui.btn.textContent = 'Entrando…'; ui.err.textContent = '';
    try { await signInWithEmailAndPassword(auth, email, pwd); }
    catch (e) {
      const code = (e && e.code) || '';
      ui.err.textContent = /invalid-credential|wrong-password|user-not-found|invalid-email/.test(code) ? 'Correo o contraseña incorrectos.'
        : /too-many-requests/.test(code) ? 'Demasiados intentos. Espera unos minutos.'
        : /network/.test(code) ? 'Sin conexión. Comprueba la red.' : 'No se pudo entrar (' + code + ').';
      ui.pwd.value = ''; ui.pwd.focus();
    }
    ui.btn.disabled = false; ui.btn.textContent = 'Entrar';
  });
  ui.forgot.addEventListener('click', async ev => {
    ev.preventDefault();
    const email = ui.email.value.trim();
    if (!email) { ui.err.textContent = 'Escribe tu correo y vuelve a pulsar.'; ui.email.focus(); return; }
    try { await sendPasswordResetEmail(auth, email); ui.err.textContent = 'Te hemos enviado un correo para cambiar la contraseña.'; ui.err.classList.add('ok'); }
    catch (e) { ui.err.textContent = 'No se pudo enviar el correo.'; }
  });

  // ── Sincronización ────────────────────────────────────────
  async function startSync() {
    status('Sincronizando…', '');
    const snap = await getDocs(col);
    cloud = assemble(snap.docs);
    let changed = false;
    Object.keys(cloud).forEach(k => {
      const v = cloud[k].v; const local = localStorage.getItem(k);
      if (v !== null && v !== local) { origSet.call(localStorage, k, v); changed = true; }
    });
    const toUpload = localKeys().filter(k => !(k in cloud));
    toUpload.forEach(k => pending.set(k, localStorage.getItem(k)));
    if (!started) { patchStorage(); started = true; }
    if (pending.size) await flush(); else status('Sincronizado con la nube', 'ok');
    listen();
    addSignOut();
    if (changed) { location.reload(); }
  }
  function stopSync() { if (unsub) { unsub(); unsub = null; } }
  function listen() {
    stopSync();
    unsub = onSnapshot(col, snap => {
      const all = assemble(snap.docs);
      let changed = false;
      snap.docChanges().forEach(ch => {
        if (ch.doc.metadata.hasPendingWrites) return;
        const d = ch.doc.data() || {};
        if (d.c === CLIENT) return;
        const key = baseKey(ch.doc.id);
        if (DENY.has(key)) return;
        if (ch.type === 'removed' && !isChunk(ch.doc.id)) {
          if (localStorage.getItem(key) !== null) { origRemove.call(localStorage, key); changed = true; }
          return;
        }
        const entry = all[key]; if (!entry || entry.v === null) return;
        if (entry.v !== localStorage.getItem(key)) { origSet.call(localStorage, key, entry.v); changed = true; }
      });
      cloud = all;
      if (changed) { status('Datos actualizados desde otro dispositivo', 'ok'); scheduleReload(); }
    }, err => { console.error('[cloud] escucha', err); status('Sin conexión con la nube', 'err'); });
  }
  function scheduleReload() {
    clearTimeout(reloadTimer);
    const busy = () => document.querySelector('.overlay.open, .sess-overlay.open, .modal-overlay.open, .add-modal-overlay.open, .add-frase-overlay.open, .add-pending-overlay.open, #node-panel.open') || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    const tick = () => { if (busy() || pending.size) { reloadTimer = setTimeout(tick, 4000); } else { location.reload(); } };
    reloadTimer = setTimeout(tick, 1200);
  }
  function patchStorage() {
    Storage.prototype.setItem = function (k, v) {
      origSet.call(this, k, v);
      if (this === localStorage && syncable(k)) queue(k, String(v));
    };
    Storage.prototype.removeItem = function (k) {
      origRemove.call(this, k);
      if (this === localStorage && syncable(k)) queue(k, null);
    };
    window.addEventListener('pagehide', () => { if (pending.size) flush(); });
  }
  function queue(k, v) { pending.set(k, v); clearTimeout(flushTimer); flushTimer = setTimeout(() => flush().catch(e => { console.error('[cloud] subida', e); status('No se pudo guardar en la nube', 'err'); }), 700); }
  async function flush() {
    if (!uid || !pending.size) return;
    const items = Array.from(pending.entries()); pending.clear();
    let batch = writeBatch(db), ops = 0;
    const commit = async () => { if (ops) { await batch.commit(); batch = writeBatch(db); ops = 0; } };
    for (const [k, v] of items) {
      const prevParts = (cloud[k] && cloud[k].parts) || 1;
      if (v === null) {
        batch.delete(doc(col, k)); ops++;
        for (let i = 1; i < prevParts; i++) { batch.delete(doc(col, k + '__p' + i)); ops++; }
        delete cloud[k];
      } else {
        const parts = Math.max(1, Math.ceil(v.length / CHUNK));
        const ts = Date.now();
        if (parts === 1) { batch.set(doc(col, k), { v, parts: 1, ts, c: CLIENT }); ops++; }
        else {
          batch.set(doc(col, k), { v: v.slice(0, CHUNK), parts, ts, c: CLIENT }); ops++;
          for (let i = 1; i < parts; i++) { batch.set(doc(col, k + '__p' + i), { v: v.slice(i * CHUNK, (i + 1) * CHUNK), p: i, ts, c: CLIENT }); ops++; }
        }
        for (let i = parts; i < prevParts; i++) { batch.delete(doc(col, k + '__p' + i)); ops++; }
        cloud[k] = { v, parts };
      }
      if (ops >= 400) await commit();
    }
    await commit();
    status('Sincronizado · ' + new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }), 'ok');
  }

  // ── Utilidades ────────────────────────────────────────────
  function syncable(k) { return typeof k === 'string' && k.indexOf(PREFIX) === 0 && !DENY.has(k); }
  function localKeys() { const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (syncable(k)) ks.push(k); } return ks; }
  function isChunk(id) { return /__p\d+$/.test(id); }
  function baseKey(id) { return id.replace(/__p\d+$/, ''); }
  function assemble(docs) {
    const main = {}, chunks = {};
    docs.forEach(d => {
      const data = d.data() || {};
      if (isChunk(d.id)) { (chunks[baseKey(d.id)] = chunks[baseKey(d.id)] || {})[data.p] = data.v || ''; }
      else main[d.id] = { v0: typeof data.v === 'string' ? data.v : null, parts: data.parts || 1, ts: data.ts || 0 };
    });
    const out = {};
    Object.keys(main).forEach(k => {
      const m = main[k]; let v = m.v0;
      if (v !== null && m.parts > 1) {
        const c = chunks[k] || {}; let ok = true;
        for (let i = 1; i < m.parts; i++) { if (typeof c[i] !== 'string') { ok = false; break; } v += c[i]; }
        if (!ok) v = null; // trozo pendiente de llegar: no aplicar todavía
      }
      out[k] = { v, parts: m.parts, ts: m.ts };
    });
    return out;
  }
  function clearLocal() { localKeys().forEach(k => origRemove.call(localStorage, k)); }
  function status(msg, cls) { const el = document.getElementById('syncStatus'); if (!el) return; el.textContent = msg; el.className = 'sync-status' + (cls ? ' ' + cls : ''); }
  function addSignOut() {
    if (document.getElementById('aoSignOut')) return;
    const foot = document.querySelector('footer .wrap'); if (!foot) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'aoSignOut'; b.className = 'txt-btn'; b.textContent = 'Cerrar sesión'; b.onclick = window.aoCloud.signOut;
    foot.appendChild(b);
  }
  function buildLogin() {
    const root = document.createElement('div'); root.id = 'loginScreen'; root.className = 'hidden';
    root.innerHTML = '<form class="login" novalidate>'
      + '<div class="dateline">Sistema de vida personal · Acceso privado</div>'
      + '<div class="login-logo">Albert\'s <em>Odyssey</em></div>'
      + '<div class="login-sub">Entra con tu correo y contraseña. Tus datos se sincronizan entre dispositivos.</div>'
      + '<div class="field"><label for="loginEmail">Correo</label><input type="email" class="input" id="loginEmail" autocomplete="username" inputmode="email" placeholder="tu@correo.com"></div>'
      + '<div class="field"><label for="loginPwd">Contraseña</label><input type="password" class="input" id="loginPwd" autocomplete="current-password" placeholder="••••••••••"></div>'
      + '<div class="login-error" id="loginError"></div>'
      + '<div class="actions"><button type="submit" class="line-btn login-btn">Entrar</button><a href="#" class="txt-btn" id="loginForgot">He olvidado la contraseña</a></div>'
      + '<div class="login-hint">La sesión se mantiene en este navegador hasta que la cierres.</div>'
      + '</form>';
    document.body.appendChild(root);
    return { root, form: root.querySelector('form'), email: root.querySelector('#loginEmail'), pwd: root.querySelector('#loginPwd'), err: root.querySelector('#loginError'), btn: root.querySelector('.login-btn'), forgot: root.querySelector('#loginForgot') };
  }
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = '#loginScreen{position:fixed;inset:0;background:var(--paper,#F3F0E8);z-index:5000;display:flex;align-items:center;justify-content:center;padding:24px;visibility:visible}'
      + '#loginScreen.hidden{display:none}'
      + '#loginScreen .login{width:380px;max-width:100%;display:flex;flex-direction:column;gap:14px;margin:0}'
      + '#loginScreen .dateline{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3,#625E55);border-bottom:1px solid var(--ink,#171611);padding-bottom:14px}'
      + '#loginScreen .login-logo{font-family:var(--serif,Georgia,serif);font-size:48px;letter-spacing:-.03em;line-height:1;margin-top:8px}'
      + '#loginScreen .login-logo em{font-style:italic;font-weight:300;color:var(--ink-2,#45423A)}'
      + '#loginScreen .login-sub{font-size:14px;color:var(--ink-2,#45423A);line-height:1.5;margin-bottom:6px}'
      + '#loginScreen .field{display:flex;flex-direction:column;gap:6px}'
      + '#loginScreen label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3,#625E55);font-weight:500}'
      + '#loginScreen .input{font:inherit;font-size:16px;background:transparent;border:none;border-bottom:1px solid var(--rule,#C9C3B4);padding:8px 0;outline:none;color:var(--ink,#171611);border-radius:0;width:100%}'
      + '#loginScreen .input:focus{border-bottom-color:var(--ink,#171611)}'
      + '#loginScreen .login-error{font-size:13px;color:#A3442C;min-height:18px}'
      + '#loginScreen .login-error.ok{color:#2D6A4F}'
      + '#loginScreen .actions{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:4px}'
      + '#loginScreen .line-btn{font:inherit;font-size:14px;color:var(--ink,#171611);border:1px solid var(--ink,#171611);padding:8px 18px;background:transparent;cursor:pointer}'
      + '#loginScreen .line-btn:hover{background:var(--ink,#171611);color:var(--paper,#F3F0E8)}'
      + '#loginScreen .txt-btn{font-size:13px;color:var(--ink-3,#625E55);text-decoration:underline;text-underline-offset:4px}'
      + '#loginScreen .login-hint{font-size:12px;color:var(--ink-3,#625E55);margin-top:8px}';
    document.head.appendChild(s);
  }
}
