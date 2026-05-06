'use strict';
const express  = require('express');
const cors     = require('cors');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const { randomUUID } = require('crypto');
const axios    = require('axios');

const app    = express();
const PORT   = process.env.PORT || 3001;
const DL_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './beats.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id         TEXT PRIMARY KEY,
    video_id   TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT 'Unknown',
    artist     TEXT NOT NULL DEFAULT 'Unknown',
    thumbnail  TEXT,
    duration   INTEGER DEFAULT 0,
    format     TEXT NOT NULL DEFAULT 'mp3',
    quality    TEXT DEFAULT '720p',
    status     TEXT NOT NULL DEFAULT 'pending',
    progress   INTEGER DEFAULT 0,
    file_path  TEXT,
    file_size  INTEGER DEFAULT 0,
    error      TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
`);

// ── InnerTube ────────────────────────────────────────────────────────────────
const YT_KEY  = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const YTM_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-KLET5YdCE';
const YT_CTX  = { client: { clientName: 'WEB',       clientVersion: '2.20230501.00.00', hl: 'en' } };
const YTM_CTX = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20230501.01.00', hl: 'en' } };

function parseDur(str) {
  if (!str) return 0;
  return str.split(':').reduce((acc, v, i, a) => acc + Number(v) * Math.pow(60, a.length - 1 - i), 0);
}

async function searchMusic(q) {
  const { data } = await axios.post(
    `https://music.youtube.com/youtubei/v1/search?key=${YTM_KEY}`,
    { context: YTM_CTX, query: q, params: 'EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D' },
    { headers: { 'Content-Type': 'application/json', 'Origin': 'https://music.youtube.com',
                 'Referer': 'https://music.youtube.com/', 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 }
  );
  const results = [];
  try {
    const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs ?? [];
    for (const tab of tabs) {
      const sections = tab?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
      for (const sec of sections) {
        for (const item of (sec?.musicShelfRenderer?.contents ?? [])) {
          const r = item?.musicResponsiveListItemRenderer;
          if (!r) continue;
          const videoId =
            r.overlay?.musicItemThumbnailOverlayRenderer?.content
              ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
            r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
              ?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId) continue;
          const title   = r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 'Unknown';
          const artist  = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || 'Unknown';
          const thumb   = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url || null;
          const durStr  = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '0:00';
          results.push({ videoId, title, artist, thumbnail: thumb, duration: parseDur(durStr), durationText: durStr });
          if (results.length >= 25) break;
        }
        if (results.length >= 25) break;
      }
      if (results.length >= 25) break;
    }
  } catch (e) { console.error('YTM parse:', e.message); }
  return results;
}

async function searchVideo(q) {
  const { data } = await axios.post(
    `https://www.youtube.com/youtubei/v1/search?key=${YT_KEY}`,
    { context: YT_CTX, query: q },
    { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 }
  );
  const results = [];
  try {
    const sections = data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents ?? [];
    for (const sec of sections) {
      for (const item of (sec?.itemSectionRenderer?.contents ?? [])) {
        const r = item?.videoRenderer;
        if (!r?.videoId) continue;
        const title  = r.title?.runs?.[0]?.text || 'Unknown';
        const artist = r.ownerText?.runs?.[0]?.text || 'Unknown';
        const thumb  = r.thumbnail?.thumbnails?.slice(-1)[0]?.url || null;
        const durStr = r.lengthText?.simpleText || '0:00';
        results.push({ videoId: r.videoId, title, artist, thumbnail: thumb,
                       duration: parseDur(durStr), durationText: durStr });
        if (results.length >= 25) break;
      }
      if (results.length >= 25) break;
    }
  } catch (e) { console.error('YT parse:', e.message); }
  return results;
}

