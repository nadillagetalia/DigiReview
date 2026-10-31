# Pencari endpoint notifikasi Digireview

**Deployment Vercel + Neon:** ikuti [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md).

Merekam Fetch/XHR dari browser resmi untuk menemukan endpoint internal yang digunakan
menu notifikasi. Endpoint belum diasumsikan atau ditebak. Sebagian situs menyisipkan
notifikasi dalam HTML atau menggunakan WebSocket; jika tidak ada request terkait,
laporan Fetch/XHR saja belum cukup untuk menyimpulkan endpoint tersedia.

## Instalasi

```powershell
npm install
npx playwright install chromium
```

## Menangkap endpoint setelah login

```powershell
npm run discover
```

1. Browser terbuka ke tautan Digireview.
2. Login menggunakan akun sendiri dan selesaikan CAPTCHA.
3. Klik lonceng/menu notifikasi, tab belum dibaca, dan halaman daftar review.
4. Kembali ke terminal lalu tekan Enter.
5. Periksa `private/endpoints.json`: setiap request memiliki URL, metode, status,
   tipe konten, dan struktur JSON tanpa nilai data. `possibleNotification` adalah
   petunjuk pencarian, bukan konfirmasi bahwa request tersebut endpoint notifikasi.

Sesi disimpan di `private/session.json` agar eksekusi berikutnya dapat memakai login
yang sama selama masih berlaku. Folder `private` tidak dimasukkan ke Git. File sesi
berisi cookie login; jangan dibagikan. Jika perlu mengirim hasil untuk analisis,
kirim laporan `endpoints.json`, bukan `session.json`.

Untuk URL berbeda pada PowerShell:

```powershell
$env:DIGIREVIEW_URL = 'https://digireview.id/URL-HALAMAN-DAFTAR'
npm run discover
```

## Probe tanpa interaksi

```powershell
npm run probe
```

Mengunjungi halaman secara headless dan menulis `private/probe.json`. Tanpa sesi
login, hasilnya kemungkinan halaman login, bukan data review.

## Setelah endpoint ditemukan

Periksa respons dari request yang benar-benar mengambil daftar notifikasi. Endpoint
GET yang sesuai nantinya dapat di-poll memakai cookie sesi, lalu ID notifikasi
dipakai untuk deduplikasi sebelum mengirim ke Telegram. Endpoint internal ini
tetap merupakan API web meskipun bukan REST API publik. Autentikasi, kedaluwarsa
sesi, parameter pagination, dan kemungkinan CSRF harus mengikuti request asli.

## Endpoint yang sudah diverifikasi

`GET https://digireview.id/notifikasi` merespons HTTP 200 menggunakan sesi login
yang disimpan. Data dimuat langsung dalam HTML, bukan respons JSON Fetch/XHR.
Pada pemeriksaan, penghitung belum dibaca bernilai 0 dan tabel menampilkan
"Tidak ada notifikasi".

```powershell
npm run notifications
```

Perintah ini mengambil endpoint secara langsung tanpa membuka browser, lalu
menyimpan hasil ke `private/notifications.json`. Hasil memuat penghitung belum
dibaca, teks/tautan setiap baris di halaman pertama, dan tautan pagination berikutnya.
Struktur baris dengan notifikasi nyata belum terverifikasi karena daftar masih
kosong. Tautan dalam notifikasi tidak dikunjungi otomatis.

Untuk menyimpan HTML mentah halaman ke `private/page.html`, gunakan `npm run inspect`.
HTML dapat memuat informasi akun dan token CSRF; simpan secara lokal.

## Pemantauan otomatis Telegram

Konfigurasi token bot disimpan secara lokal di `.env` (lihat `.env.example`).
`TELEGRAM_CHAT_ID` dapat dikosongkan: pengirim `/start` pertama di chat privat
akan dipasangkan sebagai satu-satunya penerima. ID bot bukan chat ID pengguna.

```powershell
npm run telegram-check
npm start
```

Setelah menjalankan `npm start`, buka bot Telegram dan tekan **Start**. Biarkan
terminal dan PC menyala. Bot mengecek Digireview setiap 60 detik tanpa membuka
browser. `/status` menampilkan status terakhir dan `/cek` menjadwalkan cek segera.
Data awal dijadikan baseline agar notifikasi lama tidak dikirim sekaligus.
ID deduplikasi dan penerima disimpan di `private/bot-state.json` untuk restart.
Hanya halaman pertama yang dipantau; jika lebih dari satu halaman notifikasi
baru datang dalam satu interval, sebagian bisa terlewat. Parsing data nyata
perlu diverifikasi saat daftar notifikasi tidak kosong.

Jika sesi kedaluwarsa, bot mengirim pemberitahuan; jalankan `npm run discover`
untuk login ulang. Cookie terbaru akan dibaca pada cek berikutnya.
Jalankan hanya satu proses `npm start` untuk satu token bot.
