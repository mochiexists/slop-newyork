#!/usr/bin/env python3
"""Decode the "M5 Sound Mod 0.1" GTA V sound mod (by Azerrty) into WAV clips for the swim car.

The mod ships its sounds as Rockstar .awc wave containers. This reads them straight out of the mod's .rar (through
bsdtar, nothing extracted to disk), from a single .awc, or from a folder holding .awc files, and writes into
assets/audio/m5mod/ (gitignored, like the M3 clips: used, never committed):

    pop-1..5.wav, burble-1..7.wav, bang-1..3.wav   the overrun one-shots swim-engine-audio.js layers on lift-off
    engine/idle.wav, accel-N.wav, decel-N.wav      steady loops stitched from the granular engine banks: the engine
                                                   voice the M3's can be swapped for (M5_MOD_ENGINE_CLIPS)
    streams/<container>-<name>.wav                 every stream as decoded, for listening

    python3 tools/extract-m5-mod-sound.py "path/to/M5 Sound Mod 0.1.rar"
    python3 tools/extract-m5-mod-sound.py path/to/m5cracklemod.awc --list
    python3 tools/extract-m5-mod-sound.py --self-check

AWC layout (little-endian, as documented by CodeWalker's AwcFile.cs):
    header   'ADAT', u16 version, u16 flags, u32 stream count, u32 data offset
             flags & 1: u16 first-chunk index per stream
    streams  u32 per stream: id (low 29 bits, a masked joaat hash of the wave name), chunk count (high 3 bits)
    chunks   u64 per chunk: tag (high 8 bits), size (28 bits), offset from file start (low 28 bits)
Chunk tags are the low byte of the chunk name's hash: 0xFA format, 0x55 data, 0x36 peak, 0x5A granular grains,
0xD9 granular loops, 0xBD markers, 0x48 multichannel stream format, 0xA3 seek table.
The format chunk: u32 samples, i32 loop point, u16 sample rate, i16 headroom, u16 loop begin, u16 loop end,
u16 play end, u8 play begin, u8 codec (0 PCM s16le, 4 IMA ADPCM in 2048-byte blocks), then a u32 when 24 bytes.
The granular grains chunk: per grain u32 start sample, f32 pitch (Hz, one engine revolution per grain) and a u32
this decoder doesn't need; then one f32. Every stream in this mod is mono PCM.
"""

import argparse
import os
import struct
import subprocess
import sys
import wave
from dataclasses import dataclass, field

MAGIC = b'ADAT'
FLAG_CHUNK_INDICES = 0x0001
FLAG_MULTICHANNEL = 0x0004
FLAG_ENCRYPTED = 0x000A  # single- or multichannel encryption
STREAM_ID_MASK = 0x1FFFFFFF

TAG_FORMAT = 0xFA
TAG_DATA = 0x55
TAG_GRAINS = 0x5A
CHUNK_NAMES = {
    TAG_FORMAT: 'format', TAG_DATA: 'data', 0x36: 'peak', TAG_GRAINS: 'granulargrains', 0xD9: 'granularloops',
    0xBD: 'markers', 0x48: 'streamformat', 0xA3: 'seektable', 0x5C: 'animation', 0x68: 'mid', 0x2B: 'gesture',
}
GRAIN_SIZE = 12  # bytes per grain entry

CODEC_PCM = 0
CODEC_ADPCM = 4
ADPCM_BLOCK = 2048  # bytes per block: a 4-byte header (step index, pad, s16 predictor) then 2044 bytes of nibbles

IMA_STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
    107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
    5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767,
]
IMA_INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8]

# The granular banks are named in the container (their hashes match these wave names); the one-shots are not, so
# they are known by stream id. Their roles come from the mod's sound data (m5cracklemod_sounds.dat54.rel lists
# them in three groups) and from measuring them: level envelope, spectrum and pulse rate.
WAVE_NAMES = ['engine_accel', 'engine_decel', 'engine_idle', 'exhaust_accel', 'exhaust_decel', 'exhaust_idle']
ONE_SHOTS = {
    # Pop clusters: 3-5 sharp bangs in 0.1-0.15 s, then silence
    'pop': [0x0152dd47, 0x0b0730b1, 0x0fac79fa, 0x1a8dcfc2, 0x1cc4942c],
    # Burbles: 0.14-0.21 s of dense crackle without a leading transient (same group as the pops)
    'burble': [0x07cb9d89, 0x0ac7e38f, 0x0e70aae0, 0x0456569d, 0x00b00f5f, 0x15b9b967, 0x1d2ac855],
    # Bangs: deep (30-50 Hz) pulse trains of 0.3-0.7 s, a big backfire rolling off
    'bang': [0x1b393dea, 0x048c6f57, 0x1a5044c4],
}

