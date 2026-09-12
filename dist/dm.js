/* ============================================================
 * VF Mail — Direct Messages (Wave 9)
 *
 * Encrypted DMs riding the mail rails:
 *   • body sealed with age (X25519) + signed with Ed25519  (M2 stack)
 *   • carries X-VF-DM: 1 header so the client can hide it from Inbox
 *   • $vfdm keyword set on both sent + received copies
 *   • real-time delivery via the existing JMAP eventsource
 *
 * Works web + desktop. On web, VfCrypto is a no-op — DMs still show,
 * they just come through as unsigned/unencrypted. On desktop (Tauri),
 * everything is E2E.
 * ============================================================ */
(function (w) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const D = {
    booted: false,
    threads: new Map(),         // peer email → { peer, lastAt, unread, msgs: [] }
    active: null,               // active peer email
    lookups: new Map(),         // peer → keydir cache
  };

  document.addEventListener('vfmail:vault-unlocked', boot);
  document.addEventListener('DOMContentLoaded', () => {
    // Web (non-Tauri) still boots after JMAP session established
    if (!w.VfMailAPI || !w.VfMailAPI.IS_TAURI) {
      // wait for login/resume — poll for S.acct
      const poll = setInterval(() => {
        if (w.VfMailAPI && w.VfMailAPI.state && w.VfMailAPI.state.acct) {
          clearInterval(poll); boot();
        }
      }, 400);
    }
  });

  async function boot() {
    if (D.booted) return;
    D.booted = true;
    mountRail();
    mountView();
    mountStyles();
    if (w.VfMailAPI) w.VfMailAPI.onStateChange(refresh);
    // Poll until login populates state.user, then ensure identity
    await waitForUser();
    await ensureIdentity();
    // Restore prior DMs from local sealed store (decrypt-on-boot).
    try { await restoreLocalDMs(); } catch (e) { console.warn('[DM] restore failed', e); }
    try { await refresh(); } catch (e) { console.warn('[DM] initial refresh failed', e); }
    // Start the sealed-channel poll loop.
    startChannelPoll();
  }

  // ---------- local sealed-blob storage (persists between launches) ----
  const DM_STORE_PREFIX = 'vfmail-dm-';
  function saveLocalSealed(peerKey, entry) {
    try {
      const key = DM_STORE_PREFIX + peerKey;
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push(entry);
      // Cap at 1000 messages per thread on local disk.
      if (arr.length > 1000) arr.splice(0, arr.length - 1000);
      localStorage.setItem(key, JSON.stringify(arr));
    } catch (e) { console.warn('[DM] saveLocalSealed failed', e); }
  }
  async function restoreLocalDMs() {
    if (!w.VfMailAPI?.IS_TAURI || !w.VfCrypto) return;
    const me = w.VfMailAPI.state?.user?.toLowerCase();
    if (!me) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DM_STORE_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const peer = k.slice(DM_STORE_PREFIX.length);
      const arr = JSON.parse(localStorage.getItem(k) || '[]');
      if (!D.threads.has(peer)) D.threads.set(peer, { peer, lastAt: 0, unread: 0, msgs: [] });
      const t = D.threads.get(peer);
      for (const entry of arr) {
        try {
          let text = null, sender = null, sigVerified = false;
          if (entry.opened === true) {
            // Already-opened cache from saveLocalOpened (from poll loop).
            text = entry.body; sender = entry.sender; sigVerified = true;
          } else if (entry.sealed_b64) {
            const sealed = decodeURIComponent(escape(atob(entry.sealed_b64)));
            const opened = await w.VfCrypto.open(sealed);
            if (!opened || !opened.plaintext) continue;
            text = opened.plaintext; sender = opened.sender; sigVerified = opened.signature_verified;
            try {
              const env = JSON.parse(opened.plaintext);
              if (env.v === 1 && typeof env.body === 'string') text = env.body;
            } catch (_) { /* legacy plain */ }
          } else { continue; }
          t.msgs.push({
            id: entry.msg_id || ('local-' + entry.ts),
            own: !!entry.own, ts: entry.ts, unread: false,
            preview: text,
            decrypted: { plaintext: text, sender, signature_verified: sigVerified },
            raw: null,
          });
          if (entry.ts > t.lastAt) t.lastAt = entry.ts;
        } catch (_) { /* skip undecryptable */ }
      }
      t.msgs.sort((a, b) => a.ts - b.ts);
    }
  }

  // ---------- sealed-channel poll loop ---------------------------------
  let pollTimer = null;
  function startChannelPoll() {
    if (pollTimer) return;
    pollChannelOnce().catch(e => console.warn('[DM] first poll failed', e));
    pollTimer = setInterval(() => pollChannelOnce().catch(() => {}), 12000);
  }
  async function pollChannelOnce() {
    if (!w.VfMailAPI?.IS_TAURI || !w.VfCrypto) return;
    if (!w.VfCrypto.self) return;
    const res = await w.VfCrypto.channel.pull();
    if (!res || !res.messages || !res.messages.length) return;
    console.log('[DM] channel pull got', res.messages.length, 'messages');
    const me = w.VfMailAPI.state.user.toLowerCase();
    const okIds = [];
    for (const m of res.messages) {
      if (!m.ok) { okIds.push(m.msg_id); continue; } // drop undecryptable so we don't loop
      let peer = null; let body = m.plaintext || '';
      try {
        const env = JSON.parse(m.plaintext);
        if (env.v === 1) {
          const sender = (m.sender || '').toLowerCase();
          const to = (env.to || '').toLowerCase();
          const isFromMe = sender === me;
          peer = isFromMe ? to : sender;
          body = env.body || '';
        }
      } catch (_) { peer = (m.sender || '').toLowerCase(); }
      if (!peer) { okIds.push(m.msg_id); continue; }
      if (!D.threads.has(peer)) D.threads.set(peer, { peer, lastAt: 0, unread: 0, msgs: [] });
      const t = D.threads.get(peer);
      // De-dupe: skip if we already have a msg with this server id or a near-time optimistic own.
      if (t.msgs.some(x => x.id === m.msg_id)) { okIds.push(m.msg_id); continue; }
      const ts = Date.now();
      const isFromMe = (m.sender || '').toLowerCase() === me;
      // If we optimistically added an own message ~5 seconds ago with same text, replace it.
      const optimistic = isFromMe ? t.msgs.find(x => x.own && x.decrypted?.plaintext === body && ts - x.ts < 60000) : null;
      if (optimistic) {
        optimistic.id = m.msg_id;
      } else {
        t.msgs.push({
          id: m.msg_id, own: isFromMe, ts,
          unread: !isFromMe && (D.active !== peer),
          preview: body,
          decrypted: { plaintext: body, sender: m.sender, signature_verified: m.signature_verified },
          raw: null,
        });
        if (!isFromMe && D.active !== peer) t.unread++;
        if (ts > t.lastAt) t.lastAt = ts;
      }
      // Persist to local sealed store so we survive restarts even after ack.
      // We only have the plaintext + sender here; we need the original sealed blob to re-open later.
      // NOTE: the server response returned decrypted content, not the raw sealed bytes — so
      // rebuild a minimal "already-opened" cache instead of a sealed cache for received messages.
      saveLocalOpened(peer, { peer, ts, body, sender: m.sender, own: isFromMe, msg_id: m.msg_id });
      okIds.push(m.msg_id);
    }
    if (okIds.length) {
      try { await w.VfCrypto.channel.ack(okIds); } catch (e) { console.warn('[DM] ack failed', e); }
    }
    updateUnreadDot();
    renderThreadList();
    if (D.active) renderThreadBody(D.threads.get(D.active));
  }

  // For messages we PULLED (already decrypted at the Rust level), save the
  // opened form. `restoreLocalDMs` handles both sealed_b64 and body entries.
  function saveLocalOpened(peerKey, entry) {
    try {
      const key = DM_STORE_PREFIX + peerKey;
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      // Convert to a "opened" marker so restore knows it's plaintext already.
      arr.push({ ...entry, opened: true });
      if (arr.length > 1000) arr.splice(0, arr.length - 1000);
      localStorage.setItem(key, JSON.stringify(arr));
    } catch (e) { console.warn('[DM] saveLocalOpened failed', e); }
  }
  async function waitForUser() {
    for (let i = 0; i < 40; i++) {
      if (w.VfMailAPI && w.VfMailAPI.state && w.VfMailAPI.state.user) return;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  async function ensureIdentity() {
    if (!w.VfCrypto) return;
    if (w.VfCrypto.self) return;
    const user = w.VfMailAPI && w.VfMailAPI.state && w.VfMailAPI.state.user;
    if (!user) { console.warn('[DM] no user, skipping ensureIdentity'); return; }
    try {
      const info = await w.VfCrypto.ensureIdentity(user);
      w.VfCrypto.self = info;
      console.log('[DM] identity ready', info && info.age_recipient);
    } catch (e) {
      console.warn('[DM] ensureIdentity failed', e);
      if (w.VfMailAPI.toast) w.VfMailAPI.toast('Identity setup failed: ' + e);
    }
  }

  // ---------- UI: rail item ----------
  function mountRail() {
    if (!w.VfMailAPI) return;
    w.VfMailAPI.railExtensions.push(injectMessagesRow);
    // If rail is already rendered, inject immediately
    const list = document.getElementById('rail-list');
    if (list) injectMessagesRow(list);
  }
  function injectMessagesRow(list) {
    if (!list || list.querySelector('.dm-rail-row')) return;
    const b = document.createElement('button');
    b.className = 'rail-row dm-rail-row';
    b.dataset.type = 'dms';
    b.dataset.key = 'dms';
    let unread = 0;
    for (const t of D.threads.values()) unread += t.unread;
    b.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M4 4h16v12H8l-4 4V4z"/></svg>
      <span class="rail-name">Messages</span>
      ${unread ? `<span class="rail-count">${unread}</span>` : ''}`;
    b.onclick = () => { showDMs(); };
    // Insert after Inbox row
    const inbox = Array.from(list.querySelectorAll('.rail-row')).find(r => r.dataset.key === 'inbox');
    if (inbox && inbox.nextSibling) list.insertBefore(b, inbox.nextSibling);
    else list.appendChild(b);
  }

  // ---------- UI: main view ----------
  function mountView() {
    // Place DM view as a sibling of list-view / thread-view inside <main.pane>
    const pane = document.querySelector('main.pane') || $('list-view')?.parentElement || $('app') || document.body;
    const v = document.createElement('section');
    v.id = 'dm-view';
    v.className = 'dm-view hidden';
    v.innerHTML = `
      <aside class="dm-side">
        <div class="dm-side-head">
          <button class="dm-back" id="dm-back-btn" title="Back to Inbox">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <h2>Messages</h2>
          <button class="dm-new" id="dm-new-btn" title="New DM">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        <div class="dm-threads" id="dm-threads"></div>
      </aside>
      <section class="dm-main" id="dm-main">
        <div class="dm-empty">
          <svg viewBox="0 0 64 64" width="80" height="80" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".35">
            <path d="M8 12h48v34H22l-14 12V12z"/>
          </svg>
          <p>Pick a conversation, or start a new one.</p>
        </div>
      </section>`;
    pane.appendChild(v);
    $('dm-new-btn').onclick = promptNewDM;
    $('dm-back-btn').onclick = () => {
      // Return to Inbox via the app's own setView so the rail state is right
      if (typeof w.setView === 'function') { w.setView('role', 'inbox'); }
      else { const dv = $('dm-view'); if (dv) dv.classList.add('hidden'); const lv = $('list-view'); if (lv) lv.classList.remove('hidden'); }
    };
  }

  function mountStyles() {
    const css = `
      .dm-view{flex:1;min-height:0;display:grid;grid-template-columns:300px 1fr;gap:6px;background:transparent}
      .dm-view.hidden{display:none}
      .dm-side{background:rgba(255,255,255,.72);backdrop-filter:blur(14px);border:1px solid rgba(0,0,0,.06);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
      .dm-side-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.06)}
      .dm-side-head h2{font-size:15px;font-weight:600;letter-spacing:-.01em;flex:1;text-align:center}
      .dm-back{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;cursor:pointer;color:#5b5b60}
      .dm-back:hover{background:rgba(0,0,0,.05);color:#1d1d1f}
      .dm-new{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;cursor:pointer;color:#1f6ff2}
      .dm-new:hover{background:rgba(31,111,242,.08)}
      .dm-threads{flex:1;overflow-y:auto;padding:4px}
      .dm-thread{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;margin:2px 0}
      .dm-thread:hover{background:rgba(0,0,0,.03)}
      .dm-thread.active{background:rgba(31,111,242,.10)}
      .dm-thread-avatar{width:36px;height:36px;border-radius:50%;flex:0 0 auto;color:#fff;font-weight:600;display:flex;align-items:center;justify-content:center;font-size:14px}
      .dm-thread-meta{flex:1;min-width:0}
      .dm-thread-name{font-size:13.5px;font-weight:600;color:#1d1d1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dm-thread-snip{font-size:12px;color:#8a8a8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
      .dm-thread-date{font-size:11px;color:#a0a0a5;flex:0 0 auto}
      .dm-thread-unread{width:8px;height:8px;border-radius:50%;background:#1f6ff2;margin-left:6px}
      .dm-unread-dot{position:absolute;top:8px;right:6px;width:7px;height:7px;border-radius:50%;background:#1f6ff2}
      .dm-main{background:rgba(255,255,255,.72);backdrop-filter:blur(14px);border:1px solid rgba(0,0,0,.06);border-radius:14px;display:flex;flex-direction:column;overflow:hidden}
      .dm-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#8a8a8f;text-align:center}
      .dm-empty p{margin-top:12px;font-size:13.5px}
      .dm-thread-head{padding:14px 20px;border-bottom:1px solid rgba(0,0,0,.06);display:flex;align-items:center;gap:12px}
      .dm-thread-head .dm-thread-avatar{width:32px;height:32px;font-size:13px}
      .dm-thread-head-title{font-size:14.5px;font-weight:600}
      .dm-thread-head-sub{font-size:11.5px;color:#8a8a8f;margin-top:1px}
      .dm-thread-head-lock{margin-left:auto;color:#1a883b;font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-weight:600}
      .dm-thread-body{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:6px}
      .dm-msg{max-width:70%;padding:9px 14px;border-radius:16px;font-size:14px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap}
      .dm-msg.own{background:#1f6ff2;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
      .dm-msg.peer{background:rgba(0,0,0,.06);color:#1d1d1f;align-self:flex-start;border-bottom-left-radius:4px}
      .dm-msg.sealed{font-size:11.5px;font-style:italic;opacity:.7;background:rgba(0,0,0,.04);color:#5b5b60;align-self:center;border-radius:10px;padding:5px 12px;max-width:100%}
      .dm-msg.sealed.own{background:rgba(31,111,242,.10);color:#3a5cbf}
      .dm-msg-time{font-size:10.5px;color:#a0a0a5;padding:2px 6px}
      .dm-msg-time.own{align-self:flex-end}
      .dm-msg-time.peer{align-self:flex-start}
      .dm-compose{border-top:1px solid rgba(0,0,0,.06);padding:12px 14px;display:flex;gap:10px;align-items:flex-end;background:rgba(255,255,255,.5)}
      .dm-compose textarea{flex:1;resize:none;min-height:38px;max-height:120px;padding:9px 12px;border:1px solid rgba(0,0,0,.08);border-radius:12px;font-family:inherit;font-size:14px;line-height:1.4;background:#fff}
      .dm-compose textarea:focus{outline:none;border-color:#1f6ff2}
      .dm-compose button{background:#1f6ff2;color:#fff;border:none;border-radius:12px;padding:10px 18px;font-weight:600;font-size:14px;cursor:pointer}
      .dm-compose button:disabled{opacity:.5;cursor:default}
      .dm-thread-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#a0a0a5;font-size:13px}
      .dm-new-modal{position:fixed;inset:0;background:rgba(0,0,0,.35);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:1000;animation:dmModalIn .18s ease}
      @keyframes dmModalIn{from{opacity:0}to{opacity:1}}
      .dm-new-card{width:380px;background:#fff;border-radius:16px;padding:26px 26px 22px;box-shadow:0 24px 60px -20px rgba(0,0,0,.35);border:1px solid rgba(0,0,0,.06)}
      .dm-new-title{font-size:20px;font-weight:600;letter-spacing:-.01em}
      .dm-new-sub{color:#6a6a70;font-size:12.5px;line-height:1.5;margin:6px 0 18px}
      .dm-new-sub code{background:rgba(0,0,0,.05);padding:1px 5px;border-radius:4px;font-size:11px}
      .dm-new-modal input{display:block;width:100%;padding:11px 13px;font-size:14.5px;border:1px solid rgba(0,0,0,.08);border-radius:10px;background:#f6f6f7;transition:border-color .15s,background .15s}
      .dm-new-modal input:focus{outline:none;border-color:#1f6ff2;background:#fff}
      .dm-new-err{color:#c0392b;font-size:12.5px;min-height:16px;margin:8px 0 10px}
      .dm-new-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      .dm-new-cancel{background:transparent;border:none;padding:9px 16px;border-radius:8px;font-weight:600;color:#5b5b60;font-size:13.5px;cursor:pointer}
      .dm-new-cancel:hover{background:rgba(0,0,0,.05)}
      .dm-new-go{background:#1f6ff2;border:none;color:#fff;padding:9px 22px;border-radius:999px;font-weight:600;font-size:13.5px;cursor:pointer}
      .dm-new-go:hover{background:#175ad4}
    `;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  }

  function showDMs() {
    // Hide list + thread + compose views (compose can leak keydown/send into DM)
    ['list-view', 'thread-view', 'files-view', 'settings', 'compose'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });
    // Cancel any pending regular-compose undo timer so its failure toast can't
    // fire while the user is in the DM view.
    const S = w.VfMailAPI && w.VfMailAPI.state;
    if (S && S.pendingSend) {
      try { clearTimeout(S.pendingSend.timer); } catch (_) {}
      S.pendingSend = null;
      console.log('[DM] cancelled stale pendingSend on entry');
    }
    const v = $('dm-view'); if (v) v.classList.remove('hidden');
    // Mark rail active
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.dm-rail-btn')?.classList.add('active');
    renderThreadList();
    if (D.active) openThread(D.active);
  }

  // ---------- data refresh ----------
  async function refresh() {
    if (!w.VfMailAPI || !w.VfMailAPI.state || !w.VfMailAPI.state.acct) return;
    const acct = w.VfMailAPI.state.acct;
    // Query all DMs via the $vfdm keyword (Stalwart's header filter is a no-op)
    const rs = await w.VfMailAPI.jmap([
      ['Email/query', {
        accountId: acct,
        filter: { hasKeyword: '$vfdm' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 500
      }, '0'],
      ['Email/get', {
        accountId: acct,
        '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        properties: ['id', 'threadId', 'from', 'to', 'subject', 'receivedAt', 'keywords', 'headers', 'preview', 'mailboxIds']
      }, '1']
    ]);
    const emails = ((rs || []).find(x => x[0] === 'Email/get') || [null, {}])[1].list || [];
    D.threads.clear();
    const me = (w.VfMailAPI.state.user || '').toLowerCase();
    for (const e of emails) {
      const fromAddr = ((e.from || [])[0] || {}).email || '';
      const toAddr = ((e.to || [])[0] || {}).email || '';
      const peer = fromAddr.toLowerCase() === me ? toAddr : fromAddr;
      if (!peer) continue;
      const key = peer.toLowerCase();
      if (!D.threads.has(key)) D.threads.set(key, { peer: key, lastAt: 0, unread: 0, msgs: [] });
      const t = D.threads.get(key);
      const own = fromAddr.toLowerCase() === me;
      const ts = Date.parse(e.receivedAt || '') || 0;
      const unread = !e.keywords || !e.keywords.$seen;
      t.msgs.push({ id: e.id, own, ts, unread, preview: e.preview || '', decrypted: null, raw: e });
      if (ts > t.lastAt) t.lastAt = ts;
      if (unread && !own) t.unread++;
    }
    // Decrypt in background for the active thread
    if (D.active && D.threads.has(D.active)) decryptThread(D.threads.get(D.active));
    updateUnreadDot();
    renderThreadList();
    if (D.active) renderThreadBody(D.threads.get(D.active));
  }

  function updateUnreadDot() {
    // Re-inject the rail row so the count updates
    const list = document.getElementById('rail-list');
    if (!list) return;
    const existing = list.querySelector('.dm-rail-row');
    if (existing) existing.remove();
    injectMessagesRow(list);
    // Also re-mark active if we're viewing DMs
    const dv = document.getElementById('dm-view');
    if (dv && !dv.classList.contains('hidden')) w.VfMailAPI && w.VfMailAPI.setActiveRail('dms');
  }

  function renderThreadList() {
    const box = $('dm-threads'); if (!box) return;
    box.innerHTML = '';
    const threads = Array.from(D.threads.values()).sort((a, b) => b.lastAt - a.lastAt);
    if (!threads.length) {
      box.innerHTML = '<div style="padding:20px 16px;color:#8a8a8f;font-size:13px;line-height:1.5">No conversations yet. Click <b>+</b> to start one.</div>';
      return;
    }
    for (const t of threads) {
      const el = document.createElement('div');
      el.className = 'dm-thread' + (D.active === t.peer ? ' active' : '');
      const initials = t.peer.split('@')[0].slice(0, 2).toUpperCase();
      const hue = w.VfMailAPI.hueFor(t.peer);
      el.innerHTML = `
        <div class="dm-thread-avatar" style="background:hsl(${hue} 65% 55%)">${esc(initials)}</div>
        <div class="dm-thread-meta">
          <div class="dm-thread-name">${esc(t.peer)}</div>
          <div class="dm-thread-snip">${esc(t.msgs[0] ? bubbleText(t.msgs[0]) : '')}</div>
        </div>
        <div class="dm-thread-date">${t.lastAt ? new Date(t.lastAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</div>
        ${t.unread ? '<span class="dm-thread-unread"></span>' : ''}`;
      el.onclick = () => openThread(t.peer);
      box.appendChild(el);
    }
  }

  async function openThread(peer) {
    D.active = peer;
    renderThreadList();
    const t = D.threads.get(peer) || { peer, msgs: [] };
    D.threads.set(peer, t);
    await decryptThread(t);
    renderThreadBody(t);
    // Mark read
    if (t.msgs.some(m => m.unread && !m.own)) markThreadRead(t);
  }

  async function decryptThread(t) {
    if (!w.VfMailAPI.IS_TAURI) return;
    const acct = w.VfMailAPI.state.acct;
    const undec = t.msgs.filter(m => !m.decrypted).slice(0, 100);
    if (!undec.length) return;
    // Fetch bodyValues for each
    const rs = await w.VfMailAPI.jmap([
      ['Email/get', {
        accountId: acct, ids: undec.map(m => m.id),
        properties: ['id', 'bodyValues', 'textBody', 'htmlBody'],
        fetchAllBodyValues: true, maxBodyValueBytes: 100000
      }, '0']
    ]);
    const byId = new Map(((rs[0] || [null, {}])[1].list || []).map(e => [e.id, e]));
    for (const m of undec) {
      const full = byId.get(m.id); if (!full) continue;
      const raw = (Object.values(full.bodyValues || {})[0] || {}).value || '';
      try {
        const inv = w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke;
        if (!inv) { m.decrypted = { plaintext: raw, error: 'no-invoke' }; continue; }
        const opened = await inv('mail_open', { mimeBody: raw });
        m.decrypted = opened;
      } catch (e) {
        m.decrypted = { plaintext: raw, error: String(e) };
      }
    }
  }

  function looksSealed(s) {
    if (!s) return false;
    return /"ciphertext_b64"|"sender_sig_pub"|-----BEGIN AGE/i.test(s);
  }
  function bubbleText(m) {
    if (m.decrypted && m.decrypted.plaintext && !looksSealed(m.decrypted.plaintext)) {
      return m.decrypted.plaintext;
    }
    if (m.decrypted && m.decrypted.error) {
      return '🔒 Encrypted · unable to decrypt';
    }
    if (looksSealed(m.preview)) return '🔒 Encrypted · decrypting…';
    return m.preview || '…';
  }

  function renderThreadBody(t) {
    const main = $('dm-main'); if (!main) return;
    if (!t) { main.innerHTML = '<div class="dm-empty"><p>Pick a conversation.</p></div>'; return; }
    const initials = t.peer.split('@')[0].slice(0, 2).toUpperCase();
    const hue = w.VfMailAPI.hueFor(t.peer);
    main.innerHTML = `
      <div class="dm-thread-head">
        <div class="dm-thread-avatar" style="background:hsl(${hue} 65% 55%)">${esc(initials)}</div>
        <div>
          <div class="dm-thread-head-title">${esc(t.peer)}</div>
          <div class="dm-thread-head-sub">Sealed with your keys · nobody else can read</div>
        </div>
        <div class="dm-thread-head-lock">🔒 encrypted</div>
      </div>
      <div class="dm-thread-body" id="dm-body"></div>
      <form class="dm-compose" id="dm-compose">
        <textarea id="dm-input" rows="1" placeholder="Message ${esc(t.peer)}"></textarea>
        <button type="submit" id="dm-send-btn">Send</button>
      </form>`;
    const body = $('dm-body');
    const msgs = [...t.msgs].sort((a, b) => a.ts - b.ts);
    if (!msgs.length) body.innerHTML = '<div class="dm-thread-empty">Say hi. Everything is encrypted end-to-end.</div>';
    else {
      let prevDay = null;
      for (const m of msgs) {
        const text = bubbleText(m);
        const b = document.createElement('div');
        b.className = 'dm-msg ' + (m.own ? 'own' : 'peer');
        if (text.startsWith('🔒')) b.classList.add('sealed');
        b.textContent = text;
        body.appendChild(b);
        const t2 = document.createElement('div');
        t2.className = 'dm-msg-time ' + (m.own ? 'own' : 'peer');
        t2.textContent = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        body.appendChild(t2);
      }
    }
    body.scrollTop = body.scrollHeight;
    // Wire composer
    const ta = $('dm-input'); const btn = $('dm-send-btn');
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('dm-compose').requestSubmit(); }
    });
    $('dm-compose').addEventListener('submit', async e => {
      e.preventDefault();
      e.stopPropagation();
      const text = ta.value.trim(); if (!text) return;
      console.log('[DM] compose submit', { peer: t.peer, len: text.length });
      btn.disabled = true;
      try {
        await sendDM(t.peer, text);
        ta.value = ''; ta.style.height = 'auto';
        console.log('[DM] send OK');
        await refresh(); openThread(t.peer);
      } catch (err) {
        console.error('[DM] send failed', err);
        const toast = w.VfMailAPI && w.VfMailAPI.toast;
        if (toast) toast('DM send failed: ' + (err && err.message || err));
      } finally { btn.disabled = false; ta.focus(); }
    });
    setTimeout(() => ta.focus(), 40);
  }

  async function sendDM(peer, plaintext) {
    const api = w.VfMailAPI;
    const me = api.state.user;
    if (!api.IS_TAURI || !w.VfCrypto) {
      throw new Error('VF DMs need the desktop app (sealed channel unavailable in web).');
    }
    const lookup = await w.VfCrypto.lookup(peer);
    if (!lookup.found) throw new Error(`${peer} has no VF Mail key yet. Ask them to sign up first.`);
    const self = w.VfCrypto.self;
    if (!self) throw new Error('identity missing');
    // Seal the JSON envelope so recipient can recover the "to" side even
    // when they pulled their own sent copy from their own queue.
    const envelope = JSON.stringify({ v: 1, to: peer.toLowerCase(), body: plaintext });
    const recipients = [
      { email: peer, age_recipient: lookup.key.age_recipient, signing_pub_b64: lookup.key.signing_pub_b64 },
    ];
    if (self.age_recipient && self.age_recipient !== lookup.key.age_recipient) {
      recipients.push({ email: me, age_recipient: self.age_recipient, signing_pub_b64: self.signing_pub_b64 });
    }
    const sealed = await w.VfCrypto.seal(recipients, envelope);
    // Base64 the sealed mime-body for the channel transport.
    const sealedB64 = btoa(unescape(encodeURIComponent(sealed)));
    // Send to peer's queue.
    console.log('[DM] channel.send → peer', peer);
    await w.VfCrypto.channel.send(lookup.key.signing_pub_b64, sealedB64);
    // Also send to own queue so poll loop shows a mirror of what we sent.
    if (self.signing_pub_b64 !== lookup.key.signing_pub_b64) {
      await w.VfCrypto.channel.send(self.signing_pub_b64, sealedB64);
    }
    // Optimistic local render — don't wait for the poll round-trip.
    const key = peer.toLowerCase();
    if (!D.threads.has(key)) D.threads.set(key, { peer: key, lastAt: 0, unread: 0, msgs: [] });
    const t = D.threads.get(key);
    const localId = 'local-' + Date.now();
    const ts = Date.now();
    t.msgs.push({
      id: localId, own: true, ts, unread: false, preview: plaintext,
      decrypted: { plaintext, sender: me, signature_verified: true }, raw: null,
    });
    if (ts > t.lastAt) t.lastAt = ts;
    saveLocalSealed(key, { peer: key, ts, sealed_b64: sealedB64, own: true, msg_id: localId });
    return true;
  }

  // NOTE: The old JMAP-based sendDM path lives below as sendDMLegacy but is
  // no longer wired to any button — kept only as a reference until v0.1.13.
  // eslint-disable-next-line no-unused-vars
  async function sendDMLegacy(peer, plaintext) {
    const api = w.VfMailAPI;
    const me = api.state.user;
    const identity = api.state.identity;
    if (!identity) throw new Error('identity missing');
    // Encrypt if VfCrypto is available
    let bodyText = plaintext; let contentType = 'text/plain';
    if (api.IS_TAURI && w.VfCrypto) {
      const lookup = await w.VfCrypto.lookup(peer);
      if (!lookup.found) throw new Error(`${peer} has no VF Mail key. Ask them to sign up first.`);
      const recipients = [{ email: peer, age_recipient: lookup.key.age_recipient, signing_pub_b64: lookup.key.signing_pub_b64 }];
      const self = w.VfCrypto.self;
      if (self && self.age_recipient && self.age_recipient !== lookup.key.age_recipient) {
        recipients.push({ email: me, age_recipient: self.age_recipient, signing_pub_b64: self.signing_pub_b64 });
      }
      bodyText = await w.VfCrypto.seal(recipients, plaintext);
      contentType = 'application/vnd.vfmail.age-v1';
    }
    const threadKey = await hash16([me.toLowerCase(), peer.toLowerCase()].sort().join(':'));
    // Build Email/set + EmailSubmission/set. Use the same multipart-of-one
    // pattern as the working compose flow — Stalwart rejects a single-part
    // bodyStructure that only has {partId,type} at the top level.
    const S = api.state;
    // Store the sealed body as text/plain so Stalwart returns it in bodyValues.
    // The real MIME type is asserted via X-VF-DM-Content-Type header, and the
    // reader detects sealed payloads by content pattern regardless.
    // Mirror the working compose shape exactly — Stalwart returns bodyValues
    // reliably for multipart/alternative with BOTH text and html parts.
    const bodyValues = {
      t: { value: bodyText },
      h: { value: '<pre style="font-family:inherit;white-space:pre-wrap">' +
        bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>' }
    };
    const bodyStructure = {
      type: 'multipart/alternative',
      subParts: [
        { partId: 't', type: 'text/plain' },
        { partId: 'h', type: 'text/html' }
      ]
    };
    const create = {
      mailboxIds: { [S.byRole.drafts.id]: true },
      keywords: { $draft: true, $seen: true, $vfdm: true },
      from: [{ email: me }],
      to: [{ email: peer }],
      subject: 'VF DM',
      'header:X-VF-DM:asText': '1',
      'header:X-VF-DM-Thread:asText': threadKey,
      'header:X-VF-DM-Content-Type:asText': contentType,
      bodyValues,
      bodyStructure
    };
    console.log('[DM] JMAP request', { subject: create.subject, ctype: contentType, bodyLen: (bodyText || '').length, threadKey });
    const rs = await api.jmap([
      ['Email/set', { accountId: S.acct, create: { d: create } }, '0'],
      ['EmailSubmission/set', {
        accountId: S.acct,
        create: { s: { emailId: '#d', identityId: identity.id } },
        onSuccessUpdateEmail: {
          '#s': {
            ['mailboxIds/' + S.byRole.drafts.id]: null,
            ['mailboxIds/' + (S.byRole.sent ? S.byRole.sent.id : S.byRole.drafts.id)]: true,
            ['keywords/$draft']: null
          }
        }
      }, '1']
    ]);
    console.log('[DM] JMAP response', rs);
    const eset = ((rs || []).find(x => x[0] === 'Email/set') || [null, {}])[1];
    if (eset && eset.notCreated && eset.notCreated.d) {
      const nc = eset.notCreated.d;
      throw new Error('Email/set rejected: ' + (nc.description || nc.type));
    }
    const sub = ((rs || []).find(x => x[0] === 'EmailSubmission/set') || [null, {}])[1];
    if (sub && sub.notCreated && sub.notCreated.s) {
      const nc = sub.notCreated.s;
      throw new Error('EmailSubmission rejected: ' + (nc.description || nc.type));
    }
    return true;
  }

  async function markThreadRead(t) {
    const api = w.VfMailAPI;
    const acct = api.state.acct;
    const unread = t.msgs.filter(m => m.unread && !m.own).map(m => m.id);
    if (!unread.length) return;
    const update = {};
    for (const id of unread) update[id] = { 'keywords/$seen': true };
    try { await api.jmap([['Email/set', { accountId: acct, update }, '0']]); }
    catch (_) { }
    for (const m of t.msgs) if (unread.includes(m.id)) m.unread = false;
    t.unread = 0;
    updateUnreadDot();
    renderThreadList();
  }

  function promptNewDM() {
    // Custom inline overlay — Tauri WebView2 blocks native prompt()
    const existing = document.getElementById('dm-new-modal');
    if (existing) { existing.remove(); return; }
    const modal = document.createElement('div');
    modal.id = 'dm-new-modal';
    modal.className = 'dm-new-modal';
    modal.innerHTML = `
      <div class="dm-new-card">
        <div class="dm-new-title">Start a DM</div>
        <div class="dm-new-sub">They need a VF Mail account. Their key is looked up at <code>vfempire.com/.well-known/vfmail-keys/</code>.</div>
        <input id="dm-new-email" type="email" placeholder="you@vfempire.com" autocomplete="off">
        <div id="dm-new-err" class="dm-new-err"></div>
        <div class="dm-new-actions">
          <button type="button" id="dm-new-cancel" class="dm-new-cancel">Cancel</button>
          <button type="button" id="dm-new-go" class="dm-new-go">Start</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const input = document.getElementById('dm-new-email');
    const err = document.getElementById('dm-new-err');
    const close = () => modal.remove();
    document.getElementById('dm-new-cancel').onclick = close;
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    setTimeout(() => input.focus(), 40);
    const submit = async () => {
      const email = (input.value || '').trim().toLowerCase();
      err.textContent = '';
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email.'; return; }
      if (w.VfMailAPI.IS_TAURI && w.VfCrypto) {
        await ensureIdentity();
        try {
          const r = await w.VfCrypto.lookup(email);
          if (!r.found) { err.textContent = `No VF Mail key found for ${email}. Ask them to sign up first.`; return; }
        } catch (e) { err.textContent = 'Key lookup failed: ' + e; return; }
      }
      if (!D.threads.has(email)) D.threads.set(email, { peer: email, lastAt: 0, unread: 0, msgs: [] });
      close();
      openThread(email);
    };
    document.getElementById('dm-new-go').onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') close(); });
  }

  // ---------- utils ----------
  async function hash16(s) {
    if (crypto && crypto.subtle) {
      const bytes = new TextEncoder().encode(s);
      const buf = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return s.slice(0, 16);
  }
})(window);
