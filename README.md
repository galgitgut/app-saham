# Binar Saujana App

Aplikasi pribadi pengganti AmiBroker: database harga, import CSV, screening, dan chart. Bisa dibuka di laptop maupun HP (bisa di-install sebagai app).

Repo ini **publik** dan hanya berisi tampilan. Data harga dan semua rumus dari AFL ada di repo privat `data-saham`, yang dibaca app memakai token milikmu.

## Isi folder

| File | Fungsi |
|---|---|
| `index.html` | Kerangka halaman: tab Screening, Chart, Data, Pengaturan |
| `css/style.css` | Tampilan (tema gelap) |
| `js/afl.js` | Fungsi umum gaya AFL: `MA`, `EMA`, `Ref`, `Cross`, `ATR`, `RSI`, dll. **Mulai belajar dari sini.** |
| `js/amibroker.js` | Membaca file database native AmiBroker (`BROKDAt5`) |
| `js/data.js` | Database di memori, import CSV DS3/DATA1, aturan merge, format file |
| `js/github.js` | Baca/tulis repo `data-saham` lewat GitHub API (semua perubahan = 1 commit) |
| `js/screening.js` | Menjalankan formula ke semua saham, seperti Explore |
| `js/chart.js` | Chart harga, panel NBSA, dan RRG |
| `js/app.js` | Pengatur utama yang menyambungkan semuanya |
| `sw.js`, `manifest.json`, `icon.svg` | Supaya bisa di-install di HP |

## Alur data

```
DS3 / DATA1 (CSV) ──► Import (tab Data) ──► data/delta/*.json.gz   (1 commit per "Simpan")
                                              │
                         Konsolidasi (sebulan sekali)
                                              ▼
Database AmiBroker ──► Konversi (sekali) ──► data/tahun/YYYY.json.gz
                                              │
            App dibuka: unduh 2 tahun terakhir + file harian (di-cache di perangkat)
                                              ▼
                     Screening & Chart  ◄── engine/*.js (rumus privat)
```

Aturan merge: DS3 selalu menang; DATA1 hanya mengisi bar sementara hari berjalan (ditandai **S**), dan tidak pernah menimpa data DS3.
