#!/usr/bin/env bash
# VF Mail — one-command update to Vincent's German PC.
#
#   ./ship-update.sh              # bump patch version, ship, wait for install
#   VER=0.2.0 ./ship-update.sh    # ship a specific version
#
# Reads env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, AGENT_TOKEN

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

WORKSPACE_DIR="${WORKSPACE_DIR:-/home/guardiansoftiktok/vfmail-workspace}"
AGENT_HOST="${AGENT_HOST:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

# Load local overrides if present (git-ignored)
if [[ -f "$REPO_DIR/.env.ship" ]]; then
  # shellcheck disable=SC1091
  source "$REPO_DIR/.env.ship"
fi
: "${AGENT_HOST:?AGENT_HOST unset — put it in .env.ship or the environment}"
: "${AGENT_TOKEN:?AGENT_TOKEN unset — put it in .env.ship or the environment}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN unset — put it in .env.ship or the environment}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID unset — put it in .env.ship or the environment}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

say()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

command -v jq  >/dev/null || die "jq required"
command -v npx >/dev/null || die "npx required"

# ---- 1. version ----
CONF="src-tauri/tauri.conf.json"
CUR_VER=$(jq -r '.version' "$CONF")
if [[ -n "${VER:-}" ]]; then
  NEW_VER="$VER"
else
  IFS='.' read -r MAJ MIN PATCH <<<"$CUR_VER"
  NEW_VER="${MAJ}.${MIN}.$((PATCH+1))"
fi
say "bumping ${CUR_VER} → ${NEW_VER}"
tmp=$(mktemp); jq --arg v "$NEW_VER" '.version = $v' "$CONF" > "$tmp" && mv "$tmp" "$CONF"

# ---- 2. package + publish ----
PATCH_NAME="vfmail-ship-${NEW_VER}.tgz"
PATCH_TGZ="/tmp/${PATCH_NAME}"
tar czf "$PATCH_TGZ" dist src-tauri/src src-tauri/tauri.conf.json
SIZE=$(stat -c%s "$PATCH_TGZ")
ok "packed ${PATCH_NAME} ($(numfmt --to=iec $SIZE))"

cp "$PATCH_TGZ" "$WORKSPACE_DIR/app/downloads/vfmail-ship-latest.tgz"
say "deploying to inbox.vfempire.com/downloads/vfmail-ship-latest.tgz"
( cd "$WORKSPACE_DIR" && npx wrangler deploy 2>&1 | tail -3 )
ok "patch live on CDN"

# ---- 3. drive the German PC (one PS blob, no nested heredocs) ----
say "kicking rebuild + install on Vincent's PC"
PS_SCRIPT="\$ErrorActionPreference='Continue'
Set-Location 'C:\\Users\\email\\VFMailBuild\\source'
Invoke-WebRequest -UseBasicParsing 'https://inbox.vfempire.com/downloads/vfmail-ship-latest.tgz' -OutFile ..\\vfmail-ship-latest.tgz
tar -xzf ..\\vfmail-ship-latest.tgz
Remove-Item C:\\Users\\email\\VFMailBuild\\ship.log -ErrorAction SilentlyContinue
# Write an inner build script and detach it
Set-Content -Path 'C:\\Users\\email\\VFMailBuild\\ship-runner.ps1' -Encoding UTF8 -Value \"\`\$env:PATH='C:\\Users\\email\\.cargo\\bin;'+\`\$env:PATH; \`\$env:CARGO_TARGET_DIR='C:\\Users\\email\\VFMailBuild\\target'; Set-Location 'C:\\Users\\email\\VFMailBuild\\source\\src-tauri'; & cargo tauri build --bundles nsis 2>&1 | Out-File -FilePath 'C:\\Users\\email\\VFMailBuild\\ship.log' -Encoding utf8; if (\`\$LASTEXITCODE -eq 0) { Get-Process vfmail -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 700; Start-Process 'C:\\Users\\email\\VFMailBuild\\target\\release\\bundle\\nsis\\VF Mail_${NEW_VER}_x64-setup.exe' -ArgumentList '/S' -Wait; Start-Sleep -Milliseconds 800; Start-Process 'C:\\Users\\email\\AppData\\Local\\VF Mail\\vfmail.exe'; Add-Content -Path 'C:\\Users\\email\\VFMailBuild\\ship.log' -Value 'INSTALLED_AND_LAUNCHED' }\"
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\Users\\email\\VFMailBuild\\ship-runner.ps1' -WindowStyle Hidden
Write-Host 'ship job launched'"