# Steady engine loops stitched from the granular banks: every grain picked is resampled to the target pitch, so the
# loop holds one note and repeats on a grain boundary. Engine and exhaust banks are mixed like GTA plays them. The
# accel loops play on the throttle, the decel loops off it (the exhaust decel bank starts at 21 Hz, so the decel set
# starts higher and shares the idle loop below it).
ENGINE_LOOPS = [
    # name, banks (engine, exhaust), target grain Hz
    ('idle', ('engine_idle', 'exhaust_idle'), 10.6),
    ('accel-1', ('engine_accel', 'exhaust_accel'), 16.0),
    ('accel-2', ('engine_accel', 'exhaust_accel'), 24.0),
    ('accel-3', ('engine_accel', 'exhaust_accel'), 33.0),
    ('accel-4', ('engine_accel', 'exhaust_accel'), 42.0),
    ('accel-5', ('engine_accel', 'exhaust_accel'), 51.0),
    ('accel-6', ('engine_accel', 'exhaust_accel'), 60.0),
    ('decel-1', ('engine_decel', 'exhaust_decel'), 23.0),
    ('decel-2', ('engine_decel', 'exhaust_decel'), 32.0),
    ('decel-3', ('engine_decel', 'exhaust_decel'), 42.0),
    ('decel-4', ('engine_decel', 'exhaust_decel'), 51.0),
    ('decel-5', ('engine_decel', 'exhaust_decel'), 60.0),
]
LOOP_GRAINS = 24  # grains per stitched loop at most, nearest the target pitch, kept in their recorded order...
LOOP_TOLERANCE = 0.06  # ...and within this share of it...
LOOP_MIN_GRAINS = 8  # ...unless that leaves fewer than this many
SEAM_RAMP = 48  # samples (1.5 ms) over which a join between grains that weren't recorded back to back is mended
ENGINE_MIX = 0.55  # engine bank's share of a stitched loop, the exhaust gets the rest
LOOP_HEADROOM = 0.9  # peak of a stitched loop


def joaat(text):
    """Rockstar's Jenkins one-at-a-time hash of the lowercased name."""
    h = 0
    for byte in text.lower().encode():
        h = (h + byte) & 0xFFFFFFFF
        h = (h + (h << 10)) & 0xFFFFFFFF
        h ^= h >> 6
    h = (h + (h << 3)) & 0xFFFFFFFF
    h ^= h >> 11
    return (h + (h << 15)) & 0xFFFFFFFF


NAME_BY_ID = {joaat(name) & STREAM_ID_MASK: name for name in WAVE_NAMES}
ROLE_BY_ID = {stream_id: f'{role}-{i + 1}' for role, ids in ONE_SHOTS.items() for i, stream_id in enumerate(ids)}


@dataclass
class Chunk:
    tag: int
    size: int
    offset: int

    @property
    def name(self):
        return CHUNK_NAMES.get(self.tag, f'0x{self.tag:02X}')


@dataclass
class Stream:
    id: int
    chunks: list = field(default_factory=list)

    @property
    def name(self):
        return NAME_BY_ID.get(self.id, f'{self.id:08x}')

    def chunk(self, tag):
        return next((chunk for chunk in self.chunks if chunk.tag == tag), None)


@dataclass
class WaveFormat:
    samples: int
    loop_point: int
    sample_rate: int
    headroom: int
    codec: int


def parse_awc(data):
    """The container's version, flags and streams; raises ValueError on anything this decoder doesn't handle."""
    if data[:4] != MAGIC:
        raise ValueError(f'not a little-endian AWC (magic {data[:4]!r})')
    version, flags, stream_count, _data_offset = struct.unpack_from('<HHII', data, 4)
    if flags & FLAG_ENCRYPTED:
        raise ValueError(f'encrypted AWC (flags 0x{flags:04X})')
    if flags & FLAG_MULTICHANNEL:
        raise ValueError(f'multichannel AWC (flags 0x{flags:04X}) is not supported')
    position = 16
    if flags & FLAG_CHUNK_INDICES:
        position += 2 * stream_count
    streams, counts = [], []
    for raw in struct.unpack_from(f'<{stream_count}I', data, position):
        streams.append(Stream(raw & STREAM_ID_MASK))
        counts.append(raw >> 29)
    position += 4 * stream_count
    for stream, count in zip(streams, counts):
        for raw in struct.unpack_from(f'<{count}Q', data, position):
            chunk = Chunk(raw >> 56, (raw >> 28) & 0x0FFFFFFF, raw & 0x0FFFFFFF)
            if chunk.offset + chunk.size > len(data):
                raise ValueError(f'stream {stream.name}: {chunk.name} chunk runs past the end of the file')
            stream.chunks.append(chunk)
        position += 8 * count
    return version, flags, streams


