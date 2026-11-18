// MB World — 서비스매니저 라운지 실시간 서버
// 실행: npm install && npm start   (기본 포트 3000)
// 환경변수: PORT, DATA_DIR(기록 저장 폴더)
//   LINK_SECRET  설정 시 '오늘의 초대 링크'를 받은 사람만 입장 (매일 자정 KST에 바뀜)
//   ADMIN_KEY    관리자 페이지(/admin?key=...)에서 오늘 링크 확인·재발급
//   ACCESS_CODE  (LINK_SECRET 미사용 시) 입장 코드
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const LINK_SECRET = (process.env.LINK_SECRET || '').trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const ACCESS_CODE = LINK_SECRET ? '' : (process.env.ACCESS_CODE || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHRASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'phrases.json'), 'utf8')).list;
const HTML_PATH = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'index.html');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistence ----------
const FILE = path.join(DATA_DIR, 'world.json');
let store = { chat: [], players: {}, wishes: {}, linkSalt: {} };
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

// ---------- daily invite link ----------
function todayToken(day = kstDay()) {
  const salt = (store.linkSalt || {})[day] || 0;
  return crypto.createHmac('sha256', LINK_SECRET).update(day + ':' + salt).digest('base64url').slice(0, 14);
}
function secsToMidnight() { const n = Date.now() + 9 * 3600e3; return Math.max(60, Math.ceil((86400e3 - (n % 86400e3)) / 1000)); }
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return o; }
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
function hasPass(req) {
  if (!LINK_SECRET) return true;
  const t = todayToken(), q = new URL(req.url, 'http://x').searchParams.get('k');
  return (q && safeEq(q, t)) || (cookies(req).mbw && safeEq(cookies(req).mbw, t));
}
function origin(req) { const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0]; return proto + '://' + req.headers.host; }
const EXPIRED = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MB World</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f12;color:#e9ebef;font-family:system-ui,'Noto Sans KR',sans-serif;text-align:center;padding:24px}b{color:#00adef}.c{max-width:360px}h1{letter-spacing:.2em;font-size:20px}p{color:#9aa0aa;line-height:1.7;font-size:14px}</style></head>
<body><div class="c"><h1><b>MB</b> WORLD</h1><p>이 링크는 사용할 수 없어요.<br>MB World는 파일럿 기간 동안 <b>오늘 받은 초대 링크</b>로만 들어올 수 있어요.<br>담당자에게 오늘의 링크를 받아주세요.</p></div></body></html>`;
function adminPage(req) {
  const day = kstDay(), link = origin(req) + '/?k=' + todayToken(day), n = [...online.values()].filter(c => c.joined).length;
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MB World 관리자</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>body{margin:0;background:#0e0f12;color:#e9ebef;font-family:system-ui,'Noto Sans KR',sans-serif;padding:24px;display:flex;justify-content:center}.c{width:min(460px,100%)}h1{font-size:18px;letter-spacing:.15em}h1 b{color:#00adef}
.box{background:#16181d;border:1px solid #2a2d35;border-radius:16px;padding:18px;margin-top:14px}.l{font-size:12px;color:#9aa0aa;margin-bottom:6px}.u{word-break:break-all;background:#0f1115;border:1px solid #2a2d35;border-radius:10px;padding:12px;font-size:14px;user-select:all;white-space:pre-line}
button{all:unset;cursor:pointer;display:block;text-align:center;background:#00adef;color:#001018;font-weight:700;padding:12px;border-radius:12px;margin-top:10px;width:100%;box-sizing:border-box}button.g{background:transparent;color:#9aa0aa;border:1px solid #2a2d35}
#qr{background:#fff;border-radius:12px;padding:12px;width:max-content;margin:12px auto 0}.s{font-size:12px;color:#9aa0aa;line-height:1.7;margin-top:10px}</style></head>
<body><div class="c"><h1><b>MB</b> WORLD · 관리자</h1>
<div class="box"><div class="l">${day} (KST) 오늘의 초대 링크 · 오늘 밤 12시까지 유효</div><div class="u" id="u">${link}</div>
<button id="cp">링크 복사</button><div id="qr"></div>
<div class="s">이 링크를 받은 사람만 오늘 하루 들어올 수 있어요. 자정이 지나면 자동으로 막히고, 내일 링크가 새로 만들어져요.<br>현재 접속 중: <b>${n}명</b></div></div>
<div class="box"><div class="l">링크가 원치 않는 곳에 퍼졌다면</div><form method="post" action="/admin/rotate?key=${encodeURIComponent(ADMIN_KEY)}" onsubmit="return confirm('오늘 링크를 새로 만들까요? 기존 링크로는 더 이상 들어올 수 없어요.')"><button class="g" type="submit">오늘 링크 새로 만들기</button></form></div>
<div class="box"><div class="l">카톡·팀즈 공유 문구</div><div class="u" id="msg">📢 오늘의 MB World 입장 링크예요 (오늘 밤 12시까지)\n👉 ${link}</div><button id="cp2" class="g">공유 문구 복사</button></div>
</div><script>
new QRCode(document.getElementById('qr'),{text:${JSON.stringify(link)},width:180,height:180});
const cp=(id,b)=>{const t=document.getElementById(id).innerText.replace(/\\n/g,'\n');navigator.clipboard.writeText(t).then(()=>{b.textContent='복사했어요 ✓';setTimeout(()=>b.textContent=b.dataset.t,1800);}).catch(()=>{b.textContent='길게 눌러 복사하세요';});};
for(const [b,id] of [['cp','u'],['cp2','msg']]){const el=document.getElementById(b);el.dataset.t=el.textContent;el.onclick=()=>cp(id,el);}
document.getElementById('msg').innerText=document.getElementById('msg').innerText.replace(/\\n/g,'\n');
</script></body></html>`;
}

