# Aster-Konveksi-Sistem-Informasi-Persediaan-dan-Penjualan
# Stockita

Stockita adalah aplikasi persediaan, penjualan, produksi, dan laporan usaha Aster Konveksi. Aplikasi dapat dijalankan langsung dengan membuka `frontend/index.html` dan menggunakan Supabase sebagai database PostgreSQL terpusat.


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
