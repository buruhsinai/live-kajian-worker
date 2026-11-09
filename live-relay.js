/* JAZMI — Relay audio kajian (Worker "live-kajian" + Durable Object "Ruang").
   Tanpa SFU/TURN Cloudflare. Satu Durable Object per sesi kajian: menerima blok audio dari pengajar
   lewat WebSocket dan meneruskannya ke semua penonton. Memakai WebSocket Hibernation API.
   Rute:  /siar?s=<id sesi>    pengajar (wajib login Supabase + terdaftar di tabel pengajar; token lewat Sec-WebSocket-Protocol)
          /dengar?s=<id sesi>  penonton (tanpa login; dibatasi MAX_PENDENGAR)
          /gambar?s=<sesi>&v=<kunci kitab>&n=<halaman>
              GET     penonton mengambil gambar JPEG halaman (tanpa login)
              POST    pengajar mengunggah gambar halaman (header Authorization: Bearer <token Supabase>)
              DELETE  pengajar menghapus semua gambar sesi ini (tanpa n)
          Gambar disimpan di SQLite milik Durable Object sesi, sementara saja (dihapus otomatis 12 jam setelah unggahan terakhir).
          /alat-siar?s=<id sesi>    pengajar mengirim peristiwa alat peraga (JSON teks; token sama seperti /siar)
          /alat-dengar?s=<id sesi>  penonton menerima peristiwa alat peraga (tanpa login; dibatasi MAX_PENDENGAR)
          /dengar dan /alat-dengar juga wajib &k=<kunci penonton 32 heks> yang punya kursi (Fase 3, supabase-live-kursi.sql); KURSI_WAJIB=off mematikan pemeriksaan.
          Yang lewat saluran alat hanya peristiwa kecil (klik, nilai slider, gerak penunjuk), TIDAK PERNAH kode atau isi alat. */
import { DurableObject } from 'cloudflare:workers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAKS_BLOK = 16384; // byte; blok normal ±2 KB
const KUNCI = /^[0-9a-f]{6,32}$/i;
const MAKS_GAMBAR = 1500000;           // byte per halaman (batas baris SQLite DO = 2 MB; pengajar mengirim ≤ 1,4 MB)
const MAKS_HALAMAN = 2000;
const UMUR_GAMBAR = 12 * 3600 * 1000;  // ms sejak unggahan terakhir
const MAKS_PESAN_ALAT = 4096;         // karakter per peristiwa alat
const MAKS_LOG_ALAT = 300;            // peristiwa yang diingat untuk penonton yang masuk terlambat
const SIMPAN_ALAT = { i: 1, c: 1, d: 1, u: 1, pd: 1, pu: 1, md: 1, mu: 1, td: 1, tu: 1, pm: 1, mm: 1, tm: 1 };   // jenis yang disimpan: nilai kontrol (hanya yang terakhir per elemen), klik, tombol, tekan/lepas penunjuk. Gerak (pm/mm/tm) hanya disimpan saat menyeret, dan hanya titik terakhir tiap seretan.
const JENIS_ALAT = /^(i|c|d|u|pd|pm|pu|md|mm|mu|td|tm|tu)$/;

