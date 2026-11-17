// MB World — 서비스매니저 라운지 실시간 서버
// 실행: npm install && npm start   (기본 포트 3000)
// 환경변수: PORT, ACCESS_CODE(입장 코드, 비우면 누구나 입장), DATA_DIR(기록 저장 폴더)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HTML_PATH = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'index.html');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------
const FILE = path.join(DATA_DIR, 'world.json');
let store = { chat: [], players: {}, wishes: {} };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(FILE + '.tmp', JSON.stringify(store), err => { if (!err) fs.rename(FILE + '.tmp', FILE, () => {}); });
  }, 1500);
}

// ---------- helpers ----------
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').trim().slice(0, n);
const color = c => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#c9ced6');
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(+v || 0)));
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
function normStats(s) {
  if (!s || typeof s !== 'object') return null;
  const d = s.day && typeof s.day === 'object' ? s.day : {};
  return {
    pts: num(s.pts, 0, 1e9), bolts: num(s.bolts, 0, 1e9), set: num(s.set, 0, 107), best: num(s.best, 0, 36e5), race: num(s.race, 0, 36e5),
    streak: num(s.streak, 0, 9999), last: clean(s.last, 10), days: num(s.days, 0, 99999),
    day: { d: clean(d.d, 10), polish: num(d.polish, 0, 99), coffee: num(d.coffee, 0, 99), laps: num(d.laps, 0, 999), quiz: num(d.quiz, 0, 1), wish: num(d.wish, 0, 1), zen: num(d.zen, 0, 1) },
  };
}

// ---------- http ----------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }
  const STATIC = { '/bgm.mp3': 'audio/mpeg', '/hall.glb': 'model/gltf-binary', '/hall_props_lm.jpg': 'image/jpeg', '/hall_floor_lm.jpg': 'image/jpeg', '/hall_bake.json': 'application/json' };
  const urlPath = req.url.split('?')[0];
  if (STATIC[urlPath]) {
    const f = path.join(__dirname, urlPath.slice(1));
    fs.stat(f, (err, st) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const range = req.headers.range;
      const base = { 'content-type': STATIC[urlPath], 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600' };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        let start = m[1] ? parseInt(m[1], 10) : 0, end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (isNaN(start) || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        fs.createReadStream(f, { start, end }).pipe(res);
      } else { res.writeHead(200, { ...base, 'content-length': st.size }); fs.createReadStream(f).pipe(res); }
    });
    return;
  }
  fs.readFile(HTML_PATH, (err, html) => {
    if (err) { res.writeHead(500); res.end('index.html not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(html);
  });
});

// ---------- realtime ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
const online = new Map(); // ws -> client

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, except) { const s = JSON.stringify(obj); for (const ws of online.keys()) if (ws !== except && ws.readyState === 1) ws.send(s); }
function peerOf(c) { return { id: c.id, n: c.n, p: c.p, c: c.c, x: c.x, y: c.y, h: c.h, m: c.m, s: c.s || 0, v: c.v || 0, ca: c.ca || 0, e: c.e, et: c.et }; }

function boardPayload() {
  const players = Object.entries(store.players).map(([tok, p]) => ({
    id: [...online.values()].find(c => c.token === tok)?.id || 'x' + tok.slice(0, 6),
    n: p.n, p: p.p, c: p.c, pts: p.st.pts, bolts: p.st.bolts, best: p.st.race || 0, streak: p.st.streak,
  }));
  const totalBolts = players.reduce((a, p) => a + p.bolts, 0);
  const top = [...players].sort((a, b) => b.pts - a.pts).slice(0, 10);
  const laps = players.filter(p => p.best > 0).sort((a, b) => a.best - b.best).slice(0, 5);
  const byId = new Map([...top, ...laps].map(p => [p.id, p]));
  const today = kstDay();
  const wishes = Object.values(store.wishes).filter(w => w.d === today).sort((a, b) => b.ts - a.ts).slice(0, 60);
  return { players: [...byId.values()], wishes, totalBolts };
}
let boardTimer = null;
function boardSoon() { clearTimeout(boardTimer); boardTimer = setTimeout(() => broadcast({ type: 'board', ...boardPayload() }), 800); }

