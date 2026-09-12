/* ============================================================
 * VF Files — native adapter
 *
 * When running inside Tauri, replace the client-side
 * Files backend (SET.folders, SET.fileFolders, SET.filesBin)
 * with real invoke() calls against the Rust core.
 *
 * The web frontend keeps its existing API surface; this shim
 * intercepts the mutation functions and routes them to disk.
 *
 * Load order:
 *   vf-ui.js
 *   vault-shell.js
 *   app.js
 *   vf-files-native.js   ← this file (last)
 * ============================================================ */
(function (w) {
  'use strict';
  if (!(w.__TAURI__ && w.__TAURI__.core && w.__TAURI__.core.invoke)) return;
  const invoke = w.__TAURI__.core.invoke;

  // Only kick in once the vault is unlocked.
  document.addEventListener('vfmail:vault-unlocked', boot);

  async function boot() {
    try {
      const [folders, files, stats] = await Promise.all([
        invoke('fs_list_folders'),
        invoke('fs_list_files', { folderId: null }),
        invoke('fs_stats'),
      ]);

      // Hand the native tree to the running app.
      if (!w.SET) return;
      w.SET.folders = folders.map(f => ({
        id: f.id, name: f.name, parentId: f.parent_id || '', createdAt: f.created_at,
      }));
      w.SET.fileFolders = {};
      const nativeFiles = files.map(mapNativeFile);
      // Rewire ensureFilesIndex to return the native list.
      if (typeof w.S === 'object') {
        w.S.filesIndex = nativeFiles;
        w.S.filesIndexAt = Date.now();
      }
      // Repaint if already inside the Files view.
      if (typeof w.paintFilesMain === 'function' && document.getElementById('files-view') && !document.getElementById('files-view').classList.contains('hidden')) {
        w.paintFilesMain();
      }
    } catch (e) {
      console.error('native files bootstrap failed', e);
    }
  }

  function mapNativeFile(r) {
    return {
      blobId: r.id,          // native id serves as blob handle
      name: r.display_name || r.name,
      size: r.size,
      type: r.mime || '',
      receivedAt: new Date(r.created_at * 1000).toISOString(),
      from: { name: 'Local', email: '' },
      subject: r.name,
      folderId: r.folder_id,
      _native: true,
      kind: null,
      flags: [],
    };
  }

  // Wrap the mutations so they hit disk.
  const wrappers = {
    createFolder: async (name, parentId) => {
      const row = await invoke('fs_create_folder', { name, parentId: parentId || null });
      if (w.SET && w.SET.folders) w.SET.folders.push({ id: row.id, name: row.name, parentId: row.parent_id || '', createdAt: row.created_at });
      return row.id;
    },
    renameFolder: async (id, newName) => {
      await invoke('fs_rename_folder', { id, newName });
      const f = (w.SET.folders || []).find(x => x.id === id); if (f) f.name = newName;
    },
    deleteFolder: async id => {
      await invoke('fs_delete_folder', { id });
      w.SET.folders = (w.SET.folders || []).filter(x => x.id !== id);
    },
    moveFile: async (id, folderId) => {
      await invoke('fs_move_file', { id, folderId: folderId || null });
    },
    renameFile: async (id, newName) => {
      await invoke('fs_rename_file', { id, newName });
    },
    copyFile: async (id, folderId) => {
      const row = await invoke('fs_copy_file', { id, folderId: folderId || null });
      if (w.S && w.S.filesIndex) w.S.filesIndex.push(mapNativeFile(row));
    },
    deleteFile: async id => {
      await invoke('fs_delete_file', { id });
    },
    restoreFile: async id => {
      await invoke('fs_restore_file', { id });
    },
    emptyBin: async () => await invoke('fs_empty_bin'),
    ingestFile: async (name, folderId, file) => {
      const buf = new Uint8Array(await file.arrayBuffer());
      const row = await invoke('fs_upload_bytes', {
        name, folderId: folderId || null, bytes: Array.from(buf),
      });
      if (w.S && w.S.filesIndex) w.S.filesIndex.push(mapNativeFile(row));
      return row;
    },
    star: async (id, on) => await invoke('fs_star', { id, on }),
    setColor: async (id, color) => await invoke('fs_set_color', { id, color: color || null }),
    setNotes: async (id, notes) => await invoke('fs_set_notes', { id, notes }),
    stats: async () => await invoke('fs_stats'),
  };
  w.VfFiles = wrappers;
})(window);
