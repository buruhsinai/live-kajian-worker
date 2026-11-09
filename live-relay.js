/* JAZMI — Relay audio kajian (Worker "live-kajian" + Durable Object "Ruang").
   Tanpa SFU/TURN Cloudflare. Satu Durable Object per sesi kajian: menerima blok audio dari pengajar
   lewat WebSocket dan meneruskannya ke semua penonton. Memakai WebSocket Hibernation API.
   Rute:  /siar?s=<id sesi>    pengajar (wajib login Supabase + terdaftar di tabel pengajar; token lewat Sec-WebSocket-Protocol)
          /dengar?s=<id sesi>  penonton (tanpa login; dibatasi MAX_PENDENGAR) */
import { DurableObject } from 'cloudflare:workers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAKS_BLOK = 16384; // byte; blok normal ±2 KB

function tolak(status, teks) { return new Response(teks, { status }); }

async function pengajarSah(env, token, sesi) {
  const h = { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
  try {
    const a = await fetch(env.SUPABASE_URL + '/rest/v1/pengajar?select=user_id&limit=1', { headers: h });
    if (!a.ok || !(await a.json()).length) return false;            // token salah, atau bukan pengajar (RLS)
    const b = await fetch(env.SUPABASE_URL + '/rest/v1/live_sesi?select=id&status=eq.live&id=eq.' + sesi + '&limit=1', { headers: { apikey: env.SUPABASE_ANON_KEY } });
    return b.ok && (await b.json()).length === 1;                   // sesi harus sedang live
  } catch (e) { return false; }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/') return new Response('live-kajian relay ok');
    if (req.headers.get('Upgrade') !== 'websocket') return tolak(426, 'Butuh WebSocket');
    const asal = (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (asal.length && asal.indexOf(req.headers.get('Origin')) < 0) return tolak(403, 'Origin tidak diizinkan');
    const sesi = u.searchParams.get('s');
    if (!sesi || !UUID.test(sesi)) return tolak(400, 'Sesi tidak valid');
    if (u.pathname === '/siar') {
      const p = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(function (s) { return s.trim(); });
      if (p[0] !== 'jazmi' || !p[1]) return tolak(401, 'Butuh token');
      if (!(await pengajarSah(env, p[1], sesi))) {
        // upgrade lalu tutup dengan kode 4003 agar studio bisa menampilkan alasannya
        const pair = new WebSocketPair();
        pair[1].accept(); pair[1].close(4003, 'ditolak');
        return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'jazmi' } });
      }
    } else if (u.pathname !== '/dengar') return tolak(404, 'Tidak ada');
    return env.RUANG.get(env.RUANG.idFromName(sesi)).fetch(req);   // DO hanya terjangkau lewat Worker ini
  },
};

export class Ruang extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // "ping" dari penonton dijawab "pong" tanpa membangunkan objek (tidak ditagih)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
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
    const peran = new URL(req.url).pathname === '/siar' ? 'host' : 'l';
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.tambah(server, peran);
    const h = {}; if (peran === 'host') h['Sec-WebSocket-Protocol'] = 'jazmi';
    return new Response(null, { status: 101, webSocket: client, headers: h });
  }

  webSocketMessage(ws, msg) {
    const tags = this.ctx.getTags(ws);
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
