# Memasang relay audio (tanpa SFU, tanpa TURN)

Yang dipakai: **satu Worker + Durable Object** di Cloudflare, paket **Workers gratis**. Tidak ada SFU App, TURN Key, atau Realtime.
Durable Object ada di paket gratis (hanya versi SQLite, sudah diatur di `wrangler.toml`). Dokumentasi Cloudflare (dicek 9 Nov 2026) menyebut batas gratis 100.000 permintaan/hari;
pesan masuk WebSocket dihitung 20:1, pesan keluar gratis. Soal kartu: halaman pendaftaran paket gratis Workers tidak saya lihat langsung, jadi saya tidak bisa menjamin
dasbor Abang tidak menanyakannya. Bila bagian mana pun meminta kartu, **berhenti dan kabari** — jalur cadangan: YouTube Live audio (lihat RANCANGAN bagian 10).

## 1. Supabase (tidak ada SQL baru)
Cukup `supabase-live.sql` Tahap 0 yang sudah dijalankan. Worker memakai tabel `pengajar` dan `live_sesi` yang sama.

## 2. Pasang Worker (lewat GitHub, seperti Workers Papan Kelas)
Syarat penting: Durable Object **harus dipasang lewat `wrangler.toml`** (berkas ini memuat migrasinya); menempel kode di editor dasbor saja tidak cukup (setahu saya).

1. GitHub → buat repositori **baru, tersendiri** (mis. `live-kajian-worker`).
2. Unggah **isi** folder `worker/` ke akar repositori: `wrangler.toml`, `live-relay.js`, `PASANG.md` (bukan folder `worker` itu sendiri).
3. Cloudflare → Workers & Pages → Create → hubungkan ke Git → pilih repositori itu, lalu sama seperti saat Abang memasang Papan Kelas. Nama Worker harus **live-kajian** (sama dengan `name` di `wrangler.toml`).
4. Setelah build selesai, alamatnya `https://live-kajian.NAMA-AKUN.workers.dev` (NAMA-AKUN sama dengan alamat Worker Papan Kelas).

Saya belum pernah mencobanya, jadi nama menu bisa berbeda. Cadangan bila build gagal: `npx wrangler deploy` dari laptop/Termux di folder `worker`.

## 3. Sambungkan situs
Isi `js/live-config.js`:  `relay: "wss://live-kajian.NAMA-AKUN.workers.dev"` lalu unggah ke Hostinger bersama berkas lain dari paket ini.

## 4. Uji (urut)
1. Buka `https://live-kajian.NAMA-AKUN.workers.dev/` → tampil "live-kajian relay ok".
2. Studio → Mulai kajian → **Mulai audio** (izinkan mikrofon). Status harus "● Mengudara"; bilah level bergerak saat bicara.
3. HP lain (data seluler) → Ruang Kajian → **▶ Dengarkan di sini**. Harus terdengar dengan jeda ±1–2 detik. Studio menampilkan "Pendengar saat ini: N".
4. Coba: bisukan/lanjutkan, matikan Wi-Fi 10 detik lalu nyalakan (harus tersambung ulang), layar penonton dikunci, **iPhone** (cek bunyi saat tombol senyap aktif).

## Pengaturan
- `MAX_PENDENGAR` (wrangler.toml): batas penonton bersamaan per sesi, bawaan 80. Penonton ke-81 melihat "Majelis penuh" dan mencoba lagi otomatis tiap 15 detik.
- `ALLOWED_ORIGINS`: hanya qiladat.com. Untuk uji dari alamat lain, tambahkan sementara.

## Bila ada masalah
- Studio: "Ditolak" → akun belum di tabel `pengajar`, atau sesi belum/tidak lagi `live`.
- Penonton menyambung-putus terus → cek `ALLOWED_ORIGINS` dan alamat `relay` (harus `wss://`).
- `npx wrangler tail` menampilkan log langsung.
