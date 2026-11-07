# Saturuma App - Manajemen Keuangan Rumah Tangga

> Frontend di GitHub (GitHub Pages) • Backend di Google Apps Script (GAS) • Database di Google Sheets • Media Penyimpanan di Google Drive.

---

## 📂 Struktur Repositori

```text
saturuma-app/
├── index.html              # Frontend Single Page Application (Deploy ke GitHub Pages)
├── backend/
│   ├── Code.gs             # Backend API Google Apps Script (Engine Spreadsheet & Drive)
│   └── appsscript.json     # Konfigurasi Manifest Google Apps Script
├── .gitignore              # Mengabaikan file sistem & cache
└── README.md               # Panduan deployment & konfigurasi
```

---

## 🏗️ Arsitektur Sistem

- **Frontend**: [GitHub Pages](https://pages.github.com/) menghosting antarmuka SPA responsif (`index.html`).
- **Backend API**: [Google Apps Script (GAS)](https://script.google.com/) mengeksekusi logika transaksi, auth, OCR AI, dan perutean data.
- **Database**: [Google Sheets](https://sheets.google.com/) sebagai database tabel relasional (`DB_Users`, `Config_Master`, sheet kategori transaksi).
- **Media Storage**: [Google Drive](https://drive.google.com/) menyimpan foto bukti struk dan foto item barang di folder `Saturuma System`.
- **AI Scanner**: [Google Gemini 3.8 Flash](https://aistudio.google.com/) untuk ekstraksi cerdas struk belanja.

---

## 🚀 Panduan Setup & Deploy

### Langkah 1: Siapkan Backend di Google Sheets & Google Apps Script

1. Buka [Google Drive](https://drive.google.com/) dan buat **Google Spreadsheet** baru, beri nama **`Saturuma Database`**.
2. Di dalam spreadsheet tersebut, klik menu **Extensions (Ekstensi)** > **Apps Script**.
3. Di editor Apps Script:
   - Ganti isi file `Code.gs` dengan seluruh kode dari [`backend/Code.gs`](./backend/Code.gs).
   - *(Opsional)* Jika ingin mengatur manifest, buka menu **Project Settings (Ikon Gerigi)** > centang *"Show 'appsscript.json' manifest file in editor"*, lalu sesuaikan isinya dengan [`backend/appsscript.json`](./backend/appsscript.json).
4. Klik tombol **Save** (Ctrl + S).

---

### Langkah 2: Deploy Google Apps Script sebagai Web App

1. Klik tombol **Deploy** di pojok kanan atas > pilih **New deployment**.
2. Klik ikon gerigi ⚙️ di sebelah *Select type* > pilih **Web app**.
3. Isi parameter:
   - **Description**: `Saturuma Backend v1`
   - **Execute as**: **Me (emailanda@gmail.com)** *(Wajib agar script memiliki hak akses ke Google Sheets & Google Drive Anda)*
   - **Who has access**: **Anyone** *(Wajib agar Frontend dari GitHub Pages dapat mengakses API)*
4. Klik **Deploy**.
5. Berikan izin otorisasi (*Authorize access* > pilih akun Google > *Advanced* > *Go to Saturuma System* > *Allow*).
6. **Salin Web app URL** yang didapatkan (berakhiran `/exec`). Simpan URL ini untuk Langkah 4!

---

### Langkah 3: Deploy Frontend ke GitHub (GitHub Pages)

1. Buat repositori baru di [GitHub](https://github.com/new) bernama `saturuma-app`.
2. Buka terminal di komputer Anda, masuk ke folder `saturuma-app`:
   ```bash
   cd saturuma-app
   git init
   git add .
   git commit -m "Initial commit Saturuma App"
   git branch -M main
   git remote add origin https://github.com/USERNAME/saturuma-app.git
   git push -u origin main
   ```
   *(Ganti `USERNAME` dengan username GitHub Anda)*
3. Di halaman repositori GitHub Anda:
   - Buka menu **Settings** > bilah sisi kiri pilih **Pages**.
   - Di bagian **Build and deployment**:
     - **Source**: `Deploy from a branch`
     - **Branch**: `main` dan folder `/ (root)`
   - Klik **Save**.
4. Tunggu 1–2 menit, web Anda akan aktif di:  
   👉 `https://USERNAME.github.io/saturuma-app/`

---

### Langkah 4: Hubungkan Frontend ke Backend Google Apps Script

Ada 2 cara menghubungkan Frontend ke Google Apps Script:

#### Cara A: Langsung dari Antarmuka Web (Rekomendasi - Tanpa Edit Kode)
1. Buka tautan GitHub Pages Anda di browser.
2. Pada layar login/selamat datang, klik tombol **Gear ⚙️ (Pengaturan Backend)** di pojok kanan atas.
3. Masukkan **Web App URL** yang Anda dapatkan di Langkah 2 (berakhiran `/exec`).
4. Klik **Tes & Hubungkan Backend**.
5. Status akan berubah menjadi **🟢 Terhubung Sukses (Mode Privat & Terlindungi)**.

#### Cara B: Hardcode URL di File `index.html` (Opsional)
Jika Anda ingin URL backend terpasang otomatis untuk semua pengguna:
1. Buka file `index.html`.
2. Cari baris:
   ```javascript
   window.APP_CONFIG = window.APP_CONFIG || {
       GAS_API_URL: ""
   };
   ```
3. Isi dengan URL Web App Anda:
   ```javascript
   window.APP_CONFIG = window.APP_CONFIG || {
       GAS_API_URL: "https://script.google.com/macros/s/AKfycb.../exec"
   };
   ```
4. Commit dan push kembali ke GitHub (`git add index.html && git commit -m "Set backend URL" && git push`).

---

## 🔑 Kredensial Login Bawaan

Saat backend terhubung pertama kali ke Google Sheets, sistem secara otomatis membuat akun admin bawaan:

- **Username**: `admin`
- **Password**: `admin 123`
- **Role**: `admin`

*(Setelah berhasil masuk, Anda dapat mengubah password atau mendaftarkan anggota keluarga lainnya)*.

---

## 📁 Struktur Data Otomatis di Google Sheets & Drive

Saat sistem pertama kali berjalan, sistem akan secara otomatis membuat struktur berikut:

1. **Google Sheets (`Saturuma Database`)**:
   - `DB_Users` : Tabel akun dan otentikasi (password di-hash dengan Salt).
   - `Config_Master` : Konfigurasi kategori dan anggaran bulanan.
   - Sheet Kategori Transaksi : `DB_Bayi`, `DB_Dapur`, `DB_Tagihan`, `DB_Tabungan`, `DB_Transport`, dll.
2. **Google Drive**:
   - Folder: `Saturuma System/Receipts` untuk menyimpan berkas foto struk belanja.
   - Folder: `Saturuma System/Item Photos` untuk menyimpan foto barang/produk.
