#!/usr/bin/env bash
#
# vsx installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/mkuchak/vsx/main/install.sh | bash
#
# Installs the latest vsx release, or updates an existing install to it. Re-run
# this exact command to update — it compares the installed version against the
# latest release and no-ops when already current.
#
# The release artifact is a single platform-independent runtime package
# (`vsx-<version>.tar.gz`, see scripts/BUILD_NOTES.md): app source + a POSIX-sh
# launcher, no node_modules. This script unpacks it to ~/.vsx/<version>/, runs
# `bun install --production --frozen-lockfile` there to pull the correct native
# @opentui dep for the target, and symlinks the launcher onto PATH. No sudo.
#
# Environment overrides:
#   VSX_VERSION       pin a specific release tag (e.g. v0.1.0) instead of latest
#   VSX_INSTALL_DIR   where the `vsx` symlink goes (default: ~/.local/bin)
#
set -euo pipefail

REPO="mkuchak/vsx"
API_LATEST="https://api.github.com/repos/${REPO}/releases/latest"
VSX_HOME="${HOME}/.vsx"
VSX_INSTALL_DIR="${VSX_INSTALL_DIR:-${HOME}/.local/bin}"

# ── output helpers ──────────────────────────────────────────────────────────

info()  { printf '  %s\n' "$*"; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ── pure, unit-tested helpers ───────────────────────────────────────────────

# Map `uname -s`/`uname -m` to a "<os>-<arch>" label, or fail with a clear
# message on an unsupported platform. The release is platform-independent, so
# this exists to reject Windows/unknown targets up front, not to pick a
# download. Echoes the label on success.
detect_platform() {
  local kernel machine os arch
  kernel="$(uname -s)"
  machine="$(uname -m)"

  case "$kernel" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "Windows is not supported. Use WSL2 (a Linux shell) and re-run this installer there." ;;
    *)
      die "unsupported OS '${kernel}'. vsx supports macOS (Darwin) and Linux." ;;
  esac

  case "$machine" in
    x86_64 | amd64)  arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
      die "unsupported architecture '${machine}'. vsx supports x86_64 and arm64." ;;
  esac

  printf '%s-%s\n' "$os" "$arch"
}

# Extract `tag_name` from a GitHub release JSON payload on stdin, without jq
# (jq may be absent on the target). Echoes e.g. `v0.1.0`.
parse_latest_tag() {
  grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/'
}

# Strip a leading `v` from a release tag → the bare semver used in the artifact
# filename and printed by `vsx --version`. `v0.1.0` → `0.1.0`.
tag_to_version() { printf '%s\n' "${1#v}"; }

# Pull the semver out of `vsx --version` output (`vsx 0.1.0` → `0.1.0`).
parse_version_output() { printf '%s\n' "$1" | awk '{print $NF}'; }

# Name of the sha256 checksum tool available on this host (`sha256sum` on Linux,
# `shasum -a 256` on macOS). Fails if neither exists.
sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256sum\n'
  elif command -v shasum >/dev/null 2>&1; then
    printf 'shasum -a 256\n'
  else
    return 1
  fi
}

# Verify <dir>/<artifact> against the checksum for <artifact> in <sumsfile>.
# Only the artifact's own line is checked (the release SHA256SUMS may list other
# files), so a mismatch or a missing line both fail. Returns non-zero on failure.
verify_checksum() {
  local dir="$1" artifact="$2" sums="$3" tool line
  tool="$(sha256_tool)" || die "no sha256 tool found (need sha256sum or shasum)."
  line="$(grep " ${artifact}\$" "$sums" || true)"
  [ -n "$line" ] || return 1
  ( cd "$dir" && printf '%s\n' "$line" | $tool -c - >/dev/null 2>&1 )
}

# Print the PATH-fixup line for the user's shell. fish uses `fish_add_path`;
# everything else gets a POSIX `export`. `$1` is the dir to add.
path_hint() {
  local dir="$1" shell
  shell="$(basename -- "${SHELL:-}")"
  if [ "$shell" = "fish" ]; then
    printf 'fish_add_path %s\n' "$dir"
  else
    # $PATH is meant literally here — the user pastes this into their shell,
    # where it expands.
    # shellcheck disable=SC2016
    printf 'export PATH="%s:$PATH"\n' "$dir"
  fi
}

# ── network / filesystem (thin wrappers, not unit-tested) ────────────────────

