#!/usr/bin/env sh
set -eu

agent_repo_path="${AGENT_REPO_PATH:-$(pwd)}"
runtime_rel=".devstar/agent-runtime"
runtime_path="${DEVSTAR_AGENT_RUNTIME_PATH:-$agent_repo_path/$runtime_rel}"
runtime_url="${DEVSTAR_AGENT_RUNTIME_URL:-https://devstar.cn/devstar/agent-runtime.git}"
runtime_branch="${DEVSTAR_AGENT_RUNTIME_BRANCH:-main}"

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return 0
  fi
  echo "[INFO] Installing Git before updating Agent Runtime"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates git
    rm -rf /var/lib/apt/lists/*
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ca-certificates git
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates git
    dnf clean all
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates git
    yum clean all
  else
    echo "[ERROR] Git is required to update Agent Runtime" >&2
    return 1
  fi
}

runtime_git() {
  # DEVSTAR_TOKEN authenticates the Agent instance to the event bus, not Git.
  runtime_token="${DEVSTAR_RUNTIME_GIT_TOKEN:-${DEVSTAR_SERVICE_ACCOUNT_TOKEN:-}}"
  if [ -z "$runtime_token" ]; then
    git "$@"
    return
  fi

  runtime_username="${DEVSTAR_RUNTIME_GIT_USERNAME:-${DEVSTAR_SERVICE_ACCOUNT_USERNAME:-${GIT_USER_NAME:-oauth2}}}"
  DEVSTAR_RUNTIME_GIT_USERNAME="$runtime_username" DEVSTAR_RUNTIME_GIT_TOKEN="$runtime_token" git \
    -c credential.helper= \
    -c 'credential.helper=!f() { [ "$1" = get ] || exit 0; printf "%s\n" "username=$DEVSTAR_RUNTIME_GIT_USERNAME" "password=$DEVSTAR_RUNTIME_GIT_TOKEN"; }; f' \
    "$@"
}

update_runtime() {
  ensure_git
  if git -C "$agent_repo_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    [ -f "$agent_repo_path/.gitmodules" ]; then
    git -C "$agent_repo_path" submodule sync -- "$runtime_rel"
    if git -C "$runtime_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      runtime_git -C "$runtime_path" remote set-url origin "$runtime_url"
    fi
    runtime_git -C "$agent_repo_path" \
      -c "submodule.$runtime_rel.url=$runtime_url" \
      -c "submodule.$runtime_rel.branch=$runtime_branch" \
      submodule update --force --init --remote --recursive --depth 1 -- "$runtime_rel"
  elif [ -f "$runtime_path/bootstrap/entrypoint.sh" ]; then
    echo "[INFO] Using bundled Agent Runtime"
  else
    runtime_tmp="${runtime_path}.tmp.$$"
    rm -rf "$runtime_tmp"
    runtime_git clone --depth 1 --branch "$runtime_branch" "$runtime_url" "$runtime_tmp"
    rm -rf "$runtime_path"
    mkdir -p "$(dirname "$runtime_path")"
    mv "$runtime_tmp" "$runtime_path"
  fi

  if [ ! -f "$runtime_path/bootstrap/entrypoint.sh" ]; then
    echo "[ERROR] Agent Runtime is missing bootstrap/entrypoint.sh" >&2
    return 1
  fi
  runtime_commit=$(git -C "$runtime_path" rev-parse HEAD 2>/dev/null || true)
  runtime_commit="${runtime_commit:-${DEVSTAR_AGENT_RUNTIME_COMMIT:-bundled}}"
  DEVSTAR_AGENT_RUNTIME_COMMIT="$runtime_commit"
  export DEVSTAR_AGENT_RUNTIME_COMMIT
  echo "[INFO] Agent Runtime ready: $runtime_commit"
}

update_runtime
DEVSTAR_AGENT_RUNTIME_PATH="$runtime_path"
export DEVSTAR_AGENT_RUNTIME_PATH

ADAPTER_CMD="${ADAPTER_CMD:-node src/adapter.mjs}"
AGENT_LAUNCH_KIND="${AGENT_LAUNCH_KIND:-subscription_service}"
AGENT_REQUIREMENTS_ALPINE="${AGENT_REQUIREMENTS_ALPINE:-}"
AGENT_REQUIREMENTS_DEBIAN="${AGENT_REQUIREMENTS_DEBIAN:-}"
AGENT_REQUIREMENTS_RHEL="${AGENT_REQUIREMENTS_RHEL:-}"
AGENT_REQUIREMENTS_PIP="${AGENT_REQUIREMENTS_PIP:-}"
AGENT_REQUIREMENTS_NPM="${AGENT_REQUIREMENTS_NPM:-}"
export ADAPTER_CMD AGENT_LAUNCH_KIND
export AGENT_REQUIREMENTS_ALPINE AGENT_REQUIREMENTS_DEBIAN AGENT_REQUIREMENTS_RHEL
export AGENT_REQUIREMENTS_PIP AGENT_REQUIREMENTS_NPM

exec sh "$runtime_path/bootstrap/entrypoint.sh"
