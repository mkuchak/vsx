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
RELEASES_LATEST="https://github.com/${REPO}/releases/latest"
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

# Extract the tag from the URL github.com redirects /releases/latest to
# (https://github.com/<repo>/releases/tag/<tag> → <tag>). Echoes nothing when
# the URL is not a tag URL — e.g. an un-redirected /releases/latest on a repo
# with no published releases. Assumes vsx-style tags (vX.Y.Z — no "/" or
# URL-encoded characters in the tag).
parse_tag_from_release_url() {
  case "$1" in
    */releases/tag/?*) printf '%s\n' "${1##*/}" ;;
  esac
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
  # Literal suffix match via a case pattern (not grep as a regex) — `artifact`
  # can contain dots that would otherwise act as regex wildcards.
  line=""
  while IFS= read -r candidate || [ -n "$candidate" ]; do
    case "$candidate" in
      *"  ${artifact}") line="$candidate" ;;
    esac
  done < "$sums"
  [ -n "$line" ] || return 1
  # GNU `sha256sum -c` tolerates a malformed line (prints only a WARNING and
  # exits 0); macOS `shasum -a 256 -c` rejects it (exits 1). Validate the hash
  # shape ourselves first so both tools fail closed identically on a truncated
  # or corrupted SHA256SUMS download.
  [[ "$line" =~ ^[0-9a-f]{64}[[:space:]] ]] || return 1
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
    curl --retry 2 -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    die "need curl or wget to download vsx."
  fi
}

# HEAD-request a URL following redirects; echo "<http_code> <final_url>".
# Returns non-zero only on a transport-level failure — HTTP error statuses are
# DATA here (resolve_tag branches on them). Branching on status codes instead
# of curl exit codes also sidesteps a curl quirk: over HTTP/2, `--fail` reports
# an HTTP 4xx as exit 56 (CURLE_RECV_ERROR) rather than 22, so exit-code
# branching misclassifies server answers as network failures.
probe_redirect() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --retry 2 -sSLI -o /dev/null -w '%{http_code} %{url_effective}' "$url"
  elif command -v wget >/dev/null 2>&1; then
    # wget has no %{url_effective}: --spider -S prints each hop's headers on
    # stderr; the last HTTP status line is the final answer and the last
    # Location header is the final URL (absent when nothing redirected).
    local out code final
    out="$(wget --spider -S "$url" 2>&1)" || true
    code="$(printf '%s\n' "$out" | awk '/^ *HTTP\// { c = $2 } END { print c }')"
    final="$(printf '%s\n' "$out" | awk '/^ *Location: / { l = $2 } END { print l }')"
    [ -n "$code" ] || return 1
    printf '%s %s' "$code" "${final:-$url}"
  else
    die "need curl or wget to reach GitHub."
  fi
}

# Resolve the tag to install: VSX_VERSION override, else whatever tag
# github.com's /releases/latest page redirects to. That redirect is served by
# the website, NOT api.github.com — the API's unauthenticated quota (60
# requests/hour, shared by every tool behind the caller's public IP) made this
# exact lookup 403 in the field. The website endpoint has no such budget, needs
# no token, and still fails loud and clear (404) when the repo has no releases
# or moved.
resolve_tag() {
  if [ -n "${VSX_VERSION:-}" ]; then
    printf '%s\n' "$VSX_VERSION"
    return
  fi
  local probe code final tag
  probe="$(probe_redirect "$RELEASES_LATEST")" \
    || die "could not reach github.com to resolve the latest release — check your network."
  code="${probe%% *}"
  final="${probe#* }"
  if [ "$code" = "404" ]; then
    die "no release found at ${RELEASES_LATEST} (no releases published yet, or the repo moved)."
  fi
  if [ "$code" != "200" ]; then
    die "github.com answered HTTP ${code} while resolving the latest release — try again shortly."
  fi
  tag="$(parse_tag_from_release_url "$final")"
  [ -n "$tag" ] || die "could not parse a release tag from ${final}."
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
  curl --retry 2 -fsSL https://bun.sh/install | bash >&2
  local bun="${HOME}/.bun/bin/bun"
  [ -x "$bun" ] || die "Bun install did not produce ${bun}."
  printf '%s\n' "$bun"
}

# Keep the just-installed version PLUS the two newest OTHER version dirs under
# ~/.vsx. `keep_version` is always excluded from the delete set — otherwise a
# VSX_VERSION-pinned downgrade (installing an older release while newer ones
# already sit on disk) would prune the very version it just symlinked to.
prune_versions() {
  local keep_version="$1"
  [ -d "$VSX_HOME" ] || return 0
  local names old dir
  # Collect the version dir basenames (skip the reserved `support` dir and the
  # just-installed version), sort newest-first, then drop the two we keep and
  # remove the rest.
  names=""
  for dir in "$VSX_HOME"/*/; do
    [ -d "$dir" ] || continue
    dir="$(basename -- "$dir")"
    [ "$dir" = "support" ] && continue
    [ "$dir" = "$keep_version" ] && continue
    names+="${dir}"$'\n'
  done
  old="$(printf '%s' "$names" | sort -Vr | tail -n +3)"
  [ -n "$old" ] || return 0
  while IFS= read -r dir || [ -n "$dir" ]; do
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

  local artifact base
  artifact="vsx-${version}.tar.gz"
  base="https://github.com/${REPO}/releases/download/${tag}"
  # Not `local`: the EXIT trap fires at the real end of the script's process,
  # after main() has already returned and this variable would be out of scope
  # — under `set -u` that's an unbound-variable error, not a silent no-op.
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

  local bun_was_missing=false
  command -v bun >/dev/null 2>&1 || bun_was_missing=true
  local bun
  bun="$(ensure_bun)"

  step "Installing dependencies (bun install --production)…"
  ( cd "$target" && "$bun" install --frozen-lockfile --production )

  mkdir -p "$VSX_INSTALL_DIR"
  ln -sf "${target}/bin/vsx" "${VSX_INSTALL_DIR}/vsx"
  info "linked ${VSX_INSTALL_DIR}/vsx → ${target}/bin/vsx"

  prune_versions "$version"

  step "vsx ${version} installed."
  info "location: ${target}"
  info "launcher: ${VSX_INSTALL_DIR}/vsx"
  info "update:   re-run the install command any time to get the newest release."
  info "restart any running vsx to pick up the new version."

  case ":${PATH}:" in
    *":${VSX_INSTALL_DIR}:"*) : ;;
    *)
      step "Add ${VSX_INSTALL_DIR} to your PATH:"
      info "$(path_hint "$VSX_INSTALL_DIR")" ;;
  esac

  if [ "$bun_was_missing" = true ]; then
    step "Bun was just installed — add it to your PATH too:"
    info "$(path_hint "${HOME}/.bun/bin")"
  fi
}

# Source guard: allows the test suite to source this file and call the pure
# helpers without running the installer.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
