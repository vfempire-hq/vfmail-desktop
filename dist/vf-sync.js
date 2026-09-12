/* ============================================================
 * VF Mail — vault sync UI (desktop only)
 *
 * Adds:
 *   • "Sync & devices" panel opened from Settings → All settings
 *     → Accounts tab, and from the profile menu.
 *   • Sync status pill in the profile menu ("Synced via Syncthing ·
 *     3 min ago" / "Offline" / "Conflict — resolve").
 *   • Move-vault wizard: pick provider → pick folder → app copies
 *     the whole vault tree → asks user to re-unlock.
 *
 * Web mode: no-op. Sync is a desktop-only concept.
 * ============================================================ */
(function (w) {
  'use strict';
  if (!(w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)) return;
  const invoke = w.__TAURI__.core.invoke;

  const VfSync = w.VfSync = {
    async detect() { return invoke('sync_detect'); },
    async status() { return invoke('sync_status'); },
    async moveVault(target) { return invoke('sync_move_vault', { target }); },
    async scanConflicts() { return invoke('sync_scan_conflicts'); },
    async snapshotDb() { return invoke('sync_snapshot_db'); },
  };

  document.addEventListener('vfmail:vault-unlocked', boot);

  async function boot() {
    // Snapshot DB before we do anything mutable — small cost, huge safety net.
    try { await VfSync.snapshotDb(); } catch (_) {}
    // Auto-quarantine any sync conflicts that arrived while offline.
    try {
      const rep = await VfSync.scanConflicts();
      if (rep.count > 0 && typeof w.toast === 'function') w.toast(`Quarantined ${rep.count} sync conflict${rep.count===1?'':'s'} to conflicts/`);
    } catch (_) {}

    injectStatusPill();
    hookSettings();
    setInterval(refreshStatusPill, 60_000);
  }

  async function refreshStatusPill() {
    try {
      const s = await VfSync.status();
      const pill = document.getElementById('sync-pill');
      if (!pill) return;
      pill.textContent = pillLabel(s);
      pill.dataset.state = pillState(s);
    } catch (_) {}
  }
  function pillLabel(s) {
    if (s.conflict_count) return `⚠︎ ${s.conflict_count} conflict${s.conflict_count===1?'':'s'}`;
    if (s.in_synced_folder) {
      const ago = Math.round((Date.now()/1000 - s.last_modified)/60);
      const providerLabel = providerLabelFor(s.in_synced_folder);
      return `🔄 ${providerLabel} · ${ago}m ago`;
    }
    return '💾 Local only';
  }
  function pillState(s) {
    if (s.conflict_count) return 'conflict';
    if (s.in_synced_folder) return 'synced';
    return 'local';
  }
  function providerLabelFor(k) {
    return ({
      syncthing: 'Syncthing', icloud: 'iCloud', dropbox: 'Dropbox',
      onedrive: 'OneDrive', gdrive: 'Google Drive', custom: 'Custom',
    })[k] || k;
  }

  function injectStatusPill() {
    // Add sync pill inside the profile menu just above the divider.
    const pmActions = document.querySelector('.pm-actions');
    if (!pmActions) return;
    if (document.getElementById('sync-pill')) return;
    const pill = document.createElement('div');
    pill.id = 'sync-pill';
    pill.className = 'sync-pill';
    pmActions.parentElement.insertBefore(pill, pmActions);
    refreshStatusPill();
    pill.onclick = () => openSyncPanel();
  }

  function hookSettings() {
    // Wait for settings SP_BUILDERS to exist and augment the Accounts tab
    // with a "Sync & devices" section.
    const tryAugment = () => {
      if (!w.SP_BUILDERS || !w.SP_BUILDERS.accounts) return false;
      const orig = w.SP_BUILDERS.accounts;
      w.SP_BUILDERS.accounts = function () {
        const root = orig.apply(this, arguments);
        const sec = document.createElement('section');
        sec.className = 'sp-sec';
        sec.innerHTML = `
          <h3>Sync &amp; devices</h3>
          <p class="sp-sec-desc">Sync your vault between your own devices via a channel <b>you</b> control. VF never runs a sync server.</p>
          <div id="sync-panel"></div>`;
        root.appendChild(sec);
        setTimeout(paintSyncPanel, 60);
        return root;
      };
      return true;
    };
    if (!tryAugment()) setTimeout(tryAugment, 300);
  }

  async function paintSyncPanel() {
    const wrap = document.getElementById('sync-panel');
    if (!wrap) return;
    wrap.innerHTML = '<div class="sync-loading">Scanning your device for sync providers…</div>';
    let report, status;
    try {
      [report, status] = await Promise.all([VfSync.detect(), VfSync.status()]);
    } catch (e) {
      wrap.innerHTML = `<div class="sync-err">${escapeHtml(String(e))}</div>`;
      return;
    }
    wrap.innerHTML = '';
    const current = document.createElement('div');
    current.className = 'sync-current';
    current.innerHTML = `<b>Current vault:</b> <code>${escapeHtml(report.current_vault)}</code>
      ${report.in_synced_folder ? `<span class="sync-badge sync-badge-on">Inside ${escapeHtml(providerLabelFor(report.in_synced_folder))}</span>`
        : `<span class="sync-badge sync-badge-off">Local only</span>`}`;
    wrap.appendChild(current);

    const grid = document.createElement('div');
    grid.className = 'sync-grid';
    for (const p of report.providers) grid.appendChild(providerCard(p, status));
    wrap.appendChild(grid);

    const bin = document.createElement('div');
    bin.className = 'sync-conflicts';
    bin.innerHTML = status.conflict_count
      ? `<div class="sync-conflict-hd"><b>${status.conflict_count}</b> unresolved conflict${status.conflict_count===1?'':'s'} in <code>conflicts/</code></div>`
      : '<div class="sync-conflict-hd sync-ok">No sync conflicts detected.</div>';
    wrap.appendChild(bin);
  }

  function providerCard(p, status) {
    const active = status && status.in_synced_folder === p.key;
    const div = document.createElement('div');
    div.className = 'sync-card' + (active ? ' active' : '') + (p.installed ? '' : ' unavail');
    div.innerHTML = `
      <div class="sync-card-hd">
        <span class="sync-card-title">${escapeHtml(p.label)}</span>
        <span class="sync-trust sync-trust-${trustBucket(p.trust_score)}" data-tip="Sovereignty score">${p.trust_score}</span>
      </div>
      <div class="sync-card-desc">${escapeHtml(p.description)}</div>
      <div class="sync-card-status">${p.installed ? (active ? 'Live · in use' : 'Detected · available') : 'Not installed'}</div>
      ${p.suggested_path ? `<code class="sync-path">${escapeHtml(p.suggested_path)}</code>` : ''}
      <div class="sync-card-actions">
        ${active ? '<span class="sync-active-pill">✓ current</span>' : ''}
        <button class="btn-ghost sync-move-btn" ${p.installed ? '' : 'disabled'}>${p.key === 'custom' ? 'Pick a folder…' : 'Move vault here'}</button>
      </div>`;
    div.querySelector('.sync-move-btn').onclick = () => moveWizard(p);
    return div;
  }
  function trustBucket(n) {
    if (n >= 90) return 'high';
    if (n >= 60) return 'mid';
    return 'low';
  }

  async function moveWizard(p) {
    let target = p.suggested_path;
    if (p.key === 'custom' || !target) {
      if (!w.__TAURI__.dialog) return;
      target = await w.__TAURI__.dialog.open({ directory: true });
      if (!target) return;
    } else {
      const useIt = confirm(`Move the entire vault to:\n\n${target}\n\nThe app will lock, copy the vault over, then ask you to unlock again from the new location.\n\nContinue?`);
      if (!useIt) return;
    }
    try {
      const res = await VfSync.moveVault(target);
      alert(`Vault moved to:\n${res.moved_to}\n\nRe-unlock the vault from that path to continue.`);
      location.reload();
    } catch (e) {
      alert(`Move failed: ${e}`);
    }
  }

  function openSyncPanel() {
    // Open settings → Accounts, which now hosts the sync section.
    if (typeof w.openSettings === 'function') w.openSettings('accounts');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})(window);
