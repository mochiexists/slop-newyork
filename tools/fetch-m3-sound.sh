#!/usr/bin/env zsh
# fetch-m3-sound.sh: real engine sound for the swimming car, a tuned BMW M3 Competition (G80, S58 3.0 twin-turbo
# straight-six with a straight-pipe exhaust), cut from two YouTube recordings into short mono clips in
# assets/audio/m3/. The clips are not committed (assets/audio/ is gitignored, like the streamed music): run this
# once per checkout. Without them the game falls back to its synthesized engine.
#
#   tools/fetch-m3-sound.sh             fetch and cut whatever clip is missing
#   tools/fetch-m3-sound.sh --force     re-cut every clip
#   tools/fetch-m3-sound.sh --dry-run   say what would happen, touch nothing
#   tools/fetch-m3-sound.sh --out DIR   write the clips somewhere else
#
# Needs yt-dlp and ffmpeg (brew install yt-dlp ffmpeg). Only the few seconds around each clip are downloaded.
#
# Sources (both by CarSpotterQVS, roadside recordings without music or narration over the used spans):
#   DjWlRJsz8_E  "CRAZY LOUD BMW M3 G80 Straight Pipe - REVS And Accelerations!"
#   RnfZD_wgWCY  "Crazy Loud BMW M3 G80 at the Nürburgring - BURNOUTS AND POWERSLIDES!"
#
# The spans were found by measuring, not by ear: 0.25 s windows of level, spectral centroid, crest factor and
# autocorrelation pitch, then the harmonic spacing of each span's spectrum. A straight-six fires 3 times per
# revolution and its exhaust also carries half-orders, so every peak sits on a multiple of rpm/120 Hz:
#   idle     DjWlRJsz8_E 27.00-29.00 s  peaks 106/141/177/212/247 Hz = multiples of 35.3 Hz (firing) -> 706 rpm
#   low      DjWlRJsz8_E 51.00-53.00 s  a held rev; peaks 110.5/132.5/176.5/221/265 Hz on 22.08 Hz  -> 2650 rpm
#   high     RnfZD_wgWCY 188.00-189.10 s on the move; 332.7 Hz firing, harmonics on 55.45 Hz          -> 6654 rpm
#   crackle  DjWlRJsz8_E 362.15-363.65 s  three overrun pops (crest factor 11-13 against a -30 dB idle)
# The loops are crossfaded into themselves (the last LOOP_XFADE seconds are blended over the start), so they repeat
# without a click; swim-engine-audio.js lists the same files and rpm (M3_CLIPS).

set -euo pipefail

SCRIPT_DIR=${0:A:h}
OUT_DIR=${SCRIPT_DIR:h}/assets/audio/m3
DRY_RUN=0
FORCE=0
SAMPLE_RATE=32000 # Hz: plenty for an exhaust, and keeps the four clips around half a megabyte as 16-bit WAV
LOOP_XFADE=0.12   # s blended across each loop point
SPAN_MARGIN=1     # s downloaded either side of a clip, so the cut is not at a download boundary
SECTION_TRIES=2   # YouTube sometimes answers 403 part-way; a retry with a fresh URL usually works...
DOWNLOAD_TRIES=3  # ...and if ranged requests keep failing, the whole track (a few MB) is fetched instead

# name|video id|start s|end s|kind (loop or shot)
CLIPS=(
  "idle|DjWlRJsz8_E|27.00|29.00|loop"
  "low|DjWlRJsz8_E|51.00|53.00|loop"
  "high|RnfZD_wgWCY|188.00|189.10|loop"
  "crackle|DjWlRJsz8_E|362.15|363.65|shot"
)

say() { print -r -- "[fetch-m3-sound] $*"; }
fail() { print -r -- "[fetch-m3-sound] error: $*" >&2; exit 1; }
num() { printf '%.3f' "$1"; } # zsh prints float arithmetic as "26."; ffmpeg and yt-dlp want "26.000"

while (( $# )); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --out) shift; (( $# )) || fail "--out needs a folder"; OUT_DIR=${1:A} ;;
    -h|--help) sed -n '2,12p' "${0}"; exit 0 ;;
    *) fail "unknown option $1 (try --help)" ;;
  esac
  shift
done

for tool in yt-dlp ffmpeg; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (brew install yt-dlp ffmpeg)"
done

say "clips go to ${OUT_DIR}"
(( DRY_RUN )) || mkdir -p "$OUT_DIR"

WORK=""
cleanup() { [[ -n $WORK && -d $WORK ]] && rm -rf -- "${WORK:?}"; }
trap cleanup EXIT