// ── Download runner ──────────────────────────────────────────────────────────
function runDownload(id, videoId, format, quality) {
  const url     = `https://www.youtube.com/watch?v=${videoId}`;
  const isAudio = ['mp3','aac','flac','m4a','opus','wav'].includes(format);
  const out     = path.join(DL_DIR, `${id}.%(ext)s`);

  const args = [
    '--output', out, '--no-playlist', '--newline', '--progress', '--no-warnings',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '--extractor-args', 'youtube:player_client=android,mweb', '--js-interpreter', 'nodejs:/usr/local/bin/node',
    '--no-check-certificate', '--retries', '3', '--fragment-retries', '3',
  ];

  const cookies = path.join(process.cwd(), 'youtube_cookies.txt');
  if (fs.existsSync(cookies)) args.push('--cookies', cookies);

  if (isAudio) {
    args.push('--format', 'bestaudio/best', '--extract-audio',
              '--audio-format', format, '--audio-quality', '0');
  } else {
    const h = { '360p':360,'480p':480,'720p':720,'1080p':1080 }[quality] || 720;
    args.push(
      '--format', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}]/best`,
      '--merge-output-format', 'mp4'
    );
  }
  args.push(url);

  db.prepare(`UPDATE tracks SET status='downloading' WHERE id=?`).run(id);
  const proc = spawn('yt-dlp', args);

  proc.stdout.on('data', d => {
    const m = d.toString().match(/(\d+\.?\d*)%/);
    if (m) db.prepare(`UPDATE tracks SET progress=? WHERE id=?`)
              .run(Math.min(Math.round(parseFloat(m[1])), 99), id);
  });

  proc.stderr.on('data', d => { const msg = d.toString().trim(); console.error('[yt-dlp stderr]', msg); db.prepare('UPDATE tracks SET error=? WHERE id=?').run(msg.slice(0,500), id); });

  proc.on('close', code => {
    if (code === 0) {
      const file = fs.readdirSync(DL_DIR).find(f => f.startsWith(id + '.'));
      if (file) {
        const fp = path.join(DL_DIR, file);
        db.prepare(`UPDATE tracks SET status='completed', progress=100, file_path=?, file_size=? WHERE id=?`)
          .run(fp, fs.statSync(fp).size, id);
        console.log(`✅ Done: ${file}`);
      } else {
        db.prepare(`UPDATE tracks SET status='failed', error='Output file missing' WHERE id=?`).run(id);
      }
    } else {
      db.prepare(`UPDATE tracks SET status='failed', error='yt-dlp exit ${code}' WHERE id=?`).run(id);
    }
  });

  proc.on('error', e =>
    db.prepare(`UPDATE tracks SET status='failed', error=? WHERE id=?`).run(e.message, id));
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0', name: 'Beats' }));

app.get('/api/search', async (req, res) => {
  const { q, type = 'music' } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });
  try {
    const results = type === 'video' ? await searchVideo(q) : await searchMusic(q);
    res.json({ results, query: q, type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/download', (req, res) => {
  const { videoId, title='Unknown', artist='Unknown', thumbnail=null,
          duration=0, format='mp3', quality='720p' } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  // Return existing completed download
  const done = db.prepare(`SELECT * FROM tracks WHERE video_id=? AND format=? AND status='completed'`).get(videoId, format);
  if (done?.file_path && fs.existsSync(done.file_path)) return res.json(done);

  const id = randomUUID();
  db.prepare(`INSERT INTO tracks (id,video_id,title,artist,thumbnail,duration,format,quality) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, videoId, title, artist, thumbnail, duration, format, quality);

  res.json(db.prepare(`SELECT * FROM tracks WHERE id=?`).get(id));
  setImmediate(() => runDownload(id, videoId, format, quality));
});

app.get('/api/download/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM tracks WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.get('/api/download/:id/file', (req, res) => {
  const row = db.prepare(`SELECT * FROM tracks WHERE id=?`).get(req.params.id);
  if (!row?.file_path || !fs.existsSync(row.file_path))
    return res.status(404).json({ error: 'File not found' });
  const ext  = path.extname(row.file_path).slice(1);
  const name = `${row.title} - ${row.artist}.${ext}`.replace(/[<>:"/\\|?*]/g, '').trim();
  res.download(row.file_path, name);
});

app.get('/api/stream/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM tracks WHERE id=?`).get(req.params.id);
  if (!row?.file_path || !fs.existsSync(row.file_path))
    return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(row.file_path);
  const ext  = path.extname(row.file_path).slice(1).toLowerCase();
  const mime = ['mp3','aac','flac','m4a','opus','wav'].includes(ext)
    ? `audio/${ext === 'mp3' ? 'mpeg' : ext}` : 'video/mp4';

  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-').map(Number);
    const end    = e || Math.min(s + 2 * 1024 * 1024, stat.size - 1);
    res.writeHead(206, {
      'Content-Range':  `bytes ${s}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - s + 1,
      'Content-Type':   mime,
    });
    fs.createReadStream(row.file_path, { start: s, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(row.file_path).pipe(res);
  }
});

app.get('/api/library', (_, res) =>
  res.json(db.prepare(`SELECT * FROM tracks WHERE status='completed' ORDER BY created_at DESC`).all()));

app.get('/api/downloads/all', (_, res) =>
  res.json(db.prepare(`SELECT * FROM tracks ORDER BY created_at DESC`).all()));

app.delete('/api/download/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM tracks WHERE id=?`).get(req.params.id);
  if (row?.file_path && fs.existsSync(row.file_path)) {
    try { fs.unlinkSync(row.file_path); } catch {}
  }
  db.prepare(`DELETE FROM tracks WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// Cleanup files older than 48hrs
setInterval(() => {
  const old = db.prepare(`SELECT * FROM tracks WHERE status='completed' AND created_at < datetime('now','-48 hours')`).all();
  for (const t of old) {
    if (t.file_path && fs.existsSync(t.file_path)) { try { fs.unlinkSync(t.file_path); } catch {} }
    db.prepare(`DELETE FROM tracks WHERE id=?`).run(t.id);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`🎵 Beats Server v1.0.0 on :${PORT}`));
process.on('SIGTERM', () => process.exit(0));

// Debug endpoint - remove after testing
app.get('/api/test-ytdlp', (req, res) => {
  const { spawn } = require('child_process');
  const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', 'https://www.youtube.com/watch?v=dNt1QR1ecuM']);
  let out = '', err = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.stderr.on('data', d => err += d.toString());
  proc.on('close', code => res.json({ code, out: out.slice(0,500), err: err.slice(0,1000) }));
});
