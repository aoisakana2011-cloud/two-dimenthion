const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
(async () => {
  const root = path.resolve(__dirname, '../build/audit-smoke');
  const assetsRoot = path.join(root, 'assets'), scenesRoot = path.join(root, 'scenes');
  await fs.mkdir(assetsRoot, { recursive: true }); await fs.mkdir(scenesRoot, { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), path.join(assetsRoot, 'pixel.png'));
  const ffmpeg = process.env.FFMPEG_EXE || 'ffmpeg';
  function encode(args) { const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 20000 }); assert.equal(r.status, 0, r.stderr || r.error?.message); }
  encode(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', path.join(assetsRoot, 'tone.wav')]);
  for (const extension of ['flac', 'ogg', 'mp3']) encode(['-i', path.join(assetsRoot, 'tone.wav'), path.join(assetsRoot, `tone.${extension}`)]);
  for (const extension of ['jpg', 'webp', 'gif']) encode(['-i', path.join(assetsRoot, 'pixel.png'), '-vf', 'scale=160:90', '-frames:v', '1', path.join(assetsRoot, `pixel.${extension}`)]);
  encode(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.4:r=25', '-i', path.join(assetsRoot, 'tone.wav'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(assetsRoot, 'clip.mp4')]);
  const source = `asset bg room = "pixel.png"
asset image first = "pixel.png"
asset image second = "pixel.png"
asset image jpeg = "pixel.jpg"
asset image webp = "pixel.webp"
asset image gif = "pixel.gif"
asset bgm music = "tone.wav"
asset se sound = "tone.wav"
asset se flac = "tone.flac"
asset se vorbis = "tone.ogg"
asset se mpthree = "tone.mp3"
asset video clip = "clip.mp4"
character hero { normal = "pixel.png" }
character friend { normal = "pixel.png" }
int x = 9007199254740993
bg room
bgm music
play se sound
play se flac
play se vorbis
play se mpthree
show image jpeg center
show image webp center
show image gif center
clear image jpeg
clear image webp
clear image gif
show image first left
show image second right
show char hero left normal fade 10
show char friend right normal
char hero center normal
clear image first
clear char friend
hide char hero fade 10
effect fade white 10
play video clip blocking
play video clip async
wait 500
clear bgm
clear bg
choice "test" { "continue" { say none str(x) } }
`;
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), source);
  const output = path.join(root, 'package.nsp.json'); await pack(path.join(scenesRoot, 'main.tds'), output, { scenesRoot, assetsRoot });
  const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build-audit/Release/novel_player.exe');
  const start = Date.now();
  const child = spawnSync(exe, [output, '--smoke'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.ok(Date.now() - start >= 800, 'blocking video must wait for playback');
  console.log('PASS native SDL smoke: assets, characters, clear, fade, mixer audio, blocking/async FFmpeg video, choice, say');
})().catch(e => { console.error(e); process.exitCode = 1; });