function tolak(status, teks) { return new Response(teks, { status }); }
function daftarAsal(env) { return (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }
function asalBoleh(env, req) { const a = daftarAsal(env); return !a.length || a.indexOf(req.headers.get('Origin')) >= 0; }
/* tambahkan header CORS untuk asal yang diizinkan (dipakai oleh unggah dari studio) */
function denganCors(env, req, res) {
  const r = new Response(res.body, res), o = req.headers.get('Origin');
  if (o && daftarAsal(env).indexOf(o) >= 0) { r.headers.set('Access-Control-Allow-Origin', o); r.headers.append('Vary', 'Origin'); }
  r.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return r;
}

const SAH = new Map();   // cache 60 detik per isolate: token+sesi → waktu kedaluwarsa (agar unggahan beruntun tidak memanggil Supabase tiap kali)
async function pengajarSah(env, token, sesi) {
  const ck = sesi + '|' + token, now = Date.now();
  if ((SAH.get(ck) || 0) > now) return true;
  if (SAH.size > 200) SAH.clear();
  const ok = await pengajarSahLangsung(env, token, sesi);
  if (ok) SAH.set(ck, now + 60000);
  return ok;
}
async function pengajarSahLangsung(env, token, sesi) {
  const h = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  try {
    const a = await fetch(env.SUPABASE_URL + '/rest/v1/pengajar?select=user_id&limit=1', { headers: h });
    if (!a.ok || !(await a.json()).length) return false;            // token salah, atau bukan pengajar (RLS)
    const b = await fetch(env.SUPABASE_URL + '/rest/v1/live_sesi?select=id&status=eq.live&id=eq.' + sesi + '&limit=1', { headers: { apikey: env.SUPABASE_ANON_KEY } });
    return b.ok && (await b.json()).length === 1;                   // sesi harus sedang live
  } catch (e) { return false; }
}

/* Fase 3: penonton hanya boleh membuka audio/alat bila kuncinya punya kursi (RPC kursi_sah di Supabase).
   Hanya jawaban `false` yang menolak. Supabase tak terjangkau, atau fungsi belum dipasang → dilewatkan (batas MAX_PENDENGAR di Durable Object tetap berlaku). */
const KURSI = new Map();
async function kursiSah(env, sesi, k) {
  if (env.KURSI_WAJIB === 'off') return true;
  const ck = sesi + '|' + k, now = Date.now(), c = KURSI.get(ck);
  if (c && c > now) return true;
  try {
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/kursi_sah', { method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_sesi: sesi, p_kunci: k }) });
    if (!r.ok) return true;
    const j = await r.json();
    if (j === false) return false;
    if (KURSI.size > 500) KURSI.clear();
    KURSI.set(ck, now + 20000);
    return true;
  } catch (e) { return true; }
}

async function gambarRute(req, env, u) {
  const sesi = u.searchParams.get('s'), v = u.searchParams.get('v'), n = Number(u.searchParams.get('n'));
  if (req.method === 'OPTIONS') {
    if (!asalBoleh(env, req)) return tolak(403, 'Origin tidak diizinkan');
    return denganCors(env, req, new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '86400' } }));
  }
  const balas = function (res) { return denganCors(env, req, res); };
  if (!sesi || !UUID.test(sesi)) return balas(tolak(400, 'Sesi tidak valid'));
  const stub = env.RUANG.get(env.RUANG.idFromName(sesi));
  if (req.method === 'GET') {
    if (!v || !KUNCI.test(v) || !(n >= 1 && n <= MAKS_HALAMAN && Number.isInteger(n))) return balas(tolak(400, 'Parameter tidak valid'));
    return balas(await stub.fetch(req));
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') return balas(tolak(405, 'Metode tidak didukung'));
  if (!asalBoleh(env, req)) return balas(tolak(403, 'Origin tidak diizinkan'));
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) return balas(tolak(401, 'Butuh token'));
  if (!(await pengajarSah(env, m[1], sesi))) return balas(tolak(403, 'Ditolak: bukan pengajar, atau sesi tidak sedang live'));
  if (req.method === 'POST') {
    if (!v || !KUNCI.test(v) || !(n >= 1 && n <= MAKS_HALAMAN && Number.isInteger(n))) return balas(tolak(400, 'Parameter tidak valid'));
    if (Number(req.headers.get('Content-Length')) > MAKS_GAMBAR) return balas(tolak(413, 'Gambar terlalu besar'));
  }
  return balas(await stub.fetch(req));
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/') return new Response('live-kajian relay ok');
    if (u.pathname === '/gambar') return gambarRute(req, env, u);
    if (req.headers.get('Upgrade') !== 'websocket') return tolak(426, 'Butuh WebSocket');
    if (!asalBoleh(env, req)) return tolak(403, 'Origin tidak diizinkan');
    const sesi = u.searchParams.get('s');
    if (!sesi || !UUID.test(sesi)) return tolak(400, 'Sesi tidak valid');
    if (u.pathname === '/siar' || u.pathname === '/alat-siar') {
      const p = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(function (s) { return s.trim(); });
      if (p[0] !== 'jazmi' || !p[1]) return tolak(401, 'Butuh token');
      if (!(await pengajarSah(env, p[1], sesi))) {
        // upgrade lalu tutup dengan kode 4003 agar studio bisa menampilkan alasannya
        const pair = new WebSocketPair();
        pair[1].accept(); pair[1].close(4003, 'ditolak');
        return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'jazmi' } });
      }
    } else if (u.pathname !== '/dengar' && u.pathname !== '/alat-dengar') return tolak(404, 'Tidak ada');
    else {
      const k = u.searchParams.get('k') || '';
      if (!(await kursiSah(env, sesi, k))) return tolak(403, 'Tidak punya kursi');
    }
    return env.RUANG.get(env.RUANG.idFromName(sesi)).fetch(req);   // DO hanya terjangkau lewat Worker ini
  },
};