# curl-or-wget a URL to a file.
download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    die "need curl or wget to download vsx."
  fi
}

# curl-or-wget a URL to stdout (for the GitHub API).
fetch() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    die "need curl or wget to reach the GitHub API."
  fi
}

# Resolve the tag to install: VSX_VERSION override, else the latest release.
resolve_tag() {
  if [ -n "${VSX_VERSION:-}" ]; then
    printf '%s\n' "$VSX_VERSION"
    return
  fi
  local tag
  tag="$(fetch "$API_LATEST" | parse_latest_tag)" \
    || die "could not reach the GitHub API to find the latest release."
  [ -n "$tag" ] || die "could not determine the latest release tag (is the repo public yet?)."
  printf '%s\n' "$tag"
}

# Ensure a `bun` runtime exists; install the official one if missing. Echoes the
# bun binary path to use.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return
  fi
  step "Bun runtime not found — installing it (bun.sh/install)…" >&2
  curl -fsSL https://bun.sh/install | bash >&2
  local bun="${HOME}/.bun/bin/bun"
  [ -x "$bun" ] || die "Bun install did not produce ${bun}."
  printf '%s\n' "$bun"
}

# Keep only the current + previous version dirs under ~/.vsx, newest by version.
prune_versions() {
  [ -d "$VSX_HOME" ] || return 0
  local names old dir
  # Collect the version dir basenames (skip the reserved `support` dir), sort
  # newest-first, then drop the two we keep and remove the rest.
  names=""
  for dir in "$VSX_HOME"/*/; do
    [ -d "$dir" ] || continue
    dir="$(basename -- "$dir")"
    [ "$dir" = "support" ] && continue
    names+="${dir}"$'\n'
  done
  old="$(printf '%s' "$names" | sort -Vr | tail -n +3)"
  [ -n "$old" ] || return 0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    rm -rf -- "${VSX_HOME:?}/${dir}"
    info "pruned old version ${dir}"
  done <<< "$old"
}

# ── main flow ───────────────────────────────────────────────────────────────

main() {
  step "vsx installer"

  local platform tag version
  platform="$(detect_platform)"
  info "platform: ${platform}"

  tag="$(resolve_tag)"
  version="$(tag_to_version "$tag")"
  info "latest release: ${tag}"

  # Idempotent update: already on this version → nothing to do.
  if command -v vsx >/dev/null 2>&1; then
    local current
    current="$(parse_version_output "$(vsx --version 2>/dev/null || true)")"
    if [ "$current" = "$version" ]; then
      info "vsx ${version} is already installed and up to date."
      return 0
    fi
    info "updating vsx ${current:-<unknown>} → ${version}"
  fi

  local artifact base tmp
  artifact="vsx-${version}.tar.gz"
  base="https://github.com/${REPO}/releases/download/${tag}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  step "Downloading ${artifact}…"
  download "${base}/${artifact}" "${tmp}/${artifact}"
  download "${base}/SHA256SUMS" "${tmp}/SHA256SUMS"

  step "Verifying checksum…"
  verify_checksum "$tmp" "$artifact" "${tmp}/SHA256SUMS" \
    || die "checksum verification failed for ${artifact}."
  info "checksum OK"

  local target="${VSX_HOME}/${version}"
  step "Installing to ${target}…"
  rm -rf -- "$target"
  mkdir -p "$target"
  tar -xzf "${tmp}/${artifact}" -C "$target"

  local bun
  bun="$(ensure_bun)"

  step "Installing dependencies (bun install --production)…"
  ( cd "$target" && "$bun" install --frozen-lockfile --production )

  mkdir -p "$VSX_INSTALL_DIR"
  ln -sf "${target}/bin/vsx" "${VSX_INSTALL_DIR}/vsx"
  info "linked ${VSX_INSTALL_DIR}/vsx → ${target}/bin/vsx"

  prune_versions

  step "vsx ${version} installed."
  info "location: ${target}"
  info "launcher: ${VSX_INSTALL_DIR}/vsx"
  info "update:   re-run the install command any time to get the newest release."

  case ":${PATH}:" in
    *":${VSX_INSTALL_DIR}:"*) : ;;
    *)
      step "Add ${VSX_INSTALL_DIR} to your PATH:"
      info "$(path_hint "$VSX_INSTALL_DIR")" ;;
  esac
}

# Source guard: allows the test suite to source this file and call the pure
# helpers without running the installer.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
