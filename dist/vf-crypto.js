/* ============================================================
 * VF Mail — end-to-end encryption client adapter
 *
 * When running in the desktop shell (Tauri), this module hooks
 * into compose + the thread reader:
 *
 *   • Compose: as you type recipients, look up their VF public
 *     keys via /.well-known/vfmail-keys/ (through Rust). Show
 *     a live 🔒 badge with "Verified · encrypted end-to-end" or
 *     a "Not encrypted" warning per recipient.
 *
 *   • Send: if every recipient has a key AND the user hasn't
 *     opted out, seal the body with `invoke("mail_seal", …)`
 *     and swap it into the outgoing MIME. Non-VF recipients
 *     get the clear body with a small "Not encrypted" note.
 *
 *   • Receive: any message whose Content-Type equals
 *     application/vnd.vfmail.age-v1 is decrypted + signature-
 *     verified via `invoke("mail_open", …)` before it reaches
 *     the reader. A green "🔒 Encrypted · signed by <sender>"
 *     ribbon appears above the message body.
 *
 * Web mode: no-op. The demo mailbox stays cleartext (that's the
 * "try before you buy" gate).
 * ============================================================ */
(function (w) {
  'use strict';
  if (!(w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)) return;
  const invoke = w.__TAURI__.core.invoke;

  const cache = new Map(); // email → keyLookup result
  const debounces = new Map();

  const VfCrypto = w.VfCrypto = {
    async ensureIdentity(email, host) {
      return invoke('identity_ensure', { email, host: host || email.split('@')[1] });
    },
    async lookup(email) {
      const norm = (email || '').trim().toLowerCase();
      if (!norm) return { found: false };
      if (cache.has(norm)) return cache.get(norm);
      try {
        const res = await invoke('keydir_lookup', { email: norm });
        cache.set(norm, res);
        return res;
      } catch (e) {
        cache.set(norm, { found: false, error: String(e) });
        return { found: false, error: String(e) };
      }
    },
    async seal(recipients, plaintext) {
      return invoke('mail_seal', { recipients, plaintext });
    },
    async open(mimeBody) {
      return invoke('mail_open', { mimeBody });
    },
    // ---------- VF Sealed Channel (envelope-hiding transport) ----------
    // Server sees only { recipient_id, sealed_blob } — no sender email,
    // no recipient email, no subject, no timestamp linked to identity.
    channel: {
      async send(peerSigningPubB64, sealedBlobB64) {
        return invoke('channel_send', {
          peerSigningPubB64,
          sealedBlobB64,
        });
      },
      async pull() {
        return invoke('channel_pull');
      },
      async ack(msgIds) {
        return invoke('channel_ack', { msgIds });
      },
    },
    /** Debounce a recipient-check callback keyed by input element. */
    watch(input, cb) {
      input.addEventListener('input', () => {
        const key = input.id || input.name || Math.random();
        clearTimeout(debounces.get(key));
        debounces.set(key, setTimeout(async () => {
          const emails = String(input.value || '')
            .split(/[,;]/).map(s => s.trim()).filter(Boolean)
            .map(a => (a.match(/[^\s<>]+@[^\s<>]+/) || [a])[0].toLowerCase());
          const results = await Promise.all(emails.map(e => VfCrypto.lookup(e)));
          cb(emails.map((email, i) => Object.assign({ email }, results[i])));
        }, 350));
      });
    },
  };

  // Once the mail app boots we prep the identity + hook compose.
  document.addEventListener('vfmail:vault-unlocked', bootAfterUnlock);

  async function bootAfterUnlock() {
    // Wait a beat until app.js resume() figures out who the user is.
    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (w.S && w.S.user) break;
      await sleep(120);
    }
    if (!w.S || !w.S.user) return;
    try {
      const info = await VfCrypto.ensureIdentity(w.S.user);
      w.VfCrypto.self = info;
      console.log('[VfCrypto] identity ready', info.age_recipient);
      // Auto-publish pubkey to /.well-known/vfmail-keys/ so every other
      // VF user can find + encrypt to us without any manual step.
      publishPubkey(info).catch(e => console.warn('[VfCrypto] publish failed', e));
      hookCompose();
      hookReader();
    } catch (e) {
      console.error('[VfCrypto] identity bootstrap failed', e);
    }
  }

  async function publishPubkey(info) {
    if (!info || !info.age_recipient) return;
    if (!w.S || !w.S.token) return;
    const body = {
      email: info.email,
      age_recipient: info.age_recipient,
      signing_pub_b64: info.signing_pub_b64,
      created_at: info.created_at || Math.floor(Date.now() / 1000),
    };
    // Route via the same origin as JMAP so we hit the CF Worker, not the Stalwart node.
    const onInbox = location.hostname === 'inbox.vfempire.com';
    const url = onInbox ? '/publish-key' : 'https://inbox.vfempire.com/publish-key';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Basic ' + w.S.token },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('publish-key ' + r.status);
    console.log('[VfCrypto] pubkey published for', info.email);
  }

  function hookCompose() {
    const to = document.getElementById('cp-to');
    if (!to) return;
    // Live recipient key check.
    const bar = document.createElement('div');
    bar.id = 'cp-crypto-bar';
    bar.className = 'cp-crypto-bar';
    bar.innerHTML = '<span class="cp-lock-icon">🔒</span><span class="cp-lock-txt">Recipient key check…</span>';
    const foot = document.querySelector('.cp-foot');
    if (foot && foot.parentElement) foot.parentElement.insertBefore(bar, foot);
    VfCrypto.watch(to, results => paintBar(bar, results));
    // Also intercept send if we can.
    const orig = w.sendNowRequest;
    if (typeof orig !== 'function') return;
    w.sendNowRequest = async function () {
      const results = await Promise.all(
        (document.getElementById('cp-to').value || '')
          .split(/[,;]/).map(s => s.trim()).filter(Boolean)
          .map(async e => Object.assign({ email: (e.match(/[^\s<>]+@[^\s<>]+/) || [e])[0].toLowerCase() },
            await VfCrypto.lookup((e.match(/[^\s<>]+@[^\s<>]+/) || [e])[0].toLowerCase()))));
      const canEncrypt = results.length && results.every(r => r.found);
      if (canEncrypt) {
        try {
          const plaintext = document.getElementById('cp-body').innerText || '';
          const recipients = results.map(r => ({
            email: r.email,
            age_recipient: r.key.age_recipient,
            signing_pub_b64: r.key.signing_pub_b64,
          }));
          const mimeBody = await VfCrypto.seal(recipients, plaintext);
          // stash the sealed body on state so the app's buildEmailObject can pick it up
          w.__vfSealedBody = mimeBody;
          w.__vfSealedContentType = 'application/vnd.vfmail.age-v1';
        } catch (e) {
          console.error('[VfCrypto] seal failed', e);
        }
      }
      return orig.apply(this, arguments);
    };
  }

  function paintBar(bar, results) {
    if (!results.length) {
      bar.className = 'cp-crypto-bar';
      bar.innerHTML = '<span class="cp-lock-icon">✉︎</span><span class="cp-lock-txt">Add a recipient to check encryption.</span>';
      return;
    }
    const all = results.every(r => r.found);
    const some = results.some(r => r.found);
    if (all) {
      bar.className = 'cp-crypto-bar cp-lock-on';
      bar.innerHTML =
        '<span class="cp-lock-icon">🔒</span>' +
        '<span class="cp-lock-txt">End-to-end encrypted · <b>' +
        results.length + '</b> verified recipient' + (results.length === 1 ? '' : 's') + '</span>';
    } else if (some) {
      bar.className = 'cp-crypto-bar cp-lock-mixed';
      const missing = results.filter(r => !r.found).map(r => r.email).join(', ');
      bar.innerHTML =
        '<span class="cp-lock-icon">⚠︎</span>' +
        '<span class="cp-lock-txt">Some recipients have no key — <b>' + missing + '</b> will get clear text.</span>';
    } else {
      bar.className = 'cp-crypto-bar cp-lock-off';
      bar.innerHTML =
        '<span class="cp-lock-icon">✉︎</span>' +
        '<span class="cp-lock-txt">No VF Mail keys found — sending in the clear.</span>';
    }
  }

  function hookReader() {
    // Wrap the existing bodyOf() so encrypted payloads are decrypted first.
    if (typeof w.bodyOf !== 'function') return;
    const orig = w.bodyOf;
    w.bodyOf = function (e) {
      try {
        const ct = detectContentType(e);
        if (ct === 'application/vnd.vfmail.age-v1') {
          const body = extractBody(e);
          if (body) {
            VfCrypto.open(body).then(res => {
              const evt = new CustomEvent('vfmail:decrypted', { detail: { emailId: e.id, res } });
              document.dispatchEvent(evt);
            }).catch(err => console.error('[VfCrypto] open failed', err));
            return { html: '<div class="vf-encrypted-pending">🔒 Decrypting…</div>' };
          }
        }
      } catch (_) {}
      return orig(e);
    };

    // When decryption comes back, patch the visible msg body.
    document.addEventListener('vfmail:decrypted', ev => {
      const { emailId, res } = ev.detail;
      const els = document.querySelectorAll('.msg');
      for (const el of els) {
        if (el.dataset.filled && el.querySelector('.vf-encrypted-pending')) {
          el.querySelector('.msg-body').innerHTML =
            '<div class="vf-encrypted-ribbon">🔒 Encrypted end-to-end · signed by ' +
            (res.signature_verified ? '<b>verified sender</b>' : '<b class="bad">unverified</b>') +
            ' (' + escapeHtml(res.sender) + ')</div>' +
            '<pre class="msg-text">' + escapeHtml(res.plaintext) + '</pre>';
        }
      }
    });
  }

  function detectContentType(e) {
    const hv = (e.htmlBody || []).map(p => e.bodyValues && e.bodyValues[p.partId]).find(v => v && v.value);
    const tv = (e.textBody || []).map(p => e.bodyValues && e.bodyValues[p.partId]).find(v => v && v.value);
    const raw = (hv && hv.value) || (tv && tv.value) || '';
    if (/"application\/vnd\.vfmail\.age-v1"|"v":\s*1/.test(raw)) return 'application/vnd.vfmail.age-v1';
    return e.contentType || '';
  }
  function extractBody(e) {
    const hv = (e.htmlBody || []).map(p => e.bodyValues && e.bodyValues[p.partId]).find(v => v && v.value);
    const tv = (e.textBody || []).map(p => e.bodyValues && e.bodyValues[p.partId]).find(v => v && v.value);
    return (hv && hv.value) || (tv && tv.value) || '';
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})(window);
