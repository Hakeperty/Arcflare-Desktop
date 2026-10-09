#!/bin/sh
# ArcFlare Desktop installer, for Linux and macOS
#   curl -fsSL https://arcflare.net/install-desktop.sh | sh
# or, straight from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/Hakeperty/Arcflare-Desktop/main/install.sh | sh
#
# (The same file lives in both places: ArcFlare/public/install-desktop.sh and
# Arcflare-Desktop/install.sh. Change both.)
#
# Downloads the latest release from github.com/Hakeperty/Arcflare-Desktop,
# checks it against the release's SHA256SUMS, and installs it the way your
# system expects:
#   pacman (Arch, Manjaro, EndeavourOS)  the .pacman, with pacman -U
#   apt (Debian, Ubuntu, Mint)           the .deb, with apt-get install
#   any other Linux                      the AppImage in your home folder, no root
#   macOS                                ArcFlare.app in /Applications
#
# Then it gets llama.cpp, which the app needs to download and run language
# models: with Homebrew on a Mac that has it, otherwise the official prebuilt
# release from github.com/ggml-org/llama.cpp into ~/llamacpp (where the app
# looks). ARCFLARE_LLAMA=0 skips that.
#
# Choose for yourself with ARCFLARE_DESKTOP=pacman|deb|appimage, or remove an
# AppImage install with ARCFLARE_DESKTOP=uninstall:
#   curl -fsSL https://arcflare.net/install-desktop.sh | ARCFLARE_DESKTOP=appimage sh
#
# Windows: download ArcFlare-Setup-x64.exe from https://arcflare.net/desktop
#
# Everything is inside main(), so a download cut off halfway runs nothing.

main() {
  set -eu

  REPO="https://github.com/Hakeperty/Arcflare-Desktop"
  BASE="${ARCFLARE_DESKTOP_BASE:-$REPO/releases/latest/download}"
  # HTTPS only, unless pointed at another source (a mirror, or a test server).
  PROTO="--proto =https --tlsv1.2"
  [ -z "${ARCFLARE_DESKTOP_BASE:-}" ] || PROTO=""
  WANT="${ARCFLARE_DESKTOP:-}"

  command -v curl >/dev/null 2>&1 || die "this installer needs curl"
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t arcflare)
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 130' INT TERM
  # apt reads the .deb as its own unprivileged user.
  chmod 755 "$TMP"

  say "ArcFlare Desktop installer"

  case "$(uname -s)" in
    Linux) linux ;;
    Darwin) macos ;;
    MINGW* | MSYS* | CYGWIN*)
      die "on Windows, download the installer: $REPO/releases/latest/download/ArcFlare-Setup-x64.exe" ;;
    *) die "no ArcFlare Desktop build for $(uname -s); see $REPO/releases" ;;
  esac
}

say() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() { printf '  x %s\n' "$*" >&2; exit 1; }

# Root for package managers: nothing if we are root, else sudo or doas.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  elif command -v doas >/dev/null 2>&1; then doas "$@"
  else die "installing a system package needs root: run this as root, or install sudo"
  fi
}

# fetch <file>: download one release asset into $TMP. Fails quietly (status 1)
# on a missing file, so the caller can fall back.
fetch() {
  say "downloading $1"
  curl -fL $PROTO --retry 3 --progress-bar -o "$TMP/$1" "$BASE/$1" || {
    rm -f "$TMP/$1"
    return 1
  }
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""
  fi
}

# verify <file>: refuse a download whose hash doesn't match SHA256SUMS.
# Releases before SHA256SUMS existed are installed with a warning.
verify() {
  if [ ! -f "$TMP/SHA256SUMS" ]; then
    curl -fsSL $PROTO -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" 2>/dev/null || : > "$TMP/SHA256SUMS"
  fi
  want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/SHA256SUMS")
  if [ -z "$want" ]; then
    warn "this release publishes no checksum for $1; installing it unverified"
    return 0
  fi
  got=$(sha256 "$TMP/$1")
  [ -n "$got" ] || die "no sha256sum or shasum to check the download with"
  [ "$got" = "$want" ] || die "$1 does not match the release's SHA256SUMS; not installing it"
  say "checksum ok"
}