export class Ruang extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // "ping" dari penonton dijawab "pong" tanpa membangunkan objek (tidak ditagih)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS halaman (v TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (v, n))');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alat_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kunci TEXT, data TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alat_meta (k TEXT PRIMARY KEY, v TEXT)');
  }

  /* gambar halaman kitab: satu kitab (kunci v) pada satu waktu; kitab baru menghapus yang lama */
  async gambar(req, u) {
    const sql = this.ctx.storage.sql, v = u.searchParams.get('v'), n = Number(u.searchParams.get('n'));
    if (req.method === 'GET') {
      const r = sql.exec('SELECT data FROM halaman WHERE v = ? AND n = ?', v, n).toArray();
      if (!r.length) return new Response('belum ada', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return new Response(r[0].data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400, immutable' } });
    }
    if (req.method === 'DELETE') { sql.exec('DELETE FROM halaman'); return new Response('dihapus'); }
    const buf = await req.arrayBuffer(), b = new Uint8Array(buf);
    if (b.length > MAKS_GAMBAR) return tolak(413, 'Gambar terlalu besar');
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8 || b[2] !== 0xFF) return tolak(415, 'Harus gambar JPEG');
    sql.exec('DELETE FROM halaman WHERE v != ?', v);
    const maks = (Number(this.env.MAKS_TOTAL_MB) || 300) * 1048576;
    const pakai = sql.exec('SELECT COALESCE(SUM(length(data)), 0) AS t FROM halaman WHERE n != ?', n).one().t;
    if (pakai + b.length > maks) return tolak(507, 'Penyimpanan gambar penuh untuk sesi ini');
    sql.exec('INSERT OR REPLACE INTO halaman (v, n, data) VALUES (?, ?, ?)', v, n, buf);
    await this.ctx.storage.setAlarm(Date.now() + UMUR_GAMBAR);
    return new Response('ok');
  }

  async alarm() { this.ctx.storage.sql.exec('DELETE FROM halaman'); this.ctx.storage.sql.exec('DELETE FROM alat_log'); this.ctx.storage.sql.exec('DELETE FROM alat_meta'); }

  /* ---- saluran alat peraga ---- */
  nonceAlat() { const r = this.ctx.storage.sql.exec("SELECT v FROM alat_meta WHERE k = 'n'").toArray(); return r.length ? r[0].v : null; }

  keadaanAlat() {
    const n = this.nonceAlat();
    if (!n) return { t: 'mulai', n: null, log: [] };
    return { t: 'mulai', n, log: this.ctx.storage.sql.exec('SELECT data FROM alat_log ORDER BY id').toArray().map(function (r) { return r.data; }) };
  }

  siarAlat(str) { this.buka('al').forEach(function (w) { try { w.send(str); } catch (e) { } }); }

  /* pesan dari pengajar di saluran alat; dipisah dari webSocketMessage supaya mudah diuji */
  pesanAlat(str) {
    if (typeof str !== 'string' || str.length > MAKS_PESAN_ALAT) return;
    let j; try { j = JSON.parse(str); } catch (e) { return; }
    if (!j || typeof j !== 'object') return;
    const sql = this.ctx.storage.sql;
    if (j.t === 'baru' || j.t === 'tutup') {
      if (j.t === 'baru' && (typeof j.n !== 'string' || !KUNCI.test(j.n))) return;
      sql.exec('DELETE FROM alat_log');
      if (j.t === 'baru') {
        sql.exec("INSERT OR REPLACE INTO alat_meta (k, v) VALUES ('n', ?)", j.n);
        this.siarAlat(JSON.stringify({ t: 'baru', n: j.n }));
      } else {
        sql.exec("DELETE FROM alat_meta WHERE k = 'n'");
        this.siarAlat(JSON.stringify({ t: 'tutup' }));
      }
      return;
    }
    if (j.t !== 'e' || typeof j.k !== 'string' || !JENIS_ALAT.test(j.k) || typeof j.n !== 'string' || j.n !== this.nonceAlat()) return;   // hanya untuk alat yang sedang dibuka
    if (SIMPAN_ALAT[j.k]) {
      const gerak = j.k === 'pm' || j.k === 'mm' || j.k === 'tm';
      if (gerak && j.k !== 'tm' && !((j.s | 0) > 0)) { this.siarAlat(str); return; }      // gerak tanpa tombol ditekan = melayang saja, tidak disimpan
      let kunci = null;
      if (j.k === 'i' && typeof j.p === 'string') kunci = 'i|' + j.p;
      else if (gerak && typeof j.p === 'string') kunci = 'g|' + j.k + '|' + j.p;
      if (kunci) sql.exec('DELETE FROM alat_log WHERE kunci = ?', kunci);
      if (!gerak) sql.exec("UPDATE alat_log SET kunci = NULL WHERE kunci LIKE 'g|%'");   // seretan sebelumnya selesai: titik terakhirnya dibekukan
      sql.exec('INSERT INTO alat_log (kunci, data) VALUES (?, ?)', kunci, str);
      const id = sql.exec('SELECT last_insert_rowid() AS id').one().id;
      j.q = id; str = JSON.stringify(j);                                                 // nomor urut: penonton yang sempat putus meminta yang tertinggal
      sql.exec('UPDATE alat_log SET data = ? WHERE id = ?', str, id);
      sql.exec('DELETE FROM alat_log WHERE id <= (SELECT MAX(id) FROM alat_log) - ?', MAKS_LOG_ALAT);
      this.ctx.storage.setAlarm(Date.now() + UMUR_GAMBAR);
    }
    this.siarAlat(str);
  }

  buka(tag) { return this.ctx.getWebSockets(tag).filter(function (w) { return w.readyState === 1; }); }

  kirimJson(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) { } }

  status() {
    const h = this.buka('host')[0];
    return { t: 's', h: h ? 1 : 0, jeda: !!(h && (h.deserializeAttachment() || {}).jeda) };
  }

  siarkanStatus() { const s = JSON.stringify(this.status()); this.buka('l').forEach(function (w) { try { w.send(s); } catch (e) { } }); }

  laporPendengar() { const n = this.buka('l').length; this.buka('host').forEach((h) => this.kirimJson(h, { t: 'n', n })); }

  /* dipisah dari fetch() supaya mudah diuji */
  tambah(server, peran) {
    if (peran === 'ah') {
      this.buka('ah').forEach(function (w) { try { w.close(4000, 'diganti'); } catch (e) { } });
      this.ctx.acceptWebSocket(server, ['ah']);
      return;
    }
    if (peran === 'al') {
      const maks = Number(this.env.MAX_PENDENGAR) || 80;
      if (this.buka('al').length >= maks) {
        this.ctx.acceptWebSocket(server, ['x']);
        this.kirimJson(server, { t: 'penuh', maks }); server.close(4001, 'penuh'); return;
      }
      this.ctx.acceptWebSocket(server, ['al']);
      this.kirimJson(server, this.keadaanAlat());
      return;
    }
    if (peran === 'host') {
      this.buka('host').forEach(function (w) { try { w.close(4000, 'diganti'); } catch (e) { } });
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ jeda: false });
      this.siarkanStatus(); this.laporPendengar();
    } else {
      const maks = Number(this.env.MAX_PENDENGAR) || 80;
      if (this.buka('l').length >= maks) {
        this.ctx.acceptWebSocket(server, ['x']);
        this.kirimJson(server, { t: 'penuh', maks }); server.close(4001, 'penuh'); return;
      }
      this.ctx.acceptWebSocket(server, ['l']);
      this.kirimJson(server, this.status()); this.laporPendengar();
    }
  }

  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/gambar') return this.gambar(req, u);
    const peran = u.pathname === '/siar' ? 'host' : u.pathname === '/alat-siar' ? 'ah' : u.pathname === '/alat-dengar' ? 'al' : 'l';
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.tambah(server, peran);
    const h = {}; if (peran === 'host' || peran === 'ah') h['Sec-WebSocket-Protocol'] = 'jazmi';
    return new Response(null, { status: 101, webSocket: client, headers: h });
  }

  webSocketMessage(ws, msg) {
    const tags = this.ctx.getTags(ws);
    if (tags.indexOf('ah') >= 0) { this.pesanAlat(msg); return; }
    if (tags.indexOf('host') < 0) return;                          // penonton tidak boleh mengirim apa pun
    if (typeof msg === 'string') {
      try {
        const j = JSON.parse(msg);
        if (j.t === 'jeda') { ws.serializeAttachment({ jeda: !!j.v }); this.siarkanStatus(); }
      } catch (e) { }
      return;
    }
    if (msg.byteLength > MAKS_BLOK) return;
    this.buka('l').forEach(function (w) { try { w.send(msg); } catch (e) { } });
  }

  webSocketClose(ws, code) {
    const tags = this.ctx.getTags(ws);
    try { ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, 'bye'); } catch (e) { }
    if (tags.indexOf('host') >= 0) this.siarkanStatus(); else if (tags.indexOf('l') >= 0) this.laporPendengar();
  }

  webSocketError(ws) { this.webSocketClose(ws, 1011); }
}
