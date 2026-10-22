import { mkdirSync, writeFileSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { resolve } from 'node:path';

const perf = process.argv.includes('--perf');
const directory = resolve(perf ? '.test-output/audio' : 'tests/fixtures/audio');
mkdirSync(directory, { recursive: true });
const manifest = [];
function wav(name, channels, bits, frames = 4800, mode = 'tones') {
  const bytes = bits / 8, rate = 48000, length = frames * channels * bytes;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(mode === 'float' || mode === 'nan' ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28); header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(length, 40);
  const path = resolve(directory, name), fd = openSync(path, 'w'); writeSync(fd, header);
  for (let start = 0; start < frames; start += 4096) {
    const count = Math.min(4096, frames - start), block = Buffer.alloc(count * channels * bytes);
    for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) {
      const t = (start + i) / rate;
      let value = mode === 'silence' ? 0 : 0.5 * Math.sin(2 * Math.PI * (300 + c * 300) * t);
      if (mode === 'dual') value = 0.25 * (Math.sin(2 * Math.PI * 1000 * t) + Math.sin(2 * Math.PI * 4000 * t));
      const offset = (i * channels + c) * bytes;
      if (mode === 'float' || mode === 'nan') block.writeFloatLE(mode === 'nan' && start + i === 8 ? NaN : value, offset);
      else block.writeIntLE(Math.round(value * (2 ** (bits - 1) - 1)), offset, bytes);
    }
    writeSync(fd, block);
  }
  closeSync(fd); return path;
}
if (perf) {
  wav('ten-minute-six.wav', 6, 16, 48000 * 600);
  wav('ten-minute-stereo.wav', 2, 16, 48000 * 600);
  console.log(`Generated performance WAV files in ${directory}`);
} else {
  for (const [name, channels, bits, frames, mode] of [
    ['mono16.wav', 1, 16], ['stereo24.wav', 2, 24], ['six32.wav', 6, 32], ['float32.wav', 2, 32, 4800, 'float'],
    ['silence.wav', 1, 16, 4800, 'silence'], ['short.wav', 1, 16, 37], ['dual.wav', 1, 16, 4800, 'dual'],
    ['seven.wav', 7, 16], ['zero.wav', 1, 16, 0], ['nonfinite.wav', 1, 32, 32, 'nan'],
  ]) wav(name, channels, bits, frames, mode);
  for (const [source, target, codec] of [['six32.wav', 'six.flac', 'flac'], ['stereo24.wav', 'stereo.mp3', 'libmp3lame'], ['mono16.wav', 'mono.flac', 'flac']]) {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(directory, source), '-map_metadata', '-1', '-c:a', codec, resolve(directory, target)], { windowsHide: true });
    if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.toString());
  }
  const vbr = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(directory, 'stereo24.wav'), '-c:a', 'libmp3lame', '-q:a', '4', '-write_xing', '0', '-map_metadata', '-1', resolve(directory, 'vbr-no-xing.mp3')], { windowsHide: true });
  if (vbr.status !== 0) throw new Error(vbr.error?.message ?? vbr.stderr.toString());
  const mp3 = readFileSync(resolve(directory, 'stereo.mp3'));
  writeFileSync(resolve(directory, 'truncated.mp3'), mp3.subarray(0, mp3.length - 50));
  const rawMp3 = readFileSync(resolve(directory, 'vbr-no-xing.mp3'));
  writeFileSync(resolve(directory, 'truncated-no-xing.mp3'), rawMp3.subarray(0, rawMp3.length - 50));
  writeFileSync(resolve(directory, 'corrupt.wav'), Buffer.from('RIFF not audio'));
  const valid = readFileSync(resolve(directory, 'mono16.wav'));
  writeFileSync(resolve(directory, 'truncated.wav'), valid.subarray(0, valid.length - 51));
  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(directory).filter(n => n !== 'sha256.json').sort()) {
    const data = readFileSync(resolve(directory, name));
    let decodedFrames;
    if (name.endsWith('.mp3') && !name.startsWith('truncated')) {
      const pcm = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', resolve(directory, name), '-f', 's16le', '-'], { windowsHide: true });
      if (pcm.status !== 0) throw new Error(pcm.stderr.toString());
      decodedFrames = pcm.stdout.length / 4;
    }
    manifest.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...(decodedFrames === undefined ? {} : { decodedFrames }) });
  }
  writeFileSync(resolve(directory, 'sha256.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Generated ${manifest.length} deterministic audio fixtures and SHA-256 manifest`);
}
