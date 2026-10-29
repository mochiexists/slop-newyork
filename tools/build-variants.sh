#!/usr/bin/env zsh
# Build the two versions of the game into dist/ (gitignored), each a folder any static server can serve:
#
#   dist/minimal  only the repository's own runtime files: index.html, css/, js/ (about 3.3 MB, 1.45 MB gzipped).
#                 The original's idea: no assets. The car is the procedural lofted body, the engine the synthesized
#                 six-cylinder, the music streamed from YouTube.
#   dist/full     the same plus the local assets nobody commits: the tuned M3 recordings (tools/fetch-m3-sound.sh),
#                 the decoded M5 sound mod voice (tools/extract-m5-mod-sound.py) and the Sketchfab M3 Competition
#                 model (tools/prepare-m3-model.sh). Whatever of those is missing is reported and left out; the game
#                 falls back to the minimal version's car or sound for it.
#
# Usage:  tools/build-variants.sh [minimal|full|both]        (default: both)
# Serve:  python3 -m http.server 8765 --bind 127.0.0.1 --directory dist/full
set -euo pipefail

root=${0:A:h:h}
cd "$root"
which=${1:-both}

# The page's own files, as committed (a stray local file never ships)
runtime=(index.html css js LICENSE README.md)

# The assets the full version adds: the clips the engine voices load (not the mod's raw streams, which are only for
# listening) and the car model
full_assets=(
  'assets/audio/m3/*.wav'
  'assets/audio/m5mod/*.wav'
  'assets/audio/m5mod/engine/*.wav'
  'assets/models/*.glb'
)

say() { print -r -- "build-variants: $*"; }

size_report() {
  local dir=$1 raw=0 packed=0 file
  for file in $dir/**/*(.N); do
    raw=$(( raw + $(stat -f %z "$file") ))
    packed=$(( packed + $(gzip -9c "$file" | wc -c) ))
  done
  printf 'build-variants: %-14s %6.2f MB raw, %6.2f MB gzipped\n' "${dir:t}" $(( raw / 1048576.0 )) $(( packed / 1048576.0 ))
}

build() {
  local name=$1 out="$root/dist/$1"
  say "building $name into dist/$name"
  rm -rf "${out:?}"
  mkdir -p "$out"
  git ls-files -z -- $runtime | rsync -a --from0 --files-from=- ./ "$out/"
  if [[ $name == full ]]; then
    local pattern matches
    for pattern in $full_assets; do
      matches=(${~pattern}(.N))
      if (( ${#matches} == 0 )); then
        say "  missing ${pattern:h}/ (see the tools/ script that makes it); the game falls back without it"
        continue
      fi
      mkdir -p "$out/${pattern:h}"
      cp -p $matches "$out/${pattern:h}/"
      say "  + ${#matches} file(s) in ${pattern:h}/"
    done
  fi
  size_report "$out"
}

case $which in
  minimal|full) build $which ;;
  both) build minimal; build full ;;
  *) say "usage: tools/build-variants.sh [minimal|full|both]"; exit 64 ;;
esac
say "done. Serve one with: python3 -m http.server 8765 --bind 127.0.0.1 --directory dist/<version>"
