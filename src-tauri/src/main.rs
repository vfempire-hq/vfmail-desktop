// VF Mail — Sovereign Desktop
// Local-first, end-to-end encrypted. Your keys. Your hardware. Your vault.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vfmail_lib::run()
}