enc=$(python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.read().encode('utf-16-le')).decode())" <<<"$PS_SCRIPT")
payload=$(python3 -c "import json,sys; print(json.dumps({'cmd':'powershell','args':['-NoProfile','-EncodedCommand',sys.argv[1]]}))" "$enc")
curl -sS --max-time 60 -H "X-Token: $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d "$payload" "http://$AGENT_HOST/run" | head -c 300; echo

# ---- 4. wait ----
say "waiting for rebuild + install (~3-4 min)…"
POLL_PS='if(Test-Path "C:\\Users\\email\\VFMailBuild\\ship.log"){$c=Get-Content "C:\\Users\\email\\VFMailBuild\\ship.log" -Raw;if($c -match "INSTALLED_AND_LAUNCHED"){"LAUNCHED"}elseif($c -match "error\[" -or $c -match "error:"){"FAILED";$c | Select-String -Pattern "error" | Select-Object -Last 3}}'
enc2=$(python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.read().encode('utf-16-le')).decode())" <<<"$POLL_PS")
payload2=$(python3 -c "import json,sys; print(json.dumps({'cmd':'powershell','args':['-NoProfile','-EncodedCommand',sys.argv[1]]}))" "$enc2")

until R=$(curl -sS --max-time 15 -H "X-Token: $AGENT_TOKEN" -H "Content-Type: application/json" -d "$payload2" "http://$AGENT_HOST/run" 2>/dev/null); echo "$R" | grep -qE "LAUNCHED|FAILED"; do
  sleep 20
done

if echo "$R" | grep -q LAUNCHED; then
  ok "shipped v${NEW_VER} — VF Mail relaunched on Vincent's PC"
else
  warn "build FAILED — see ship.log:"
  echo "$R"
  exit 1
fi

rm -f "$PATCH_TGZ"

# ---- 5. Pull the freshly-built Windows setup.exe back to CDN --------
say "pulling built setup.exe back to CDN so end users get the new version"

# 5a. Start a one-shot HTTP receiver on this VM
RECV_PORT=18001
python3 - <<PY > /tmp/vfm-recv.log 2>&1 &
import http.server, socketserver, os
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a, **k): pass
    def do_PUT(self):
        n = int(self.headers.get('Content-Length','0'))
        with open('/tmp/vfm-latest.exe','wb') as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk: break
                f.write(chunk); left -= len(chunk)
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
with socketserver.ThreadingTCPServer(('0.0.0.0',$RECV_PORT), H) as s: s.handle_request()
PY
RECV_PID=$!
sleep 1

# 5b. Ask PC to upload the newest setup.exe
UPLOAD_PS="\$ErrorActionPreference='Stop'
\$dir = 'C:\\Users\\email\\VFMailBuild\\target\\release\\bundle\\nsis'
\$exe = Get-ChildItem \"\$dir\\*x64-setup.exe\" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Invoke-WebRequest -Method Put -InFile \$exe.FullName -Uri \"http://10.1.0.1:${RECV_PORT}/setup.exe\" -UseBasicParsing -TimeoutSec 300 | Out-Null
Write-Host UPLOADED_\$(\$exe.Name)"
enc_up=$(python3 -c "import sys,base64; print(base64.b64encode(sys.stdin.read().encode('utf-16-le')).decode())" <<<"$UPLOAD_PS")
payload_up=$(python3 -c "import json,sys; print(json.dumps({'cmd':'powershell','args':['-NoProfile','-EncodedCommand',sys.argv[1]]}))" "$enc_up")
curl -sS --max-time 60 -H "X-Token: $AGENT_TOKEN" -H "Content-Type: application/json" -d "$payload_up" "http://$AGENT_HOST/run" >/dev/null

# 5c. Wait for receiver to grab it
wait $RECV_PID 2>/dev/null || true

if [[ -f /tmp/vfm-latest.exe ]]; then
  size=$(stat -c%s /tmp/vfm-latest.exe)
  cp /tmp/vfm-latest.exe "$WORKSPACE_DIR/app/downloads/vfmail-latest-x64-setup.exe"
  sha256sum "$WORKSPACE_DIR/app/downloads/vfmail-latest-x64-setup.exe" | awk '{print $1}' > "$WORKSPACE_DIR/app/downloads/vfmail-latest-x64-setup.exe.sha256"
  ok "pulled setup.exe ($(numfmt --to=iec $size))"
  ( cd "$WORKSPACE_DIR" && npx wrangler deploy 2>&1 | tail -3 )
  ok "CDN updated: https://inbox.vfempire.com/downloads/vfmail-latest-x64-setup.exe"
  rm -f /tmp/vfm-latest.exe
else
  warn "could not pull setup.exe back to CDN (install path still works, users on old exe)"
fi
