# Aster-Konveksi-Sistem-Informasi-Persediaan-dan-Penjualan
# Stockita

Stockita adalah aplikasi persediaan, penjualan, produksi, dan laporan usaha Aster Konveksi. Aplikasi dapat dijalankan langsung dengan membuka `frontend/index.html` dan menggunakan Supabase sebagai database PostgreSQL terpusat.

## Menyiapkan Supabase

1. Buat project Supabase. Buka **SQL Editor**, lalu jalankan seluruh isi `backend/database.sql`. Jika sebelumnya sudah menyiapkan database, jalankan ulang seluruh file agar izin untuk login browser dan fungsi transaksi diperbarui.
2. Pada **Authentication → Providers → Email**, aktifkan login email/kata sandi dan matikan pendaftaran publik. Buat atau undang hanya pengguna yang memang boleh mengakses data Stockita.
3. Di pengaturan project, tambahkan alamat situs pada **Authentication → URL Configuration → Redirect URLs** bila diminta. Login Stockita memakai alur password tanpa redirect.
4. Buka `frontend/supabase-config.js`, lalu isi URL project dan **publishable key** (atau legacy `anon` key) dari pengaturan API project:

   ```js
   window.STOCKITA_SUPABASE_CONFIG = {
     projectUrl: 'https://PROJECT-REF.supabase.co',
     publishableKey: 'sb_publishable_...',
   };
   ```

5. Simpan file tersebut, lalu buka `frontend/index.html` di browser. Masuk dengan akun Supabase Auth yang sudah diundang. Indikator aplikasi akan menampilkan koneksi PostgreSQL terpusat.

Konfigurasi frontend hanya boleh memuat project URL dan publishable/anon key. **Jangan pernah menaruh service-role/secret key di `supabase-config.js`, HTML, JavaScript, atau repository.** SQL memberi akses baca untuk pengguna terautentikasi dan menjalankan perubahan melalui fungsi transaksi; akses anonim tidak diberikan. Semua akun yang diundang saat ini memiliki akses penuh ke data usaha, jadi undang hanya staf tepercaya.

Jika project key server-side pernah dimasukkan ke file frontend atau repository, segera rotasi/ganti key tersebut dari Supabase. `.env.example` hanya berisi placeholder; gunakan service-role key server-side hanya jika memilih menjalankan backend.

## Menjalankan backend (opsional)

Backend Node dapat dijalankan sebagai alternatif ketika aplikasi disajikan melalui server:

```powershell
Copy-Item .env.example .env
# Isi SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY pada .env, lalu:
node --env-file=.env backend\app.js
```

Kemudian buka `http://localhost:3000`. File `.env` diabaikan Git. Jangan publikasikan backend tanpa perlindungan akses yang sesuai; jalur browser langsung menggunakan Supabase Auth.

## Fitur

- Persediaan bahan baku dan barang jadi, stok awal, dan penyesuaian stok.
- Produksi konveksi dengan biaya bahan, tenaga kerja, overhead, serta perhitungan HPP.
- Penjualan, pembayaran/DP, pemindaian barcode atau SKU, dan pengurangan stok.
- Pengarsipan persediaan dan pembatalan penjualan dengan alasan; riwayat koreksi tetap tersimpan dan stok penjualan dikembalikan.
- Laporan laba rugi, neraca manajerial, arus kas, persediaan, dan piutang.
- Tampilan responsif tanpa dependensi font atau gambar dari layanan eksternal.
- Operasi stok dan transaksi dijalankan atomik oleh fungsi PostgreSQL.

## Catatan

- Koneksi langsung dari file HTML memerlukan internet, browser yang mengizinkan permintaan jaringan dari `file://`, dan project Supabase yang aktif. Jika browser memblokir origin file, sajikan folder frontend lewat server statis lokal; aplikasi tetap memakai database Supabase terpusat.
- Sesi login disimpan di penyimpanan lokal browser. Keluar dari Stockita menghapus sesi lokal dan meminta Supabase mengakhiri sesi.
- Data lama di localStorage tidak otomatis dipindahkan ke Supabase. Periksa dan pindahkan data secara terencana sebelum berhenti menggunakan browser lama.
- Laporan neraca dan arus kas merupakan ringkasan manajerial, bukan pengganti laporan resmi atau konsultasi akuntan.
