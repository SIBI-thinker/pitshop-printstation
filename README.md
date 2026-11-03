# Scan-to-Print Workstation

A Windows laptop becomes a self-contained print counter. It runs its own Wi-Fi hotspot and a local website; customers print from their phones with no internet and no app.

## How it works

1. **Connect.** The counter screen shows one QR code. Scanning it joins the laptop's Wi-Fi, and the phone's "Sign in to network" window shows a short Connect page. Tapping **Continue** marks the phone as online (the laptop must share an internet connection through the hotspot) and hands over to the phone's real browser, where uploads work. Android opens Chrome automatically; iPhones are told to tap Done and open Safari.
2. **Order.** The customer enters their name and mobile number and uploads files (PDF, JPG, PNG, Word, Excel, PowerPoint). **Each file has its own settings**: colour or black & white, single or double-sided (long or short edge), orientation, paper size, scaling, page range and copies. Tapping a file opens its settings with a live **print preview** above them: the sheets of paper exactly as they will come out, front and back side by side for double-sided, on the chosen paper with printer margins, in black & white when chosen. New files start with the last settings used, and **Use for all files** copies one file's settings to the rest. Previews are drawn by the phone's browser (pdf.js), not the laptop.
3. **PIN.** After confirming, the phone shows a 4-digit PIN with the total pages. Nothing prints yet.
4. **Print.** At the counter, staff type the PIN on the laptop and see the customer's details, files, settings and total pages. They can preview each file the same way, then press **Print now**.

Up to 10 customers (`MAX_ACTIVE_ORDERS`) can have an open order or PIN at the same time, and they can be served in any order. The 11th is asked to try again in a few minutes, and the counter header shows how many places are taken. The phone updates to "Printing" and then "Printed".

## Setup (once, on the print laptop)

1. Install [Node.js](https://nodejs.org), [SumatraPDF](https://www.sumatrapdfreader.org) and the printer driver. For Office files, install Microsoft Office or LibreOffice.
2. Copy `.env.example` to `.env` and set the shop name, Wi-Fi name and password, and what your printer supports (`COLOR_PRINTING`, `DUPLEX_PRINTING`, `PAPER_SIZES`).
3. Open PowerShell **as Administrator** in this folder and run `scripts\setup-windows.ps1`. It installs dependencies, adds the captive-portal entries to the Windows hosts file, and registers the startup task.

Afterwards, `scripts\start-kiosk.bat` starts the station and opens the counter screen at `http://localhost/counter/`.

## Pages

| Address | Who | What |
| --- | --- | --- |
| `http://192.168.137.1/` | Customers' phones | Upload files, choose options, get a PIN |
| `http://localhost/counter/` | The laptop only | Wi-Fi QR code, PIN keypad, order details, print |

The counter screen and its API only answer requests from the laptop itself, so phones cannot look up PINs or start printing.

## Built for a low-spec laptop

- One job at a time: Office conversion, page counting and printing run in a single queue, with printing first.
- Limits on file size, files per order, pages per order, open orders and orders per phone are all set in `.env`.
- No database and no front-end framework. Orders are kept in memory and saved to `tmp/orders.json`, so a restart keeps every PIN.
- Files are deleted automatically when an order expires or `KEEP_DONE_MINUTES` after printing.
- Phones only check for updates while something is changing.

## Troubleshooting

- **The page doesn't open after joining the Wi-Fi.** Check that `scripts\captive-hosts.js` ran as Administrator and that `SERVER_PORT` is 80. Customers can always open `http://192.168.137.1` in their browser; the counter screen shows this address under the QR code.
- **The hotspot doesn't start.** Turn on Mobile Hotspot once in Windows Settings, using the same name and password as `.env`.
- To undo the hosts file change: `node scripts\captive-hosts.js --remove` (as Administrator).
