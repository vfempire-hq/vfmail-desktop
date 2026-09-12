/* ============================================================
 * VF Mail — vault shell
 *
 * Gates the mailbox behind a hero unlock ceremony. Same security
 * grade as the sovereign Vault app, dressed for the mailbox.
 *
 * Loaded only inside the Tauri desktop app. Adds:
 *   - vault-locked  hero screen (create OR unlock)
 *   - window.VfVault : { create, unlock, lock, status, invoke }
 *
 * In web (browser) mode this module short-circuits: the demo
 * lands straight in the mailbox — vfempire.com/download owns
 * the sovereignty story.
 * ============================================================ */
(function (w) {
  'use strict';

  const isTauri = !!(w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke);
  w.VfVault = { isTauri };

  if (!isTauri) return;

  const invoke = w.__TAURI__.core.invoke;
  w.VfVault.invoke = invoke;

  // --- render lock ceremony ---
  document.addEventListener('DOMContentLoaded', async () => {
    // hide the mail app until vault is unlocked
    const app = document.getElementById('app');
    if (app) app.classList.add('hidden');

    const status = await invoke('vault_status');
    const defaultPath = await invoke('vault_default_path');
    renderLock(!status.unlocked, defaultPath);
  });

  function renderLock(needsUnlock, defaultPath) {
    if (!needsUnlock) return unlocked();

    const lock = document.createElement('div');
    lock.id = 'vault-lock';
    lock.className = 'vault-lock';
    lock.innerHTML = `
      <div class="vl-bg"></div>
      <div class="vl-hero">
        <div class="vl-mail">
          <svg viewBox="0 0 240 140" aria-hidden="true">
            <defs>
              <linearGradient id="vlm" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#e63b19"/>
                <stop offset="1" stop-color="#7a1607"/>
              </linearGradient>
              <linearGradient id="vlf" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#f0f0f2"/>
                <stop offset="1" stop-color="#c9c9d0"/>
              </linearGradient>
            </defs>
            <rect x="20" y="30" width="200" height="100" rx="14" style="fill:url(#vlm);stroke:#4a0d05;stroke-width:2"/>
            <path d="M20 44l100 60 100-60" style="fill:none;stroke:#4a0d05;stroke-width:2"/>
            <rect x="52" y="12" width="136" height="80" rx="6" style="fill:url(#vlf);stroke:#7d7d85;stroke-width:1.5"/>
            <path d="M52 20h136M52 32h100M52 44h116M52 56h84" style="stroke:#a0a0aa;stroke-width:1.4;fill:none;opacity:.75"/>
            <circle cx="200" cy="26" r="9" style="fill:#f4c341;stroke:#8a7112;stroke-width:1.4"/>
            <path d="M196 26l3 3 6-6" style="fill:none;stroke:#4a3b0a;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"/>
          </svg>
        </div>
        <h1 class="vl-title">VF <em>Mail</em></h1>
        <div class="vl-sub">Sovereign. Local-first. End-to-end encrypted.</div>
        <div class="vl-shield">
          <svg viewBox="0 0 24 24"><path d="M12 2l9 4v7c0 5-4 9-9 11-5-2-9-6-9-11V6z" style="fill:none;stroke:currentColor;stroke-width:1.6"/><path d="M8 12l3 3 5-6" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"/></svg>
          <span>Argon2id · XChaCha20-Poly1305 · your keys never leave this machine</span>
        </div>

        <div class="vl-card">
          <div class="vl-tabs">
            <button class="vl-tab active" data-mode="unlock">Unlock existing vault</button>
            <button class="vl-tab" data-mode="create">Create new vault</button>
          </div>
          <div class="vl-form">
            <label>Vault location
              <div class="vl-row">
                <input id="vl-path" type="text" value="${escapeHtml(defaultPath)}">
                <button class="vl-browse" id="vl-browse" type="button">Browse…</button>
              </div>
            </label>
            <label>Master password
              <input id="vl-pw" type="password" placeholder="Enter your vault password" autocomplete="current-password">
            </label>
            <label id="vl-pw2-row" class="hidden">Confirm password
              <input id="vl-pw2" type="password" placeholder="Type it again" autocomplete="new-password">
            </label>
            <div id="vl-err" class="vl-err"></div>
            <button id="vl-go" class="vl-go">Unlock mailbox</button>
            <div class="vl-hint">First time? Switch to <b>Create new vault</b>. Your password unlocks the mailbox and every file inside. Losing it means losing the vault — nothing is recoverable server-side because there is no server.</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(lock);

    let mode = 'unlock';
    lock.querySelectorAll('.vl-tab').forEach(t => {
      t.onclick = () => {
        mode = t.dataset.mode;
        lock.querySelectorAll('.vl-tab').forEach(x => x.classList.toggle('active', x === t));
        lock.querySelector('#vl-pw2-row').classList.toggle('hidden', mode !== 'create');
        lock.querySelector('#vl-go').textContent = mode === 'create' ? 'Create vault & unlock' : 'Unlock mailbox';
      };
    });

    lock.querySelector('#vl-browse').onclick = async () => {
      if (!w.__TAURI__.dialog) return;
      const picked = await w.__TAURI__.dialog.open({ directory: true });
      if (picked) lock.querySelector('#vl-path').value = picked;
    };

    const go = async () => {
      const path = lock.querySelector('#vl-path').value.trim();
      const pw = lock.querySelector('#vl-pw').value;
      const pw2 = lock.querySelector('#vl-pw2').value;
      const err = lock.querySelector('#vl-err');
      err.textContent = '';
      if (!path) return (err.textContent = 'Pick a vault location.');
      if (!pw) return (err.textContent = 'Enter your password.');
      if (mode === 'create' && pw !== pw2) return (err.textContent = 'Passwords do not match.');
      lock.querySelector('#vl-go').disabled = true;
      try {
        await invoke(mode === 'create' ? 'vault_create' : 'vault_unlock', { path, password: pw });
        // Check mail creds — if missing, show a small inline form
        let creds = null, credsErr = null;
        try { creds = await invoke('mail_get_creds'); } catch (e) { credsErr = String(e); }
        if (creds && creds.address && creds.password) {
          finish();
        } else {
          if (credsErr) console.error('[vault] mail_get_creds error:', credsErr);
          showMailCredsStep(lock, credsErr);
        }
      } catch (e) {
        err.textContent = String(e);
        lock.querySelector('#vl-go').disabled = false;
      }
    };
    function finish() {
      lock.classList.add('unlocked');
      setTimeout(() => { lock.remove(); unlocked(); }, 700);
    }
    function showMailCredsStep(lockEl, credsErr) {
      const card = lockEl.querySelector('.vl-card');
      card.innerHTML = `
        <div class="vl-form">
          <div style="text-align:center;margin-bottom:12px">
            <div style="font-family:'Playfair Display',serif;font-size:22px;margin-bottom:4px">Mail account</div>
            <div style="color:#c9b6a4;font-size:12px">One-time setup. Stored inside your vault.</div>
            ${credsErr ? `<div style="color:#e63b19;font-size:11px;margin-top:6px">${escapeHtml(credsErr)}</div>` : ''}
          </div>
          <label>Mail address
            <input id="vl-mail" type="email" placeholder="you@vfempire.com" autocomplete="off" value="vincent@vfempire.com">
          </label>
          <label>Mail password
            <input id="vl-mpw" type="password" placeholder="Your JMAP password" autocomplete="off" value="bTFeX1MIq5zi1ByqdG0F">
          </label>
          <div id="vl-err" class="vl-err"></div>
          <button id="vl-msave" class="vl-go">Save & open mailbox</button>
        </div>`;
      const mail = card.querySelector('#vl-mail');
      const mpw = card.querySelector('#vl-mpw');
      const err2 = card.querySelector('#vl-err');
      setTimeout(() => mail.focus(), 60);
      const submit = async () => {
        const a = mail.value.trim(), p = mpw.value;
        err2.textContent = '';
        if (!a || !p) return (err2.textContent = 'Enter both fields.');
        card.querySelector('#vl-msave').disabled = true;
        try {
          await invoke('mail_set_creds', { address: a, password: p });
          finish();
        } catch (e) {
          err2.textContent = String(e);
          card.querySelector('#vl-msave').disabled = false;
        }
      };
      card.querySelector('#vl-msave').onclick = submit;
      [mail, mpw].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
    }
    lock.querySelector('#vl-go').onclick = go;
    ['vl-pw', 'vl-pw2'].forEach(id => {
      lock.querySelector('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }

  function unlocked() {
    const app = document.getElementById('app');
    if (app) app.classList.remove('hidden');
    // let the existing app boot know we can proceed
    document.dispatchEvent(new CustomEvent('vfmail:vault-unlocked'));
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Expose lock action (menu item / hotkey)
  w.VfVault.lock = async () => {
    await invoke('vault_lock');
    location.reload();
  };
})(window);
