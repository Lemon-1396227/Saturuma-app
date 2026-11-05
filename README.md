# 🏡 Saturuma - Super-App Keuangan & Manajemen Rumah Tangga
> *"Satu Rumah, Semua Pencatatan Terintegrasi"*

Aplikasi web modern berbasis Single Page Application (SPA) untuk mencatat, mengelola, dan menganalisis anggaran keuangan rumah tangga dengan dukungan **Multi-Item Receipt Scanner (AI Vision)**, **Kategori Dinamis**, **Multi-Akun**, dan **Penyimpanan Cloud Google Workspace**.

---

## 🏗️ Arsitektur Sistem & Komponen Cloud

Aplikasi ini dirancang dengan arsitektur **Serverless 100% Gratis & Mandiri**:

| Komponen | Layanan | Fungsi |
|---|---|---|
| **Frontend** | [GitHub Pages](https://pages.github.com/) | Menghosting file antarmuka web (`index.html`) dengan SSL/HTTPS gratis & cepat. |
| **Backend API** | [Google Apps Script (GAS)](https://script.google.com/) | API Gateway REST / JSON Controller (`Code.gs`) yang mengeksekusi logika bisnis. |
| **Database** | [Google Sheets](https://sheets.google.com/) | Database relasional untuk menyimpan tabel transaksi, master kategori, dan user. |
| **Media Storage** | [Google Drive](https://drive.google.com/) | Menyimpan bukti foto struk belanjaan dan foto item barang secara otomatis. |
| **AI Scanner** | [Google Gemini 3.8 Flash](https://aistudio.google.com/) | Ekstraksi otomatis nama toko, tanggal, item barang, diskon, dan pajak dari struk. |

---

## 🚀 Panduan Lengkap Deploy (Langkah demi Langkah)

### TAHAP 1: Pasang Backend (Google Sheets, Drive & Apps Script)

1. Buka [Google Drive](https://drive.google.com/).
2. Buat Spreadsheet baru dengan nama **`Saturuma Database`**.
3. Di dalam Google Spreadsheet tersebut, klik menu **Extensions (Ekstensi)** > **Apps Script**.
4. Hapus semua kode default di file editor `Code.gs`, lalu salin seluruh isi dari file [`Code.gs`](./Code.gs) yang ada di repositori ini dan tempel ke sana.
5. Klik ikon **Save (Simpan)** (Ctrl + S / Cmd + S).

---

### TAHAP 2: Deploy Google Apps Script sebagai Web App

1. Di halaman Google Apps Script editor, klik tombol biru **Deploy** di pojok kanan atas > pilih **New deployment (Deployment baru)**.
2. Klik ikon gerigi ⚙️ di sebelah *Select type*, pilih **Web app**.
3. Isi konfigurasi sebagai berikut:
   - **Description**: `Saturuma Backend API v1`
   - **Execute as**: **Me (emailanda@gmail.com)** *(PENTING: agar script dapat mengakses Google Sheets & Google Drive Anda)*
   - **Who has access**: **Anyone (Siapa saja)** *(PENTING: agar frontend GitHub Pages diizinkan memanggil API tanpa hambatan autentikasi)*
4. Klik **Deploy**.
5. Jika muncul jendela izin (*Authorization Required*):
   - Klik **Authorize access**.
   - Pilih akun Google Anda.
   - Klik **Advanced (Lanjutan)** > pilih **Go to Saturuma System (unsafe)**.
   - Klik **Allow (Izinkan)**.
6. Salin **Web app URL** yang muncul (formatnya: `https://script.google.com/macros/s/AKfycb.../exec`). **Simpan URL ini untuk Tahap 4!**

---

### TAHAP 3: Deploy Frontend di GitHub (GitHub Pages)

1. Buka [GitHub](https://github.com/) dan buat repositori baru (misal: `saturuma-app` atau `babynest`).
2. Masukkan file [`index.html`](./index.html) ke repositori Anda:
   - Melalui Git terminal:
     ```bash
     git init
     git add .
     git commit -m "Deploy Saturuma Frontend"
     git branch -M main
     git remote add origin https://github.com/USERNAME/NAMA-REPO.git
     git push -u origin main
     ```
   - Atau melalui browser GitHub: Klik tombol **Add file** > **Upload files** > Drag & drop file `index.html` > Klik **Commit changes**.
3. Di repositori GitHub Anda, klik tab **Settings (Pengaturan)**.
4. Di bilah sisi kiri, pilih menu **Pages**.
5. Pada bagian **Build and deployment**:
   - **Source**: Pilih **Deploy from a branch**.
   - **Branch**: Pilih `main` (atau `master`) dan folder `/ (root)`.
   - Klik **Save**.
6. Tunggu sekitar 1-2 menit, lalu segarkan halaman. Tautan website Anda akan muncul, contoh:
   👉 `https://username.github.io/nama-repo/`

---

### TAHAP 4: Menghubungkan Frontend ke Backend Google Apps Script

Buka situs GitHub Pages Anda di browser:

#### Opsi A: Lewat Antarmuka Pengaturan Aplikasi (Tanpa Ubah Kode)
1. Buka aplikasi Anda di browser.
2. Masuk menggunakan akun bawaan:
   - **Username**: `admin`
   - **Password**: `admin 123`
3. Masuk ke menu **Pengaturan** (ikon gerigi di bilah navigasi).
4. Di bagian **Backend Google Apps Script (API Gateway)**, tempelkan **Web app URL** yang Anda dapatkan di Tahap 2.
5. Klik **Tes & Hubungkan**.
6. Status akan langsung berubah menjadi **🟢 Terhubung (Apps Script)**. Spreadsheet dan folder Drive Anda di Google Workspace otomatis siap digunakan!

#### Opsi B: Hardcode Default URL di `index.html` (Opsional)
Jika Anda ingin URL backend langsung terpasang untuk semua pengguna tanpa perlu disetel di antarmuka:
- Buka file `index.html`.
- Cari baris `window.APP_CONFIG`:
  ```javascript
  window.APP_CONFIG = window.APP_CONFIG || {
      GAS_API_URL: "https://script.google.com/macros/s/AKfycb.../exec"
  };
  ```
- Masukkan URL Web App Anda di dalam tanda kutip. Simpan dan commit ke GitHub.

---

## 🔑 Login Default & Akun Administrator

Saat database Google Sheets pertama kali dibuat oleh sistem, tabel `DB_Users` akan diinisialisasi otomatis dengan akun bawaan:

| Field | Nilai Bawaan |
|---|---|
| **Username** | `admin` |
| **Password** | `admin 123` |
| **Nama Lengkap** | Administrator Saturuma |
| **Role** | admin |

> 💡 **Saran Keamanan**: Setelah berhasil login untuk pertama kali, silakan ganti password Anda melalui menu **Pengaturan** > **Ganti Password Akun**.

---

## 📁 Struktur Data di Google Workspace

Ketika script pertama kali dijalankan, sistem secara otomatis membuat:
1. **Google Sheets**:
   - `DB_Bayi`, `DB_Dapur`, `DB_Tagihan`, `DB_Tabungan`, `DB_Transport` (Sheet transaksi per kategori).
   - `DB_Users` (Tabel kredensial pengguna yang di-hash dengan Salt).
   - `Config_Master` (Tabel kategori dinamis & pengaturan).
2. **Google Drive**:
   - Folder induk: `Saturuma System`
   - Subfolder: `Receipts` (Menyimpan foto struk belanjaan & PDF).
   - Subfolder: `Item Photos` (Menyimpan foto barang/produk).

---

## 🤖 Ekstraksi Struk dengan Gemini AI (Opsional)

Untuk mengaktifkan fitur scan struk otomatis dengan AI:
1. Dapatkan API Key gratis di [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Buka menu **Pengaturan** di aplikasi.
3. Masukkan kunci ke kolom **Gemini API Key** dan klik **Simpan Pengaturan AI**.
4. Pilihan model:
   - `gemini-3.8-flash` *(Direkomendasikan: cepat & detail membaca struk)*.
   - `gemini-3.8-flash-lite` *(Sangat hemat kuota & ringan)*.

---

## 🛡️ Lisensi & Hak Cipta
Aplikasi ini bersifat open-source untuk penggunaan pribadi dan keluarga. Dibangun dengan cinta untuk efisiensi keuangan rumah tangga.
