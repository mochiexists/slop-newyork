#!/usr/bin/env zsh
# prepare-m3-model.sh: the real car for swimming mode in the full build. Turns the Sketchfab download of
# "BMW m3 competition | Hassan Visuals 3D" (https://skfb.ly/pNwqZ, CC BY 4.0, credit Hassan Visuals 3D; download it as
# glTF) into assets/models/m3.glb, which js/m3-model.js loads when it is there. The model is not committed
# (assets/models/ is gitignored): run this once per checkout. Without it the game drives the procedural car.
#
#   tools/prepare-m3-model.sh ZIP              build assets/models/m3.glb unless it is already there
#   tools/prepare-m3-model.sh ZIP --force      rebuild it
#   tools/prepare-m3-model.sh ZIP --dry-run    say what would happen, touch nothing
#   tools/prepare-m3-model.sh ZIP --out FILE   write the .glb somewhere else
#
# Needs node and npm. The gltf-transform libraries (pinned below) are installed into assets/models/.build/, never
# into the repo; tools/build-m3-model.mjs is copied next to them and run there (Node resolves its imports from the
# file's own folder).
#
# What the build does (tools/build-m3-model.mjs): the download is a game-ripped car of 660k triangles in which every
# part is a skinned mesh bound to a bone, with the right wheels a mirrored copy of the left ones. It bakes the bones
# into static meshes, groups them into body, four wheels, steering wheel and lamp groups, joins and simplifies to
# ~170k triangles (meshoptimizer), shrinks textures to <= 1024 px WebP and compresses the geometry with
# EXT_meshopt_compression: ~19.6 MB zip -> ~3 MB .glb. three.js reads it with
# GLTFLoader + MeshoptDecoder from the same CDN as the rest of three (three/addons/).
#
# The zip is an untrusted download: it is only unzipped into a fresh empty folder and read as data, nothing in it
# is run. First run (2026-10-30) on the M5 laptop: npm install took 25 s from the npm cache on a phone hotspot,
# the build about 15 s. On a slow line, run it on another Mac and copy back just the .glb.

set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_DIR=${SCRIPT_DIR:h}
OUT_FILE=$REPO_DIR/assets/models/m3.glb
BUILD_DIR=$REPO_DIR/assets/models/.build
DRY_RUN=0
FORCE=0
ZIP=""
PACKAGES=(
  @gltf-transform/core@4.4.2
  @gltf-transform/extensions@4.4.2
  @gltf-transform/functions@4.4.2
  meshoptimizer@1.0.1
  sharp@0.34.5
)

say() { print -r -- "[prepare-m3-model] $*"; }
fail() { print -r -- "[prepare-m3-model] error: $*" >&2; exit 1; }

while (( $# )); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --out) shift; (( $# )) || fail "--out needs a file"; OUT_FILE=${1:A} ;;
    -h|--help) sed -n '2,10p' "${0}"; exit 0 ;;
    -*) fail "unknown option $1 (try --help)" ;;
    *) [[ -z $ZIP ]] || fail "one zip only"; ZIP=${1:A} ;;
  esac
  shift
done

[[ -n $ZIP ]] || fail "give the Sketchfab glTF zip, e.g. tools/prepare-m3-model.sh ~/Downloads/bmw_m3_competition__hassan_visuals_3d.zip"
[[ -f $ZIP ]] || fail "no such file: $ZIP"
command -v node >/dev/null || fail "node is not installed"
command -v npm >/dev/null || fail "npm is not installed"

if [[ -f $OUT_FILE && $FORCE -eq 0 ]]; then
  say "$OUT_FILE is already there ($(( $(wc -c < "$OUT_FILE") / 1024 )) KB); --force rebuilds it"
  exit 0
fi

UNZIP_DIR=$BUILD_DIR/source
if (( DRY_RUN )); then
  say "would unzip $ZIP into a fresh $UNZIP_DIR"
  say "would install ${PACKAGES[*]} into $BUILD_DIR"
  say "would run tools/build-m3-model.mjs -> $OUT_FILE"
  exit 0
fi

say "unzipping $ZIP into a fresh $UNZIP_DIR"
mkdir -p "$BUILD_DIR"
rm -rf "${BUILD_DIR:?}/source"
mkdir "$UNZIP_DIR"
unzip -q "$ZIP" -d "$UNZIP_DIR"
GLTF=$UNZIP_DIR/scene.gltf
[[ -f $GLTF ]] || fail "no scene.gltf in the zip: download the glTF version of the model"

say "installing the gltf-transform libraries into $BUILD_DIR (from the npm cache when it has them)"
[[ -f $BUILD_DIR/package.json ]] || print -r -- '{ "private": true }' > "$BUILD_DIR/package.json"
npm install --prefix "$BUILD_DIR" --prefer-offline --no-audit --no-fund --loglevel=error "${PACKAGES[@]}"

say "baking, simplifying and compressing (tools/build-m3-model.mjs)"
cp "$SCRIPT_DIR/build-m3-model.mjs" "$BUILD_DIR/build-m3-model.mjs"
mkdir -p "${OUT_FILE:h}"
LOG=$BUILD_DIR/build.log
PART=${OUT_FILE:r}.part.glb # the writer picks the format from the extension
if ! node "$BUILD_DIR/build-m3-model.mjs" "$GLTF" "$PART" > "$LOG" 2>&1; then
  cat "$LOG" >&2
  fail "the build failed (log above, also in $LOG)"
fi
mv "$PART" "$OUT_FILE"
# gltf-transform warns once per texture coordinate set it can't quantize (the game's tiled UVs) and per flat specular
# map, and two copies of libvips announce themselves on macOS: expected, so they're left in the log only
grep -v -e 'quantize: Skipping' -e 'specularTexture' -e '^objc\[' "$LOG" || true

say "done: $OUT_FILE ($(( $(wc -c < "$OUT_FILE") / 1024 )) KB). Reload the page and press 5."