# ------------------------------------------------------------------- linux ----

linux() {
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) die "ArcFlare Desktop is built for x86_64 only so far; this machine is $(uname -m)" ;;
  esac

  if [ -z "$WANT" ]; then
    if command -v pacman >/dev/null 2>&1; then WANT=pacman
    elif command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then WANT=deb
    else WANT=appimage
    fi
    AUTO=1
  else
    AUTO=0
  fi

  case "$WANT" in
    pacman) install_pacman ;;
    deb) install_deb ;;
    appimage) install_appimage ;;
    uninstall) uninstall_appimage ;;
    *) die "ARCFLARE_DESKTOP must be pacman, deb, appimage or uninstall (got \"$WANT\")" ;;
  esac
}

install_pacman() {
  f=ArcFlare-linux-x64.pacman
  if ! fetch "$f"; then
    [ "$AUTO" -eq 1 ] || die "the latest release has no $f"
    warn "the latest release has no .pacman yet; installing the AppImage instead"
    install_appimage
    return
  fi
  verify "$f"
  say "installing with pacman (asks for your password)"
  # --noconfirm: under `curl | sh` stdin is this script, not a keyboard.
  as_root pacman -U --noconfirm "$TMP/$f"
  install_llama
  done_msg "arcflare-desktop" "sudo pacman -R arcflare-desktop"
}

install_deb() {
  f=ArcFlare-linux-amd64.deb
  fetch "$f" || die "could not download $f"
  verify "$f"
  chmod 644 "$TMP/$f"
  say "installing with apt (asks for your password)"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$TMP/$f" </dev/null
  install_llama
  done_msg "arcflare-desktop" "sudo apt remove arcflare-desktop"
}

APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/arcflare-desktop"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/arcflare-desktop.desktop"
BIN_LINK="$HOME/.local/bin/arcflare-desktop"

install_appimage() {
  f=ArcFlare-linux-x86_64.AppImage
  fetch "$f" || die "could not download $f"
  verify "$f"
  mkdir -p "$APP_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$BIN_LINK")"
  # Named after the app, not the version: the app updates this file in place.
  mv -f "$TMP/$f" "$APP_DIR/ArcFlare.AppImage"
  chmod 755 "$APP_DIR/ArcFlare.AppImage"
  ln -sf "$APP_DIR/ArcFlare.AppImage" "$BIN_LINK"
  icon="$APP_DIR/icon.png"
  curl -fsSL --proto '=https' -o "$icon" "https://raw.githubusercontent.com/Hakeperty/Arcflare-Desktop/HEAD/build/icon.png" 2>/dev/null || icon="arcflare-desktop"
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=ArcFlare
Comment=Chat, studio and coding agents for local models
Exec="$APP_DIR/ArcFlare.AppImage" %U
Icon=$icon
Terminal=false
Categories=Development;
StartupWMClass=ArcFlare
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true

  # AppImages mount themselves with FUSE 2, which newer distros leave out.
  if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; } && ! [ -e /usr/lib/libfuse.so.2 ] && ! [ -e /usr/lib64/libfuse.so.2 ]; then
    warn "AppImages need FUSE 2 (libfuse2 / fuse2 / fuse-libs); install it if ArcFlare won't start"
  fi
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "$HOME/.local/bin is not on your PATH; start ArcFlare from the app menu, or add it" ;;
  esac
  install_llama
  done_msg "arcflare-desktop" "curl -fsSL https://arcflare.net/install-desktop.sh | ARCFLARE_DESKTOP=uninstall sh"
}