// ---------- http ----------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }
  const u0 = new URL(req.url, 'http://x');
  if (u0.pathname === '/admin' || u0.pathname === '/admin/rotate') {
    if (!ADMIN_KEY || !LINK_SECRET || !safeEq(u0.searchParams.get('key') || '', ADMIN_KEY)) { res.writeHead(404); res.end('not found'); return; }
    if (u0.pathname === '/admin/rotate' && req.method === 'POST') {
      const d = kstDay(); store.linkSalt = store.linkSalt || {}; store.linkSalt[d] = (store.linkSalt[d] || 0) + 1; save();
      res.writeHead(303, { location: '/admin?key=' + encodeURIComponent(ADMIN_KEY) }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(adminPage(req)); return;
  }
  const STATIC = { '/bgm.mp3': 'audio/mpeg', '/hall.mp3': 'audio/mpeg', '/hall.glb': 'model/gltf-binary', '/hall_props_lm.jpg': 'image/jpeg', '/hall_floor_lm.jpg': 'image/jpeg', '/hall_bake.json': 'application/json' };
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
  if (u0.pathname !== '/' && u0.pathname !== '/index.html') { res.writeHead(404); res.end('not found'); return; }
  if (!hasPass(req)) { res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(EXPIRED); return; }
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (LINK_SECRET) {
    const secure = (req.headers['x-forwarded-proto'] || '').startsWith('https') ? '; Secure' : '';
    headers['set-cookie'] = `mbw=${todayToken()}; Path=/; Max-Age=${secsToMidnight()}; HttpOnly; SameSite=Lax${secure}`;
  }
  fs.readFile(HTML_PATH, (err, html) => {
    if (err) { res.writeHead(500); res.end('index.html not found'); return; }
    res.writeHead(200, headers); res.end(html);
  });
});

// ---------- realtime ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024, verifyClient: info => hasPass(info.req) });
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
      const pid = Number.isInteger(m.pid) ? m.pid : -1; const t = PHRASES[pid]; if (!t) return;
      const now = Date.now(); if (now - c.lastChat < 600) return; c.lastChat = now;
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
