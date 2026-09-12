/* ============================================================
 * VF Mail — auto-updater UI + firewall toggle (desktop only)
 *
 * Uses tauri-plugin-updater (loaded server-side). The plugin
 * verifies the update signature against the pubkey embedded in
 * tauri.conf.json. We just handle the UI:
 *   • check on boot + every 6h
 *   • toast "🎁 Update ready · What's new" → user clicks → dialog
 *     with release notes + Install button
 *   • firewall toggle in Settings → Accounts (three modes)
 * ============================================================ */
(function (w) {
  'use strict';
  if (!(w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)) return;
  const invoke = w.__TAURI__.core.invoke;

  const VfUpdater = w.VfUpdater = {
    async check() {
      const upd = w.__TAURI__.updater;
      if (!upd) return { available: false };
      const c = await upd.check();
      if (!c) return { available: false };
      return {
        available: true,
        version: c.version,
        currentVersion: c.currentVersion,
        date: c.date,
        body: c.body,
        install: () => c.downloadAndInstall(),
      };
    },
    async firewallGet() { return invoke('firewall_get'); },
    async firewallSet(profile) {
      return invoke('firewall_set', {
        mode: profile.mode,
        mailHosts: profile.mail_hosts || [],
        updateHosts: profile.update_hosts || [],
        extraHosts: profile.extra_hosts || [],
      });
    },
    async endpoint() { return invoke('firewall_updater_endpoint'); },
  };

  document.addEventListener('vfmail:vault-unlocked', () => {
    setTimeout(runCheck, 3000);
    setInterval(runCheck, 6 * 60 * 60 * 1000);
    hookSettings();
  });

  async function runCheck() {
    try {
      const res = await VfUpdater.check();
      if (!res.available) return;
      if (typeof w.toast === 'function') w.toast(`🎁 VF Mail ${res.version} available — click to review`, 'Review', () => showDialog(res));
    } catch (_) {}
  }

  function showDialog(res) {
    const back = document.createElement('div');
    back.className = 'vfup-back';
    back.innerHTML = `
      <div class="vfup-card">
        <h3>Update available · v${escapeHtml(res.version)}</h3>
        <div class="vfup-current">You're on v${escapeHtml(res.currentVersion || '?')}</div>
        <div class="vfup-notes">${nl2br(escapeHtml(res.body || 'Release notes not provided.'))}</div>
        <div class="vfup-actions">
          <button class="btn-ghost" id="vfup-later">Not now</button>
          <button class="btn-core" id="vfup-go">Download &amp; install</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    back.querySelector('#vfup-later').onclick = () => back.remove();
    back.querySelector('#vfup-go').onclick = async () => {
      back.querySelector('#vfup-go').textContent = 'Installing…';
      try { await res.install(); } catch (e) { alert('Install failed: ' + e); }
    };
  }

  function hookSettings() {
    const tryAugment = () => {
      if (!w.SP_BUILDERS || !w.SP_BUILDERS.accounts) return false;
      const orig = w.SP_BUILDERS.accounts;
      w.SP_BUILDERS.accounts = function () {
        const root = orig.apply(this, arguments);
        const sec = document.createElement('section');
        sec.className = 'sp-sec';
        sec.innerHTML = `
          <h3>Firewall mode</h3>
          <p class="sp-sec-desc">Technical guarantee behind "nothing leaves your machine": block every outbound connection except the ones you list.</p>
          <div id="firewall-panel"></div>`;
        root.appendChild(sec);
        setTimeout(paintFirewall, 60);
        return root;
      };
      return true;
    };
    if (!tryAugment()) setTimeout(tryAugment, 300);
  }

  async function paintFirewall() {
    const wrap = document.getElementById('firewall-panel');
    if (!wrap) return;
    let profile;
    try { profile = await VfUpdater.firewallGet(); }
    catch (e) { wrap.innerHTML = `<div class="sync-err">${escapeHtml(String(e))}</div>`; return; }
    wrap.innerHTML = '';

    const modes = [
      { key: 'off', label: 'Off', desc: 'No outbound restrictions.' },
      { key: 'app', label: 'App-level (recommended)', desc: 'VF Mail refuses any connection outside your allowlist. OS-wide connections still work for other apps.' },
      { key: 'os', label: 'Full OS lockdown', desc: 'Writes host-firewall rules (needs one-time admin). Every app on this machine is blocked from talking to anything outside your allowlist.' },
    ];
    const radios = document.createElement('div');
    radios.className = 'sp-radios';
    for (const m of modes) {
      const row = document.createElement('label');
      row.className = 'sp-radio';
      row.innerHTML = `<input type="radio" name="fwmode" value="${m.key}"${profile.mode === m.key ? ' checked' : ''}>
        <span class="sp-r-t"><b>${m.label}</b><small>${escapeHtml(m.desc)}</small></span>`;
      row.querySelector('input').onchange = e => { profile.mode = e.target.value; render(); };
      radios.appendChild(row);
    }
    wrap.appendChild(radios);

    const editor = document.createElement('div');
    editor.className = 'fw-editor';
    wrap.appendChild(editor);

    function render() {
      editor.innerHTML = profile.mode === 'off' ? '<div class="sync-current">Firewall is off. Every outbound host is reachable.</div>' : `
        <label>Mail server hosts (comma-separated)
          <input id="fw-mail" type="text" value="${escapeHtml((profile.mail_hosts || []).join(', '))}" placeholder="mail.vfempire.com, imap.example.com">
        </label>
        <label>Update hosts
          <input id="fw-upd" type="text" value="${escapeHtml((profile.update_hosts || []).join(', '))}" placeholder="updates.vfempire.com">
        </label>
        <label>Extra hosts (rarely needed)
          <input id="fw-extra" type="text" value="${escapeHtml((profile.extra_hosts || []).join(', '))}" placeholder="">
        </label>
        <button class="btn-core fw-save">Save firewall profile</button>
        <div id="fw-msg" class="fw-msg"></div>`;
      const save = editor.querySelector('.fw-save');
      if (save) save.onclick = async () => {
        profile.mail_hosts = split(editor.querySelector('#fw-mail').value);
        profile.update_hosts = split(editor.querySelector('#fw-upd').value);
        profile.extra_hosts = split(editor.querySelector('#fw-extra').value);
        try {
          await VfUpdater.firewallSet(profile);
          editor.querySelector('#fw-msg').textContent = 'Firewall profile saved.';
        } catch (e) {
          editor.querySelector('#fw-msg').textContent = 'Save failed: ' + e;
        }
      };
    }
    render();
  }
  function split(s) {
    return String(s || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function nl2br(s) { return s.replace(/\n/g, '<br>'); }
})(window);
