# Deploy ke Vercel + Neon

Versi cloud menggunakan HTTP langsung ke Digireview, Telegram webhook, dan Neon
PostgreSQL. Browser/Playwright hanya dipakai di PC untuk login CAPTCHA saat perlu.
Kode cloud tidak membaca file lokal, menjalankan loop terus-menerus, atau membuka browser.

## 1. Siapkan Neon dan konfigurasi lokal

1. Buat project/database di Neon. Salin connection string PostgreSQL, biasanya
   berawalan `postgresql://` dan mengandung `sslmode=require`.
2. Di folder proyek, jalankan:

   ```powershell
   npm run cloud:prepare
   ```

   Ini membuat `private/vercel.env`, mengambil token dan chat ID dari bot lokal,
   serta membuat secret webhook dan scheduler. File yang sudah ada tidak ditimpa.
3. Edit `private/vercel.env`: isi `DATABASE_URL` dari Neon. Jangan masukkan secret
   ke source code atau Git. `DEPLOYMENT_URL` diisi setelah deployment tersedia.
4. Buat tabel:

   ```powershell
   npm run cloud:db
   ```

   Alternatif: jalankan isi `schema.sql` pada SQL Editor Neon. Data sesi dan
   deduplikasi disimpan dalam tabel `digireview_kv`.

## 2. Deploy source code

Di Vercel buat project dari repository atau gunakan CLI `npx vercel`. Jika upload
via Git, pastikan `private/` dan `.env` tidak ikut repository. Framework preset:
**Other**. Konfigurasi build dan folder `public` sudah di `vercel.json`.

Tambahkan variabel berikut di **Settings → Environment Variables → Production**,
menggunakan nilai yang sama persis dengan `private/vercel.env`:

| Variabel | Isi |
| --- | --- |
| `DATABASE_URL` | Connection string Neon |
| `TELEGRAM_BOT_TOKEN` | Token bot |
| `TELEGRAM_CHAT_ID` | Chat ID pemilik, bukan ID bot |
| `TELEGRAM_WEBHOOK_SECRET` | Secret webhook yang sudah dibuat |
| `CRON_SECRET` | Secret endpoint scheduler/upload sesi |

Deploy/redeploy sesudah menambahkan variabel. Gunakan domain production stabil,
bukan URL preview setiap deployment. Endpoint production harus bisa diakses
Telegram dan scheduler tanpa halaman login Vercel Deployment Protection;
endpoint bot sendiri sudah memverifikasi secret.

## 3. Pindahkan sesi dan aktifkan webhook

Isi `DEPLOYMENT_URL=https://nama-project.vercel.app` di `private/vercel.env`.
Upload cookie sesi login dari PC:

```powershell
npm run cloud:session
```

Setelah upload berhasil, **hentikan bot lokal yang menjalankan `bot.mjs`** agar
tidak mengirim notifikasi ganda dan tidak mencoba long polling setelah webhook aktif.
Jika bot lokal dijalankan lewat terminal gunakan Ctrl+C. Jika masih proses latar
belakang yang dibuat saat pengembangan, periksa PID proses sebelum menghentikannya.

Aktifkan webhook dan coba ambil notifikasi:

```powershell
npm run cloud:webhook
npm run cloud:check
```

Bot mengirim konfirmasi pemantauan saat cek cloud pertama berhasil. Notifikasi
yang sudah ada dijadikan baseline. Coba `/status` dan `/cek` di Telegram.

## 4. Cek otomatis setiap menit

**Vercel Hobby membatasi cron native sekali sehari.** Agar bot mengecek setiap
menit, gunakan scheduler HTTP eksternal, misalnya cron-job.org:

- URL: `https://nama-project.vercel.app/api/cron`
- Method: **GET**
- Schedule: setiap **1 menit**
- Header: `Authorization: Bearer NILAI_CRON_SECRET`
- Timeout: atur sesuai opsi penyedia. Respons sukses adalah HTTP 200.

Header harus diisi di pengaturan request scheduler. Jangan menaruh secret di query
URL. Pilih scheduler yang mendukung header Authorization. Pemanggilan eksternal
tetap memakai kuota fungsi Vercel dan database Neon.

Jika menggunakan **Vercel Pro**, cron native per menit dapat digunakan dengan
menambahkan ke `vercel.json`:

```json
"crons": [{ "path": "/api/cron", "schedule": "* * * * *" }]
```

Vercel otomatis mengirim `Authorization: Bearer <CRON_SECRET>` ketika variabelnya
tersedia. Jangan aktifkan dua scheduler sekaligus. Berkas konfigurasi bawaan
tidak menambahkan cron harian karena tidak memenuhi kebutuhan notifikasi cepat.

## 5. Ketika sesi Digireview habis

Bot akan mengirim pesan kendala. Di PC:

```powershell
npm run discover
# Login ulang dan selesaikan CAPTCHA, kemudian tekan Enter.
npm run cloud:session
```

Tidak perlu redeploy untuk memperbarui sesi. Cookie yang dirotasi oleh Digireview
disimpan kembali ke Neon secara otomatis. Jika Digireview menolak sesi dari IP
Vercel, upload cookie saja mungkin tidak cukup; perlu memeriksa respons/login
dari jaringan deployment tersebut.

## Perilaku dan batas saat ini

- Hanya chat privat pemilik yang boleh menjalankan perintah bot.
- Lock di Neon mencegah dua pengecekan berjalan bersamaan.
- Deduplikasi disimpan lintas deployment. Pesan dicatat setelah Telegram berhasil
  menerima kiriman; kegagalan sesudah kirim tetapi sebelum penyimpanan masih bisa
  menghasilkan kiriman ulang pada percobaan berikutnya.
- Maksimal 10 halaman diambil dan 20 notifikasi dikirim per invocation. Sisanya
  diproses pada jadwal berikutnya jika masih berada dalam halaman yang dipantau.
- Struktur notifikasi berisi data masih perlu diverifikasi dengan contoh nyata;
  endpoint dan tabel kosong sudah diuji menggunakan sesi login lokal.
- Migrasi cloud memulai baseline baru; riwayat lokal tidak otomatis diimpor.

Pemeriksaan lokal: `npm test`, `npm run build:vercel`, dan `npm run cloud:probe`.
Deploy dan koneksi Neon baru bisa diverifikasi setelah DATABASE_URL dan project
Vercel tersedia.