def read_format(data, chunk):
    samples, loop_point, rate, headroom, _lb, _le, _pe, _pb, codec = struct.unpack_from('<IiHhHHHBB', data, chunk.offset)
    return WaveFormat(samples, loop_point, rate, headroom, codec)


def decode_ima_adpcm(block_data, sample_count):
    """Rockstar's mono IMA ADPCM: 2048-byte blocks, each restarting the predictor; low nibble first."""
    out = []
    for start in range(0, len(block_data), ADPCM_BLOCK):
        block = block_data[start:start + ADPCM_BLOCK]
        if len(block) < 4:
            break
        index = min(block[0], len(IMA_STEPS) - 1)
        predictor = struct.unpack_from('<h', block, 2)[0]
        for byte in block[4:]:
            for nibble in (byte & 0x0F, byte >> 4):
                step = IMA_STEPS[index]
                diff = step >> 3
                if nibble & 1:
                    diff += step >> 2
                if nibble & 2:
                    diff += step >> 1
                if nibble & 4:
                    diff += step
                predictor += -diff if nibble & 8 else diff
                predictor = min(max(predictor, -32768), 32767)
                index = min(max(index + IMA_INDEX_SHIFT[nibble & 7], 0), len(IMA_STEPS) - 1)
                out.append(predictor)
                if len(out) >= sample_count:
                    return out
    return out


