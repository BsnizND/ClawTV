#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime_home="${CLAWTV_HOME:-${HOME}}"
support_dir="${runtime_home}/Library/Application Support/ClawTV"
env_file="${support_dir}/clawtv.env"

mkdir -p "${support_dir}"

if [[ -f "${env_file}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -z "${line}" || "${line}" == \#* ]]; then
      continue
    fi

    key="${line%%=*}"
    value="${line#*=}"

    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value#\"}"
      value="${value%\"}"
    fi

    export "${key}=${value}"
  done < "${env_file}"
fi

export CLAWTV_BASE_PATH="${CLAWTV_BASE_PATH:-/ClawTV}"
export CLAWTV_DATA_DIR="${CLAWTV_DATA_DIR:-${support_dir}/data}"
export PLEX_BASE_URL="${PLEX_BASE_URL:-http://127.0.0.1:32400/}"
export PORT="${PORT:-4390}"

mkdir -p "${CLAWTV_DATA_DIR}"

exec /opt/homebrew/bin/node "${repo_root}/apps/server/dist/index.js"