# Downloads [from, to] s of a video's audio as WAV and prints "file|time the file starts at". If YouTube refuses the
# ranged request (ffmpeg fetches sections and gets 403 more often), the whole audio track is fetched once instead.
download_span() {
  local id=$1 from=$2 to=$3 target=$4 attempt full=${WORK}/${id}.full
  [[ -s ${full}.wav ]] && { print -r -- "${full}.wav|0"; return 0; }
  for attempt in $(seq 1 $SECTION_TRIES); do
    if yt-dlp --quiet --no-warnings --no-playlist -f bestaudio \
        --download-sections "*${from}-${to}" --force-keyframes-at-cuts \
        -x --audio-format wav -o "${target}.%(ext)s" "https://www.youtube.com/watch?v=${id}" >&2; then
      [[ -s ${target}.wav ]] && { print -r -- "${target}.wav|${from}"; return 0; }
    fi
    say "  section download attempt ${attempt} of ${SECTION_TRIES} failed" >&2
    sleep $(( attempt * 2 ))
  done
  for attempt in $(seq 1 $DOWNLOAD_TRIES); do
    say "  fetching the whole audio track of ${id} instead (attempt ${attempt} of ${DOWNLOAD_TRIES})" >&2
    if yt-dlp --quiet --no-warnings --no-playlist -f bestaudio -x --audio-format wav \
        -o "${full}.%(ext)s" "https://www.youtube.com/watch?v=${id}" >&2; then
      [[ -s ${full}.wav ]] && { print -r -- "${full}.wav|0"; return 0; }
    fi
    sleep $(( attempt * 2 ))
  done
  return 1
}

made=0
for clip in "${CLIPS[@]}"; do
  IFS='|' read -r name id start end kind <<< "$clip"
  output=${OUT_DIR}/${name}.wav
  if [[ -s $output && $FORCE -eq 0 ]]; then
    say "${name}: already there, keeping it (--force re-cuts)"
    continue
  fi
  from=$(num $(( start > SPAN_MARGIN ? start - SPAN_MARGIN : 0 )))
  to=$(num $(( end + SPAN_MARGIN + LOOP_XFADE )))
  if (( DRY_RUN )); then
    say "${name}: would download ${id} ${from}-${to} s and cut ${start}-${end} s as a ${kind} into ${output}"
    continue
  fi
  [[ -n $WORK ]] || WORK=$(mktemp -d -t fetch-m3-sound)
  say "${name}: downloading ${id} ${from}-${to} s"
  download=$(download_span "$id" "$from" "$to" "${WORK}/${name}") \
    || fail "could not download ${id}: YouTube answered 403 (an old yt-dlp is the usual cause: brew upgrade yt-dlp)"
  span=${download%|*}
  offset=$(num $(( start - ${download##*|} )))
  length=$(num $(( end - start )))
  # Shared clean-up: drop sub-audible rumble, mono, the clip rate, a gentle fade on one-shots.
  tidy="highpass=f=20,aresample=${SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=mono"
  if [[ $kind == loop ]]; then
    say "${name}: cutting a ${length} s loop at ${start} s, crossfading ${LOOP_XFADE} s across the loop point"
    # The loop is [start, start + length); the next LOOP_XFADE seconds fade out over its first LOOP_XFADE
    # seconds, so the sample after the loop's end follows its last one.
    ffmpeg -v error -y -i "$span" -filter_complex "\
[0]atrim=start=${offset}:end=$(num $(( offset + length + LOOP_XFADE ))),asetpts=PTS-STARTPTS,${tidy},asplit=2[a][b];\
[a]atrim=start=${length},asetpts=PTS-STARTPTS[tail];\
[b]atrim=end=${length},asetpts=PTS-STARTPTS[head];\
[tail][head]acrossfade=d=${LOOP_XFADE}:c1=qsin:c2=qsin,aformat=sample_fmts=s16[out]" \
      -map "[out]" -c:a pcm_s16le "${output}.part.wav"
  else
    say "${name}: cutting a ${length} s one-shot at ${start} s"
    ffmpeg -v error -y -i "$span" -af "atrim=start=${offset}:end=$(num $(( offset + length ))),asetpts=PTS-STARTPTS,${tidy},\
afade=t=in:d=0.01,afade=t=out:st=$(num $(( length - 0.15 ))):d=0.15,aformat=sample_fmts=s16" \
      -c:a pcm_s16le "${output}.part.wav"
  fi
  mv -f -- "${output}.part.wav" "$output"
  made=$(( made + 1 ))
  say "${name}: wrote ${output} ($(( $(wc -c < "$output") / 1024 )) KB)"
done

if (( DRY_RUN )); then
  say "dry run: nothing downloaded or written"
else
  say "done: ${made} clip(s) written; total $(du -ch "${OUT_DIR}"/*.wav 2>/dev/null | tail -1 | cut -f1)"
fi
