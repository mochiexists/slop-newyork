#!/usr/bin/env zsh
# encode-sounds.sh: shrinks the engine voice's WAVs for the full build. tools/fetch-m3-sound.sh and
# tools/extract-m5-mod-sound.py write WAVs into assets/audio/ (gitignored); this writes a compressed copy next to each
# clip the voice plays, and js/swim-engine-audio.js loads that copy first (falling back to the WAV when it isn't there
# or the browser can't decode it). tools/build-variants.sh ships the compressed copy instead of the WAV.
#
#   tools/encode-sounds.sh             encode every clip that has no compressed copy yet
#   tools/encode-sounds.sh --force     encode them all again
#   tools/encode-sounds.sh --dry-run   say what would happen, touch nothing
#
# Loops (assets/audio/m3/{idle,low,high}.wav, assets/audio/m5mod/engine/*.wav) become FLAC: lossless, so a decoded loop
# has the WAV's exact samples and length and loops without a seam. A lossy codec pads the start and end of a stream
# (Opus pre-skip, AAC priming) and browsers don't all trim it in decodeAudioData, which would click at every loop.
# One-shots (assets/audio/m3/crackle.wav, assets/audio/m5mod/{pop,burble,bang}-N.wav) become Opus in WebM, which
# Chrome and Safari 17.4+ both decode: they play from their start or from a random offset, so a few ms of padding
# doesn't matter, and Opus is a sixth of FLAC's size.
#
# Needs ffmpeg (with libopus) and flac (brew install ffmpeg flac). ffmpeg's own FLAC muxer pads the file with ~8 KB of
# seek table, so FLAC goes through the flac tool.

set -euo pipefail

root=${0:A:h:h}
audio=$root/assets/audio
dry_run=0
force=0
# Opus bit rate for the one-shots: a pop is ~1.5 KB at this rate, so there's no point in going lower
opus_bitrate=64k

say() { print -r -- "[encode-sounds] $*"; }
fail() { print -r -- "[encode-sounds] error: $*" >&2; exit 1; }

while (( $# )); do
  case $1 in
    --dry-run) dry_run=1 ;;
    --force) force=1 ;;
    -h|--help) sed -n '2,11p' "${0}"; exit 0 ;;
    *) fail "unknown option $1 (try --help)" ;;
  esac
  shift
done

loops=($audio/m3/{idle,low,high}.wav(.N) $audio/m5mod/engine/*.wav(.N))
shots=($audio/m3/crackle.wav(.N) $audio/m5mod/{pop,burble,bang}-*.wav(.N))
(( ${#loops} + ${#shots} )) || fail "no clips in $audio: run tools/fetch-m3-sound.sh or tools/extract-m5-mod-sound.py first"
if (( ! dry_run )); then
  command -v flac >/dev/null || fail "flac is not installed (brew install flac)"
  command -v ffmpeg >/dev/null || fail "ffmpeg is not installed (brew install ffmpeg)"
fi

# encode WAV OUT KIND: writes OUT through a .part file, so a failed run never leaves half a clip behind
encode() {
  local wav=$1 out=$2 kind=$3 part=${2:r}.part.${2:e}
  if [[ -f $out && $force -eq 0 ]]; then
    return
  fi
  if (( dry_run )); then
    say "would encode ${wav#$root/} -> ${out:t} ($kind)"
    return
  fi
  if [[ $kind == loop ]]; then
    # (the M3 clips carry a LIST chunk flac warns it drops: that's only the tagging tool's name)
    flac --silent --force --best --no-padding --no-seektable --output-name="$part" "$wav" \
      2> >(grep -v "skipping unknown chunk 'LIST'" >&2)
  else
    ffmpeg -v error -y -i "$wav" -map_metadata -1 -c:a libopus -b:a $opus_bitrate -ac 1 -f webm "$part"
  fi
  mv "$part" "$out"
  say "${out#$root/}: $(( $(wc -c < "$wav") / 1024 )) KB -> $(( $(wc -c < "$out") / 1024 )) KB"
}

for wav in $loops; do encode "$wav" "${wav:r}.flac" loop; done
for wav in $shots; do encode "$wav" "${wav:r}.webm" shot; done
say "done"