uninstall_appimage() {
  removed=0
  for p in "$APP_DIR" "$DESKTOP_FILE" "$BIN_LINK"; do
    if [ -e "$p" ] || [ -L "$p" ]; then rm -rf "$p"; removed=1; fi
  done
  [ "$removed" -eq 1 ] && say "removed the ArcFlare AppImage" || say "no AppImage install found in $APP_DIR"
  if command -v pacman >/dev/null 2>&1 && pacman -Q arcflare-desktop >/dev/null 2>&1; then
    say "the pacman package is still installed: sudo pacman -R arcflare-desktop"
  fi
  if command -v dpkg >/dev/null 2>&1 && dpkg -s arcflare-desktop >/dev/null 2>&1; then
    say "the .deb is still installed: sudo apt remove arcflare-desktop"
  fi
  say "your models, chats and settings in ~/.arcflare were left alone"
}

# ------------------------------------------------------------------- macos ----

macos() {
  # A Terminal running under Rosetta reports x86_64 on Apple silicon; ask the hardware.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then arch=arm64; else arch=x64; fi
  case "$WANT" in "" ) ;; *) die "ARCFLARE_DESKTOP only applies on Linux" ;; esac
  if pgrep -x ArcFlare >/dev/null 2>&1; then die "quit ArcFlare first, then run this again"; fi

  f="ArcFlare-mac-$arch.dmg"
  fetch "$f" || die "could not download $f"
  verify "$f"

  mnt="$TMP/mnt"
  mkdir -p "$mnt"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mnt" "$TMP/$f" || die "could not open $f"
  app=$(find "$mnt" -maxdepth 1 -name '*.app' | head -n 1)
  if [ -z "$app" ]; then hdiutil detach -quiet "$mnt" || true; die "no app inside $f"; fi

  dest=/Applications
  if [ ! -w "$dest" ]; then dest="$HOME/Applications"; mkdir -p "$dest"; fi
  say "installing to $dest"
  rm -rf "$dest/ArcFlare.app"
  ditto "$app" "$dest/ArcFlare.app"
  hdiutil detach -quiet "$mnt" || true
  # curl doesn't quarantine downloads, but clear it in case something else did.
  xattr -dr com.apple.quarantine "$dest/ArcFlare.app" 2>/dev/null || true

  install_llama
  say ""
  say "ArcFlare Desktop is installed: $dest/ArcFlare.app"
  say "open it from Launchpad, or: open -a ArcFlare"
  say "updates: the app tells you when one is out; run this again to install it"
}

# ---------------------------------------------------------------- llama.cpp --
#
# The app runs and downloads language models through llama.cpp's llama-server.
# A failure here never undoes the app install: the app can fetch llama.cpp
# itself later (Home -> download llama.cpp), so this only warns.

LLAMA_DIR="$HOME/llamacpp"
LLAMA_API="https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"

have_llama() {
  command -v llama-server >/dev/null 2>&1 && return 0
  for p in /opt/homebrew/bin/llama-server /usr/local/bin/llama-server "$LLAMA_DIR/llama-server"; do
    [ -x "$p" ] && return 0
  done
  return 1
}

# llama_asset <release.json> <name-fragment>: "url digest" of the first zip or
# tar.gz asset whose name contains the fragment. JSON without a JSON parser:
# split on commas and braces, and start a new asset at each asset "url".
llama_asset() {
  tr ',{}' '\n\n\n' < "$1" | awk -v want="$2" '
    function val(s) { sub(/^[^:]*: *"/, "", s); sub(/".*$/, "", s); return s }
    function emit() {
      if (!done && n != "" && index(n, want) > 0 && (n ~ /\.zip$/ || n ~ /\.tar\.gz$/) && u != "") { print u, d; done = 1 }
    }
    /"url": *"https:\/\/api\.github\.com\/repos\/[^"]*\/releases\/assets\// { emit(); n = ""; d = ""; u = "" }
    /"name": *"/ { if (n == "") n = val($0) }
    /"digest": *"/ { d = val($0) }
    /"browser_download_url": *"/ { u = val($0) }
    END { emit() }'
}

