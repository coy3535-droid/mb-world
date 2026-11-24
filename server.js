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
let store = { chat: [], players: {}, wishes: {}, linkSalt: {}, news: [] };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
if (!store.newsEdited) { try { store.news = JSON.parse(fs.readFileSync(path.join(__dirname, 'news.json'), 'utf8')); } catch (e) { store.news = store.news || []; } }
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
let WX = null;
// ---------- daily visit log ----------
function visitDay(day) { store.visits = store.visits || {}; const v = store.visits[day] || (store.visits[day] = {});
  const keys = Object.keys(store.visits).sort(); while (keys.length > 14) delete store.visits[keys.shift()]; return v; }
function visitStart(c) { const now = Date.now(), v = visitDay(kstDay()), r = v[c.token] || (v[c.token] = { n: c.n, p: c.p, first: now, last: now, cnt: 0, ms: 0 });
  r.n = c.n; r.p = c.p; r.last = now; r.cnt++; c.joinAt = now; c.visitDay = kstDay(); save(); }
function visitEnd(c) { if (!c.joinAt) return; const now = Date.now(), v = visitDay(c.visitDay || kstDay()), r = v[c.token]; if (r) { r.ms += now - c.joinAt; r.last = now; } c.joinAt = 0; save(); }
function visitProfile(c) { const r = visitDay(c.visitDay || kstDay())[c.token]; if (r) { r.n = c.n; r.p = c.p; } }
async function refreshWeather() {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=1', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!j.daily || !j.current) throw new Error('bad response ' + r.status + ' ' + JSON.stringify(j).slice(0, 160));
    const w = { code: j.daily.weather_code[0], now: j.current.weather_code, t: Math.round(j.current.temperature_2m), tmax: Math.round(j.daily.temperature_2m_max[0]), tmin: Math.round(j.daily.temperature_2m_min[0]), pop: (j.daily.precipitation_probability_max || [null])[0], day: kstDay(), at: Date.now() };
    const changed = !WX || WX.code !== w.code || WX.t !== w.t; WX = w;
    if (changed && typeof broadcast === 'function') broadcast({ type: 'weather', wx: WX });
  } catch (e) { console.log('weather fetch failed', e.message); setTimeout(refreshWeather, / 429 /.test(e.message) ? 60 * 60e3 : 5 * 60e3); }
}
setTimeout(refreshWeather, 500); setInterval(refreshWeather, 20 * 60e3);
function normStats(s) {
  if (!s || typeof s !== 'object') return null;
  const d = s.day && typeof s.day === 'object' ? s.day : {};
  return {
    pts: num(s.pts, 0, 1e9), bolts: num(s.bolts, 0, 1e9), set: num(s.set, 0, 107), best: num(s.best, 0, 36e5), race: num(s.race, 0, 36e5), gp: num(s.gp, 0, 36e5),
    streak: num(s.streak, 0, 9999), last: clean(s.last, 10), days: num(s.days, 0, 99999),
    day: { d: clean(d.d, 10), polish: num(d.polish, 0, 99), coffee: num(d.coffee, 0, 99), laps: num(d.laps, 0, 999), quiz: num(d.quiz, 0, 1), wish: num(d.wish, 0, 1), zen: num(d.zen, 0, 1), tr: num(d.tr, 0, 1023), ring: num(d.ring, 0, 99) },
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
let QR = null; try { QR = require('qrcode'); } catch (e) {}
function fmtHM(ts) { return new Date(ts + 9 * 3600e3).toISOString().slice(11, 16); }
function fmtDur(ms) { const m = Math.round(ms / 60000); return m < 1 ? '1분 미만' : m < 60 ? m + '분' : Math.floor(m / 60) + '시간 ' + (m % 60) + '분'; }
function visitBox(logDay) {
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const V = (store.visits || {})[logDay] || {}, now = Date.now(), live = new Map([...online.values()].filter(o => o.joined && o.joinAt).map(o => [o.token, o]));
  const rows = Object.entries(V).map(([tk, r]) => { const o = live.get(tk); return { ...r, on: !!o, ms: r.ms + (o && logDay === kstDay() ? now - o.joinAt : 0) }; }).sort((a, b) => b.last - a.last);
  const days = Object.keys(store.visits || {}).sort().reverse().slice(0, 7);
  const tabs = days.map(d => `<a href="/admin?key=${encodeURIComponent(ADMIN_KEY)}&day=${d}#log" style="padding:6px 10px;border-radius:999px;border:1px solid #2a2d35;color:${d === logDay ? '#001018' : '#cfd3da'};background:${d === logDay ? '#00adef' : 'transparent'};text-decoration:none;font-size:12px">${d.slice(5).replace('-', '/')} · ${Object.keys(store.visits[d]).length}명</a>`).join('');
  const total = rows.reduce((a, r) => a + r.cnt, 0);
  const tr = rows.map(r => `<tr><td>${r.on ? '🟢 ' : ''}<b>${esc(r.n)}</b>${r.p ? `<br><span>${esc(r.p)}</span>` : ''}</td><td>${fmtHM(r.first)}</td><td>${r.on ? '접속 중' : fmtHM(r.last)}</td><td>${r.cnt}회</td><td>${fmtDur(r.ms)}</td></tr>`).join('');
  return `<div class="box" id="log"><div class="l">📋 접속자 로그 · ${logDay}${logDay === kstDay() ? ' (오늘)' : ''}</div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${tabs}</div>
<div style="font-size:13px;margin-bottom:8px">방문 <b>${rows.length}명</b> · 접속 <b>${total}회</b> · 지금 접속 중 <b>${rows.filter(r => r.on).length}명</b></div>
${rows.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;line-height:1.5"><thead><tr style="color:#9aa0aa;text-align:left"><th style="padding:6px 4px">이름 · 소속</th><th>첫 접속</th><th>마지막</th><th>횟수</th><th>머문 시간</th></tr></thead><tbody>${tr}</tbody></table></div>` : '<div class="s">아직 기록이 없어요.</div>'}
<a href="/admin/visits.csv?key=${encodeURIComponent(ADMIN_KEY)}&day=${logDay}" style="display:block;text-align:center;margin-top:10px;color:#00adef;font-size:13px">⬇️ CSV로 받기</a>
<div class="s">시간은 한국 시간 기준이에요. 서버를 새로 배포하면 그 전 기록은 지워져요 (무료 서버 특성).</div></div>`;
}
async function adminPage(req) {
  const logDay = (new URL(req.url, 'http://x').searchParams.get('day') || '').match(/^\d{4}-\d{2}-\d{2}$/) ? new URL(req.url, 'http://x').searchParams.get('day') : kstDay();
  const day = kstDay(), link = origin(req) + '/?k=' + todayToken(day), n = [...online.values()].filter(c => c.joined).length;
  const msg = `☕ MB World — 지점장님들의 쉼터\n\n머리가 복잡하거나 잠깐 숨 돌리고 싶을 때 들러보세요.\n낙하산 타고 내려와 천천히 걷고, 쉬고, 가볍게 인사 나누는 작은 공간이에요.\n\n🪂 비행기에서 낙하산으로 입장\n💎 매일 바뀌는 보물찾기 8곳\n🏁 지도 한 바퀴 MB 그랑프리 (3랩)\n🗼 등대·전망탑에 올라 풍경 보기\n🏊 강에서 수영 · 🧘 MB 홀에서 1분 쉬어가기\n☀️ 오늘 서울 날씨가 그대로 MB World에\n\n👉 오늘의 입장 링크 (오늘 밤 12시까지)\n${link}\n\n※ 앱 설치 없이 링크만 누르면 돼요`;
  const msgEn = `☕ MB World — A Little Break for Our Service Managers\n\nWhen your head feels full or you just need a breather, drop by.\nParachute in, take a slow walk, sit for a moment, and say hi to colleagues.\n\n🪂 Enter by parachute from a plane\n💎 Daily treasure hunt — 8 hidden chests\n🏁 MB Grand Prix — 3 laps around the whole map\n🗼 Climb the lighthouse & lookout towers\n🏊 Swim in the river · 🧘 Take a 1-minute rest in MB Hall\n☀️ Today's Seoul weather, live in MB World\n\n👉 Today's entry link (valid until midnight KST)\n${link}\n\n※ No app needed — just tap the link`;
  let qr = '';
  try { if (QR) qr = await QR.toString(link, { type: 'svg', margin: 1, width: 200, color: { dark: '#000000', light: '#ffffff' } }); } catch (e) {}
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MB World 관리자</title>
<style>body{margin:0;background:#0e0f12;color:#e9ebef;font-family:system-ui,'Noto Sans KR',sans-serif;padding:24px;display:flex;justify-content:center}.c{width:min(460px,100%)}h1{font-size:18px;letter-spacing:.15em}h1 b{color:#00adef}
.box{background:#16181d;border:1px solid #2a2d35;border-radius:16px;padding:18px;margin-top:14px}.l{font-size:12px;color:#9aa0aa;margin-bottom:6px}
textarea{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2d35;border-radius:10px;padding:12px;font:inherit;font-size:14px;color:#e9ebef;resize:none;-webkit-user-select:text;user-select:text}
button{all:unset;cursor:pointer;display:block;text-align:center;background:#00adef;color:#001018;font-weight:700;padding:12px;border-radius:12px;margin-top:10px;width:100%;box-sizing:border-box}button.g{background:transparent;color:#cfd3da;border:1px solid #2a2d35}
input{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2d35;border-radius:10px;padding:11px 12px;font:inherit;font-size:14px;color:#e9ebef;margin-top:8px}.it{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid #2a2d35;padding:10px 0;font-size:13px;line-height:1.6}.it span{color:#9aa0aa}.it a{color:#00adef;word-break:break-all}.it form{flex:none}button.x{width:auto;padding:8px 12px;margin:0;font-size:12px}
.qr{background:#fff;border-radius:12px;padding:10px;width:200px;margin:14px auto 0}.qr svg{display:block;width:100%;height:auto}.s{font-size:12px;color:#9aa0aa;line-height:1.7;margin-top:10px}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#00adef;color:#001018;font-weight:700;padding:10px 18px;border-radius:999px;opacity:0;transition:opacity .3s;pointer-events:none}</style></head>
<body><div class="c"><h1><b>MB</b> WORLD · 관리자</h1>
<div class="box"><div class="l">${day} (KST) 오늘의 초대 링크 · 오늘 밤 12시까지 유효</div>
<textarea id="u" rows="2" readonly>${esc(link)}</textarea>
<button type="button" data-copy="u">링크 복사</button>
<button type="button" class="g" id="share">📤 카톡·팀즈로 바로 보내기</button>
${qr ? `<div class="qr">${qr}</div>` : ''}
<div class="s">이 링크를 받은 사람만 오늘 하루 들어올 수 있어요. 자정이 지나면 자동으로 막히고, 내일 링크가 새로 만들어져요.<br>현재 접속 중: <b>${n}명</b></div></div>
<div class="box"><div class="l">카톡·팀즈 공유 문구</div><textarea id="msg" rows="12" readonly>${esc(msg)}</textarea><button type="button" class="g" data-copy="msg">공유 문구 복사</button></div>
<div class="box"><div class="l">English share message</div><textarea id="msgEn" rows="12" readonly>${esc(msgEn)}</textarea><button type="button" class="g" data-copy="msgEn">Copy English message</button><button type="button" class="g" id="shareEn">📤 Share (English)</button></div>
${visitBox(logDay)}
<div class="box" id="news"><div class="l">📢 전광판 소식 (MB 광장, 최대 6개 · 최신이 먼저)</div>
${(store.news || []).map(n => `<div class="it"><div><b>${esc(n.t)}</b>${n.d ? `<br><span>${esc(n.d)}</span>` : ''}${n.u ? `<br><a href="${esc(n.u)}" target="_blank" rel="noopener">${esc(n.u)}</a>` : ''}</div><form method="post" action="/admin/news?key=${encodeURIComponent(ADMIN_KEY)}" onsubmit="return confirm('이 소식을 내릴까요?')"><input type="hidden" name="del" value="${esc(n.id)}"><button class="g x" type="submit">내리기</button></form></div>`).join('') || '<div class="s">아직 올린 소식이 없어요.</div>'}
<form method="post" action="/admin/news?key=${encodeURIComponent(ADMIN_KEY)}" style="margin-top:12px"><input name="t" maxlength="40" placeholder="제목 (전광판에 크게 나와요)" required><input name="d" maxlength="80" placeholder="한 줄 설명 (선택)"><input name="u" maxlength="500" placeholder="링크 https://... (선택)" inputmode="url"><button type="submit">전광판에 올리기</button></form></div>
<div class="box"><div class="l">링크가 원치 않는 곳에 퍼졌다면</div><form method="post" action="/admin/rotate?key=${encodeURIComponent(ADMIN_KEY)}" onsubmit="return confirm('오늘 링크를 새로 만들까요? 기존 링크로는 더 이상 들어올 수 없어요.')"><button class="g" type="submit">오늘 링크 새로 만들기</button></form></div>
</div><div id="toast"></div><script>
function toast(t){var e=document.getElementById('toast');e.textContent=t;e.style.opacity=1;clearTimeout(e._t);e._t=setTimeout(function(){e.style.opacity=0},1800);}
function legacyCopy(el){el.removeAttribute('readonly');el.focus();el.select();el.setSelectionRange(0,99999);var ok=false;try{ok=document.execCommand('copy');}catch(e){}el.setAttribute('readonly','');el.blur();return ok;}
function copyFrom(id){var el=document.getElementById(id),t=el.value;
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){toast('복사했어요 ✓')},function(){toast(legacyCopy(el)?'복사했어요 ✓':'글자를 길게 눌러 복사해 주세요')});}
  else toast(legacyCopy(el)?'복사했어요 ✓':'글자를 길게 눌러 복사해 주세요');}
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){copyFrom(b.getAttribute('data-copy'))});});
var sh=document.getElementById('share');
if(navigator.share){sh.addEventListener('click',function(){navigator.share({title:'MB World — 지점장님들의 쉼터',text:document.getElementById('msg').value}).catch(function(){});});}
else{sh.textContent='📤 공유 문구 복사';sh.addEventListener('click',function(){copyFrom('msg')});}
var se=document.getElementById('shareEn');
if(navigator.share){se.addEventListener('click',function(){navigator.share({title:'MB World',text:document.getElementById('msgEn').value}).catch(function(){});});}else se.style.display='none';
</script></body></html>`;
}

// ---------- http ----------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }
  const u0 = new URL(req.url, 'http://x');
  if (u0.pathname === '/weather') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(WX || {})); return; }
  if (u0.pathname === '/admin' || u0.pathname === '/admin/rotate' || u0.pathname === '/admin/news' || u0.pathname === '/admin/visits.csv') {
    if (!ADMIN_KEY || !LINK_SECRET || !safeEq(u0.searchParams.get('key') || '', ADMIN_KEY)) { res.writeHead(404); res.end('not found'); return; }
    if (u0.pathname === '/admin/visits.csv') {
      const d = (u0.searchParams.get('day') || '').match(/^\d{4}-\d{2}-\d{2}$/) ? u0.searchParams.get('day') : kstDay(), V = (store.visits || {})[d] || {};
      const q = t => '"' + String(t).replace(/"/g, '""') + '"';
      const lines = ['이름,소속,첫 접속,마지막,횟수,머문 시간(분)'].concat(Object.values(V).sort((a, b) => a.first - b.first).map(r => [q(r.n), q(r.p || ''), fmtHM(r.first), fmtHM(r.last), r.cnt, Math.round(r.ms / 60000)].join(',')));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="mbworld-visits-${d}.csv"` }); res.end('﻿' + lines.join('\n')); return;
    }
    if (u0.pathname === '/admin/rotate' && req.method === 'POST') {
      const d = kstDay(); store.linkSalt = store.linkSalt || {}; store.linkSalt[d] = (store.linkSalt[d] || 0) + 1; save();
      res.writeHead(303, { location: '/admin?key=' + encodeURIComponent(ADMIN_KEY) }); res.end(); return;
    }
    if (u0.pathname === '/admin/news' && req.method === 'POST') {
      let body = ''; req.on('data', d => { body += d; if (body.length > 8000) req.destroy(); });
      req.on('end', () => {
        const f = new URLSearchParams(body); store.news = store.news || []; store.newsEdited = true;
        if (f.get('del')) store.news = store.news.filter(n => n.id !== f.get('del'));
        else {
          const t = clean(f.get('t'), 40), d = clean(f.get('d'), 80), uu = clean(f.get('u'), 500);
          if (t) store.news.unshift({ id: crypto.randomBytes(5).toString('hex'), t, d, u: /^https?:\/\/\S+$/i.test(uu) ? uu : '', at: Date.now() });
          store.news = store.news.slice(0, 6);
        }
        save(); broadcast({ type: 'news', items: store.news });
        res.writeHead(303, { location: '/admin?key=' + encodeURIComponent(ADMIN_KEY) + '#news' }); res.end();
      }); return;
    }
    adminPage(req).then(h => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(h); }); return;
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
    n: p.n, p: p.p, c: p.c, pts: p.st.pts, bolts: p.st.bolts, best: p.st.gp || 0, streak: p.st.streak,
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
      c.x = num(m.x, -2400, 4800); c.y = num(m.y, -1800, 3300);
      c.token = /^[a-z0-9]{8,64}$/i.test(m.token || '') ? m.token : crypto.randomBytes(12).toString('hex');
      // same person in another tab: keep only the newest
      for (const [ows, oc] of online) if (ows !== ws && oc.token === c.token && oc.joined) { visitEnd(oc); oc.joined = false; broadcast({ type: 'leave', id: oc.id }, ws); ows.close(4000, 'replaced'); }
      c.joined = true; visitStart(c);
      const rec = store.players[c.token];
      if (rec) { rec.n = c.n; rec.p = c.p; rec.c = c.c; }
      send(ws, {
        type: 'welcome', id: c.id,
        peers: [...online.values()].filter(o => o.joined && o !== c).map(peerOf),
        history: store.chat.slice(-80), board: boardPayload(), news: store.news || [], wx: WX, mystats: rec ? rec.st : null,
      });
      broadcast({ type: 'peer', ...peerOf(c) }, ws);
      return;
    }
    if (!c.joined) return;

    if (m.type === 'state') {
      c.x = num(m.x, -2400, 4800); c.y = num(m.y, -1800, 3300); c.h = Math.max(-7, Math.min(7, +m.h || 0)); c.m = m.m ? 1 : 0; c.s = m.s ? 1 : 0; c.v = Math.max(0, Math.min(3, m.v | 0)); c.ca = Math.max(-1e4, Math.min(1e4, +m.ca || 0));
      if (typeof m.e === 'string') { c.e = clean(m.e, 4); c.et = num(m.et, 0, 9e15); }
      broadcast({ type: 'peer', ...peerOf(c) }, ws);
    } else if (m.type === 'profile') {
      c.n = clean(m.n, 16) || c.n; c.p = clean(m.p, 24); c.c = color(m.c);
      visitProfile(c);
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

  ws.on('close', () => { online.delete(ws); if (c.joined) { visitEnd(c); broadcast({ type: 'leave', id: c.id }); } });
});

setInterval(() => { for (const c of online.values()) c.bucket = Math.min(60, c.bucket + 40); }, 1000);
setInterval(() => { for (const [ws, c] of online) { if (!c.alive) { ws.terminate(); continue; } c.alive = false; try { ws.ping(); } catch (e) {} } }, 30000);

server.listen(PORT, () => console.log(`MB World running on http://localhost:${PORT}${ACCESS_CODE ? '  (입장 코드 사용 중)' : ''}`));
