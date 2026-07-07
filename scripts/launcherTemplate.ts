// POSIX-sh launcher template embedded into the release tarball at
// bin/vsx (see build-release.ts). Resolves its own real path (following the
// PATH symlink the installer creates) so `../src/main.tsx` points inside
// ~/.vsx/<version>/, then execs the packaged entry with a bun runtime —
// falling back to `~/.bun/bin/bun` when `bun` isn't on PATH yet (e.g.
// immediately after ensure_bun installed it fresh, in the same shell that ran
// the installer). Kept in its own module (rather than inline in
// build-release.ts) so tests can import the template without triggering that
// script's unconditional `await main()`.
export const LAUNCHER = `#!/bin/sh
# vsx launcher — installed at ~/.vsx/<version>/bin/vsx and symlinked onto PATH.
target="$0"
while [ -L "$target" ]; do
  link=$(readlink "$target")
  case "$link" in
    /*) target="$link" ;;
    *) target="$(dirname "$target")/$link" ;;
  esac
done
dir=$(CDPATH= cd -- "$(dirname -- "$target")" && pwd)
if command -v bun >/dev/null 2>&1; then
  bun_bin="bun"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  bun_bin="$HOME/.bun/bin/bun"
else
  echo "vsx: bun runtime not found on PATH or at \\$HOME/.bun/bin/bun" >&2
  echo "vsx: install it from https://bun.sh, or re-run the vsx installer" >&2
  exit 1
fi
exec "$bun_bin" "$dir/../src/main.tsx" "$@"
`