def decode_stream(data, stream):
    """(format, samples as ints) for a stream with format and data chunks, or None for one without audio."""
    format_chunk, data_chunk = stream.chunk(TAG_FORMAT), stream.chunk(TAG_DATA)
    if not format_chunk or not data_chunk:
        return None
    fmt = read_format(data, format_chunk)
    payload = data[data_chunk.offset:data_chunk.offset + data_chunk.size]
    if fmt.codec == CODEC_PCM:
        count = min(fmt.samples, len(payload) // 2)
        return fmt, list(struct.unpack_from(f'<{count}h', payload))
    if fmt.codec == CODEC_ADPCM:
        return fmt, decode_ima_adpcm(payload, fmt.samples)
    raise ValueError(f'stream {stream.name}: codec {fmt.codec} is not supported')


def read_grains(data, stream):
    """A granular bank's grains as (start sample, pitch Hz), or [] for a stream without them."""
    chunk = stream.chunk(TAG_GRAINS)
    if not chunk:
        return []
    count = (chunk.size - 4) // GRAIN_SIZE
    return [struct.unpack_from('<If', data, chunk.offset + GRAIN_SIZE * i) for i in range(count)]


def resample(segment, length):
    """Linear resampling of a short segment to `length` samples (both ends kept)."""
    if length <= 1 or len(segment) < 2:
        return [float(segment[0]) if segment else 0.0] * max(length, 0)
    scale = (len(segment) - 1) / (length - 1)
    out = []
    for i in range(length):
        position = i * scale
        left = int(position)
        right = min(left + 1, len(segment) - 1)
        frac = position - left
        out.append(segment[left] * (1 - frac) + segment[right] * frac)
    return out


def stitch_grains(samples, grains, target_hz, sample_rate, count=LOOP_GRAINS):
    """A steady loop at target_hz and the recorded pitches of the grains it is made of: the grains nearest that pitch
    (see LOOP_TOLERANCE), in recorded order, each resampled to one period. Grains are whole engine revolutions, so
    the joins (and the loop point) fall on revolution boundaries."""
    spans = [(start, grains[i + 1][0], hz) for i, (start, hz) in enumerate(grains[:-1]) if grains[i + 1][0] > start]
    nearest = sorted(range(len(spans)), key=lambda i: abs(spans[i][2] - target_hz))[:count]
    close = [i for i in nearest if abs(spans[i][2] - target_hz) <= LOOP_TOLERANCE * target_hz]
    picked = close if len(close) >= LOOP_MIN_GRAINS else nearest[:LOOP_MIN_GRAINS]
    period = round(sample_rate / target_hz)
    out, seams, previous_end = [], [0], None  # the loop point is always a seam
    for i in sorted(picked):
        start, end, _hz = spans[i]
        if previous_end is not None and start != previous_end:
            seams.append(len(out))
        out.extend(resample(samples[start:end], period))
        previous_end = end
    for seam in seams:
        mend_seam(out, seam)
    return out, [spans[i][2] for i in sorted(picked)]


def mend_seam(out, seam, ramp=SEAM_RAMP):
    """Bends the samples before `seam` (wrapping round the loop) so they run into out[seam] without a step: the gap
    between out[seam] and where the waveform's slope was heading is spread over `ramp` samples."""
    if len(out) < 2 * ramp:
        return
    step = out[seam] - (2 * out[seam - 1] - out[seam - 2])
    for j in range(ramp):
        out[seam - ramp + j] += step * (j + 1) / (ramp + 1)


def mix_loops(engine, exhaust, engine_share=ENGINE_MIX, peak=LOOP_HEADROOM):
    length = min(len(engine), len(exhaust))
    mixed = [engine[i] * engine_share + exhaust[i] * (1 - engine_share) for i in range(length)]
    mend_seam(mixed, 0)  # the longer loop was cut short, so the mix has a loop point of its own
    top = max((abs(value) for value in mixed), default=0) or 1
    return [value * peak * 32767 / top for value in mixed]


def write_wav(path, samples, sample_rate):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clipped = [min(max(int(round(value)), -32768), 32767) for value in samples]
    with wave.open(path, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(struct.pack(f'<{len(clipped)}h', *clipped))


def awc_sources(source):
    """(label, bytes) for each .awc in a .rar (read through bsdtar), a folder, or a single .awc file."""
    if os.path.isdir(source):
        for root, _dirs, files in os.walk(source):
            for name in sorted(files):
                if name.lower().endswith('.awc'):
                    with open(os.path.join(root, name), 'rb') as handle:
                        yield name, handle.read()
    elif source.lower().endswith('.rar'):
        members = subprocess.run(['bsdtar', '-tf', source], check=True, capture_output=True, text=True).stdout
        for member in members.splitlines():
            if member.lower().endswith('.awc'):
                payload = subprocess.run(['bsdtar', '-xOf', source, member], check=True, capture_output=True).stdout
                yield os.path.basename(member), payload
    else:
        with open(source, 'rb') as handle:
            yield os.path.basename(source), handle.read()


def self_check():
    """Round-trips a tiny synthetic container through the parser, both codecs and the grain stitcher."""
    assert joaat('engine_accel') & STREAM_ID_MASK == 0x1F7402AA, 'joaat matches the mod\'s engine_accel stream'
    pcm = [0, 1000, -1000, 32767]
    fmt = struct.pack('<IiHhHHHBB', len(pcm), -1, 32000, 0, 0, 0, 0, 0, CODEC_PCM)
    fmt_offset = 16 + 2 + 4 + 2 * 8
    data_offset = fmt_offset + len(fmt)
    chunk_words = [
        (TAG_FORMAT << 56) | (len(fmt) << 28) | fmt_offset,
        (TAG_DATA << 56) | (2 * len(pcm) << 28) | data_offset,
    ]
    blob = MAGIC + struct.pack('<HHII', 1, 0xFF01, 1, fmt_offset) + struct.pack('<H', 0)
    blob += struct.pack('<I', 0x0ABCDEF1 | (2 << 29)) + struct.pack('<2Q', *chunk_words)
    blob += fmt + struct.pack(f'<{len(pcm)}h', *pcm)
    _version, _flags, streams = parse_awc(blob)
    assert len(streams) == 1 and streams[0].id == 0x0ABCDEF1 and len(streams[0].chunks) == 2
    decoded_fmt, decoded = decode_stream(blob, streams[0])
    assert decoded_fmt.sample_rate == 32000 and decoded == pcm
    try:
        parse_awc(blob[:fmt_offset] + b'\0' * 4)
    except ValueError:
        pass
    else:
        raise AssertionError('a chunk past the end of the file is refused')
    # ADPCM, low nibble first: a 0 nibble at step 7 adds 7 >> 3 = 0; a 7 adds 0 + 1 + 3 + 7 and jumps the step
    # index by 8 (step 16), so the next 0 nibble adds 16 >> 3 = 2
    block = struct.pack('<BBh', 0, 0, 100) + bytes([0x00, 0x07])
    assert decode_ima_adpcm(block, 4) == [100, 100, 111, 113]
    # Stitching: two grains of 8 and 12 samples become two 10-sample periods
    ramp = list(range(20))
    loop, pitches = stitch_grains(ramp, [(0, 4000.0), (8, 2666.7), (20, 0.0)], 3200.0, 32000)
    assert pitches == [4000.0, 2666.7] and len(loop) == 20 and loop[0] == 0 and loop[9] == 7 and loop[10] == 8 and loop[19] == 19
    # Mending: a rising ramp that wraps back to 0 ends bent down to meet its start, its first half untouched
    ramp = [float(i) for i in range(100)]
    mend_seam(ramp, 0)
    assert abs(ramp[-1]) < 2 and ramp[0] == 0 and ramp[50] == 50
    print('self-check ok')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('source', nargs='?', help='the mod .rar, an .awc file, or a folder holding .awc files')
    default_out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'audio', 'm5mod')
    parser.add_argument('--out', default=default_out, help='where the WAVs go (default: assets/audio/m5mod/)')
    parser.add_argument('--list', action='store_true', help='describe the streams without writing anything')
    parser.add_argument('--self-check', action='store_true', help='run the decoder self-check and exit')
    args = parser.parse_args(argv)
    if args.self_check:
        self_check()
        return 0
    if not args.source:
        parser.error('a source is required')
    out = os.path.normpath(args.out)
    banks = {}  # the main container's granular banks: name -> (samples, grains, sample rate)
    for label, data in awc_sources(args.source):
        version, flags, streams = parse_awc(data)
        container = os.path.splitext(label)[0]
        print(f'{label}: version {version}, flags 0x{flags:04X}, {len(streams)} streams')
        for stream in streams:
            chunks = ', '.join(f'{chunk.name}:{chunk.size}' for chunk in stream.chunks)
            decoded = decode_stream(data, stream)
            if not decoded:
                print(f'  {stream.name}: no audio ({chunks})')
                continue
            fmt, samples = decoded
            grains = read_grains(data, stream)
            role = ROLE_BY_ID.get(stream.id)
            notes = [f'codec {fmt.codec}', f'{fmt.sample_rate} Hz', f'{len(samples) / fmt.sample_rate:.2f} s']
            if grains:
                pitches = [hz for _start, hz in grains]
                notes.append(f'{len(grains)} grains {min(pitches):.1f}-{max(pitches):.1f} Hz')
            if role:
                notes.append(role)
            print(f'  {stream.name}: {", ".join(notes)} [{chunks}]')
            if args.list:
                continue
            write_wav(os.path.join(out, 'streams', f'{container}-{stream.name}.wav'), samples, fmt.sample_rate)
            if role:
                write_wav(os.path.join(out, f'{role}.wav'), samples, fmt.sample_rate)
            if grains and not container.endswith('_npc'):
                banks[stream.name] = (samples, grains, fmt.sample_rate)
    if args.list:
        return 0
    for name, (engine_bank, exhaust_bank), target_hz in ENGINE_LOOPS:
        if engine_bank not in banks or exhaust_bank not in banks:
            print(f'engine/{name}.wav: skipped, the {engine_bank}/{exhaust_bank} banks are missing')
            continue
        engine_samples, engine_grains, rate = banks[engine_bank]
        exhaust_samples, exhaust_grains, exhaust_rate = banks[exhaust_bank]
        if exhaust_rate != rate:
            print(f'engine/{name}.wav: skipped, the banks differ in sample rate')
            continue
        engine, engine_pitches = stitch_grains(engine_samples, engine_grains, target_hz, rate)
        exhaust, exhaust_pitches = stitch_grains(exhaust_samples, exhaust_grains, target_hz, rate)
        loop = mix_loops(engine, exhaust)
        write_wav(os.path.join(out, 'engine', f'{name}.wav'), loop, rate)
        spread = ', '.join(f'{min(p):.1f}-{max(p):.1f} Hz' for p in (engine_pitches, exhaust_pitches))
        print(f'engine/{name}.wav: {len(loop) / rate:.2f} s at {target_hz} Hz from grains of {spread}')
    print(f'wrote {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