wss.on('connection', ws => {
  const c = { id: crypto.randomBytes(6).toString('hex'), token: null, joined: false, x: 1200, y: 900, h: 0, m: 0, e: null, et: 0, n: '', p: '', c: '#c9ced6', bucket: 40, lastChat: 0, alive: true };
  online.set(ws, c);
  send(ws, { type: 'hello_req', needCode: !!ACCESS_CODE });
  ws.on('pong', () => { c.alive = true; });

  ws.on('message', raw => {
    if (c.bucket <= 0) return; c.bucket--;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'hello') {
      if (ACCESS_CODE && clean(m.code, 32) !== ACCESS_CODE) { send(ws, { type: 'denied', reason: 'code' }); return; }
      c.n = clean(m.n, 16) || '매니저'; c.p = clean(m.p, 24); c.c = color(m.c);
      c.x = num(m.x, 0, 2400); c.y = num(m.y, 0, 1500);
      c.token = /^[a-z0-9]{8,64}$/i.test(m.token || '') ? m.token : crypto.randomBytes(12).toString('hex');
      // same person in another tab: keep only the newest
      for (const [ows, oc] of online) if (ows !== ws && oc.token === c.token && oc.joined) { oc.joined = false; broadcast({ type: 'leave', id: oc.id }); ows.close(4000, 'replaced'); }
      c.joined = true;
      const rec = store.players[c.token];
      if (rec) { rec.n = c.n; rec.p = c.p; rec.c = c.c; }
      send(ws, {
        type: 'welcome', id: c.id,
        peers: [...online.values()].filter(o => o.joined && o !== c).map(peerOf),
        history: store.chat.slice(-80), board: boardPayload(), mystats: rec ? rec.st : null,
      });
      broadcast({ type: 'peer', ...peerOf(c) }, ws);
      return;
    }
    if (!c.joined) return;

    if (m.type === 'state') {
      c.x = num(m.x, 0, 2400); c.y = num(m.y, 0, 1500); c.h = Math.max(-7, Math.min(7, +m.h || 0)); c.m = m.m ? 1 : 0; c.s = m.s ? 1 : 0; c.v = m.v ? 1 : 0; c.ca = Math.max(-1e4, Math.min(1e4, +m.ca || 0));
      if (typeof m.e === 'string') { c.e = clean(m.e, 4); c.et = num(m.et, 0, 9e15); }
      broadcast({ type: 'peer', ...peerOf(c) }, ws);
    } else if (m.type === 'profile') {
      c.n = clean(m.n, 16) || c.n; c.p = clean(m.p, 24); c.c = color(m.c);
      const rec = store.players[c.token]; if (rec) { rec.n = c.n; rec.p = c.p; rec.c = c.c; save(); boardSoon(); }
      broadcast({ type: 'peer', ...peerOf(c) }, ws);
    } else if (m.type === 'chat') {
      const now = Date.now(); if (now - c.lastChat < 600) return; c.lastChat = now;
      const t = clean(m.t, 200); if (!t) return;
      const msg = { id: crypto.randomBytes(6).toString('hex'), from: c.id, t, n: c.n, p: c.p, c: c.c, x: c.x, y: c.y, ts: now };
      store.chat.push(msg); if (store.chat.length > 300) store.chat.splice(0, store.chat.length - 300); save();
      broadcast({ type: 'chat', m: msg });
    } else if (m.type === 'stats') {
      const st = normStats(m.st); if (!st) return;
      store.players[c.token] = { n: c.n, p: c.p, c: c.c, st, ts: Date.now() }; save(); boardSoon();
    } else if (m.type === 'wish') {
      const t = clean(m.t, 40); if (!t) return;
      store.wishes[c.token] = { t, n: c.n, p: c.p, c: c.c, d: kstDay(), ts: Date.now() }; save(); boardSoon();
    }
  });

  ws.on('close', () => { online.delete(ws); if (c.joined) broadcast({ type: 'leave', id: c.id }); });
});

setInterval(() => { for (const c of online.values()) c.bucket = Math.min(60, c.bucket + 40); }, 1000);
setInterval(() => { for (const [ws, c] of online) { if (!c.alive) { ws.terminate(); continue; } c.alive = false; try { ws.ping(); } catch (e) {} } }, 30000);

server.listen(PORT, () => console.log(`MB World running on http://localhost:${PORT}${ACCESS_CODE ? '  (입장 코드 사용 중)' : ''}`));
