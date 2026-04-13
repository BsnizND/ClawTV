#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
support_dir="${HOME}/Library/Application Support/ClawTV"
log_dir="${HOME}/Library/Logs/ClawTV"
launch_agent_dst="${HOME}/Library/LaunchAgents/com.clawtv.server.plist"
env_file="${support_dir}/clawtv.env"
uid="$(id -u)"

mkdir -p "${support_dir}" "${support_dir}/data" "${log_dir}" "${HOME}/Library/LaunchAgents"

if [[ ! -f "${env_file}" ]]; then
  cat > "${env_file}" <<EOF
CLAWTV_BASE_PATH=/ClawTV
CLAWTV_DATA_DIR="${support_dir}/data"
PLEX_BASE_URL=http://127.0.0.1:32400/
PORT=4390
# PLEX_TOKEN=
EOF
fi

/opt/homebrew/bin/pnpm --dir "${repo_root}" install --frozen-lockfile
/opt/homebrew/bin/pnpm --dir "${repo_root}" build

cat > "${launch_agent_dst}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.clawtv.server</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${repo_root}/scripts/runtime/run_server.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${repo_root}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/server.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/server.stderr.log</string>
  </dict>
</plist>
EOF

launchctl bootout "gui/${uid}" "${launch_agent_dst}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${uid}" "${launch_agent_dst}"
launchctl kickstart -k "gui/${uid}/com.clawtv.server"

echo "Installed ClawTV runtime."
echo "LaunchAgent: ${launch_agent_dst}"
echo "Env file: ${env_file}"
