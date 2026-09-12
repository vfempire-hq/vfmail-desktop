; VF Mail — NSIS installer hooks
; Adds a desktop shortcut on install, removes it on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\VF Mail.lnk" "$INSTDIR\vfmail.exe" "" "$INSTDIR\vfmail.exe" 0 SW_SHOWNORMAL "" "VF Mail — sovereign mail on hardware you own"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\VF Mail.lnk"
!macroend