install_llama() {
  [ "${ARCFLARE_LLAMA:-1}" != "0" ] || return 0
  if have_llama; then say "llama.cpp: already installed"; return 0; fi

  if [ "$(uname -s)" = Darwin ]; then
    brew=$(command -v brew 2>/dev/null || true)
    [ -n "$brew" ] || for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && brew=$b; done
    if [ -n "$brew" ]; then
      say "installing llama.cpp with Homebrew"
      if "$brew" install llama.cpp </dev/null; then say "llama.cpp: installed"; return 0; fi
      warn "brew install llama.cpp failed; trying llama.cpp's own download"
    fi
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then frags="-bin-macos-arm64."; else frags="-bin-macos-x64."; fi
  else
    # The Vulkan build needs the Vulkan loader; without it, the CPU build.
    if { ldconfig -p 2>/dev/null | grep -q 'libvulkan\.so\.1'; } || [ -e /usr/lib/libvulkan.so.1 ]; then
      frags="-bin-ubuntu-vulkan-x64. -bin-ubuntu-x64."
    else
      frags="-bin-ubuntu-x64."
    fi
  fi

  say "getting llama.cpp (the engine that runs language models)"
  curl -fsSL ${LLAMA_PROTO--proto =https} -H "Accept: application/vnd.github+json" -o "$TMP/llama.json" "${ARCFLARE_LLAMA_API:-$LLAMA_API}" 2>/dev/null || {
    warn "couldn't reach GitHub for llama.cpp; open ArcFlare and press \"download llama.cpp\" on Home"
    return 0
  }
  pick=""
  for fr in $frags; do
    pick=$(llama_asset "$TMP/llama.json" "$fr")
    [ -z "$pick" ] || break
  done
  if [ -z "$pick" ]; then warn "no llama.cpp build for this machine in the latest release"; return 0; fi
  url=${pick%% *}
  digest=${pick#* }
  digest=${digest#sha256:}
  name=${url##*/}

  say "downloading $name"
  if ! curl -fL ${LLAMA_PROTO--proto =https} --retry 3 --progress-bar -o "$TMP/$name" "$url"; then
    warn "llama.cpp download failed; open ArcFlare and press \"download llama.cpp\" on Home"
    return 0
  fi
  if [ -n "$digest" ] && [ "$digest" != "$url" ]; then
    got=$(sha256 "$TMP/$name")
    if [ "$got" != "$digest" ]; then warn "$name does not match its published sha256; not installing it"; return 0; fi
    say "checksum ok"
  fi

  mkdir -p "$TMP/llama"
  case "$name" in
    *.zip)
      if command -v ditto >/dev/null 2>&1; then ditto -x -k "$TMP/$name" "$TMP/llama"
      else unzip -q "$TMP/$name" -d "$TMP/llama"; fi ;;
    *) tar -xzf "$TMP/$name" -C "$TMP/llama" ;;
  esac || { warn "couldn't unpack $name"; return 0; }
  server=$(find "$TMP/llama" -type f -name llama-server | head -n 1)
  if [ -z "$server" ]; then warn "no llama-server inside $name"; return 0; fi

  # Everything next to llama-server: its libraries sit beside it.
  mkdir -p "$LLAMA_DIR"
  if command -v ditto >/dev/null 2>&1; then ditto "$(dirname "$server")" "$LLAMA_DIR"
  else cp -R "$(dirname "$server")/." "$LLAMA_DIR/"; fi
  chmod 755 "$LLAMA_DIR/llama-server" 2>/dev/null || true
  [ "$(uname -s)" != Darwin ] || xattr -dr com.apple.quarantine "$LLAMA_DIR" 2>/dev/null || true
  if "$LLAMA_DIR/llama-server" --version >/dev/null 2>&1; then
    say "llama.cpp: installed in $LLAMA_DIR"
  else
    warn "llama.cpp is in $LLAMA_DIR but didn't start; the app will say what's missing"
  fi
}

done_msg() {
  say ""
  say "ArcFlare Desktop is installed. Open it from your app menu, or run: $1"
  say "to remove it: $2"
}

main "$@"
