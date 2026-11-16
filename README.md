# SpendSnap — Smart Personal Expense Tracker PWA

A zero-build, mobile-first Progressive Web App built for **Xiaomi 14 Ultra (Android)** + **Google Workspace** + **Gemini AI**.

### What It Does Automatically
- **Snap Receipt / Upload Online Screenshot or PDF:** Compresses 50MP Xiaomi camera photos down to ~220 KB in <0.5s, sends to **Gemini** (`gemini-4-hydrogen` or `gemini-3.5-flash-lite`), and pre-fills **Date**, **Description**, **Amount**, **Currency**, **Category**, and **Payment Method / Specific Credit Card**.
- **Cash / Manual Entry:** 1-tap quick keypad entry with zero receipt required.
- **Zero Monthly Rollover Maintenance:**
  - Automatically creates `Expense Tracker / Receipts / YYYY / YYYY-MM /` folders in your Google Drive based on the receipt date.
  - Appends rows to a single master `Transactions` tab in `Expense Ledger` while powering a built-in **`Dashboard`** tab (instant **Selected Month** *and* **Full Year** views side by side, broken down by Category and by Credit Card).
- **Occasional Travel Ready:** Defaults to `MYR` (`RM`). When Gemini sees a foreign receipt (e.g., `SGD`, `THB`, `JPY`), it fetches the live exchange rate, logs the `MYR` equivalent into `Amount (MYR)`, and records `[Original: SGD 18.50 @ 3.32]` in `Remarks`.
- **Offline Safe:** Snapped or keyed entries save locally in `IndexedDB` first if you have no signal (e.g., basement parking) and sync to Google Drive & Sheets in 1 tap.

---

## 1. Test Locally Right Now (on Your Computer)

From `/home/Kuah/Documents/app`, run:

```bash
python3 -m http.server 8090
```

Then open `http://localhost:8090` in Chrome. You can paste your **Gemini API Key** in **Settings (⚙)** immediately to test receipt scanning and local history!

---

## 2. One-Time Google Cloud Setup (~3 Minutes)

Because this app uses Google's **non-sensitive `drive.file` scope**, it can only access the `Expense Tracker` folder and `Expense Ledger` Sheet that it creates—never the rest of your Drive—and requires **no paid security audit**.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) signed into your **Google Workspace Business Plus** account and create a new project (e.g., `SpendSnap`).
2. **Enable 2 APIs** (`APIs & Services` → `Library`):
   - Search **Google Drive API** → click **Enable**
   - Search **Google Sheets API** → click **Enable**
3. **Configure OAuth Consent Screen** (`APIs & Services` → `OAuth consent screen` / `Google Auth Platform`):
   - Choose **External** (so your colleague on *another* Google Workspace domain or personal Gmail can also sign in; pick *Internal* only if everyone is on your exact same domain).
   - Fill App Name (`SpendSnap`) and your email.
   - Scopes: Add `.../auth/drive.file`, `email`, `profile` (all non-sensitive).
   - Either add your email + your colleague's email under **Test users**, OR click **Publish App** (since `drive.file` is non-sensitive, publishing requires zero Google review).
4. **Create OAuth Client ID** (`APIs & Services` → `Credentials` → `+ Create Credentials` → `OAuth client ID`):
   - Application type: **Web application**
   - **Authorized JavaScript origins** (no trailing slash!):
     - `https://kuah-link.github.io` (GitHub Pages origin — domain only, no `/spendsnap`)
     - `http://localhost:8090` (for local testing)
   - Copy the generated **Client ID** (`...apps.googleusercontent.com`).

*(Optional tip: Paste your Client ID into `EMBEDDED_GOOGLE_CLIENT_ID` inside `js/config.js` before deploying so you never have to type it on any phone!)*

---

## 3. Free HTTPS Hosting (So Xiaomi 14 Ultra Can Access It Anywhere)

Pick either free static host (takes ~1 minute, zero monthly cost):

- **Option A — Cloudflare Pages (Simplest, no Git required):**
  1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Compute (Workers & Pages)** → **Create** → **Pages** → **Upload assets**.
  2. Drag and drop this `/home/Kuah/Documents/app` folder → get an instant `https://<your-project>.pages.dev` URL.
  3. Add `https://<your-project>.pages.dev` to **Authorized JavaScript origins** in Google Cloud Console (Step 2.4).
- **Option B — GitHub Pages:**
  Push this folder to a GitHub repo → `Settings` → `Pages` → Deploy from `main` branch.

---

## 4. Install on Your Phone (No Play Store or App Store Needed)

### Android (Xiaomi 14 Ultra — Chrome)
1. Open `https://kuah-link.github.io/spendsnap/` in **Chrome**.
2. Tap the **Install** banner at the top (or Chrome `⋮` menu → **Add to Home screen** → **Install**).
3. **Xiaomi HyperOS Tip:** If the icon doesn't appear on your home screen right away, long-press **Chrome** → **App info** → **Other permissions** → enable **Home screen shortcuts**, then tap **Install** once more.

### iPhone / iOS (Safari)
1. Open `https://kuah-link.github.io/spendsnap/` in **Safari**.
2. Tap the **Share** button (`⬆` at the bottom) → scroll down and tap **Add to Home Screen** → **Add**.
   - *(Note: On iOS, make sure Safari Settings → "Block Pop-ups" is toggled off when signing into Google the first time.)*

### First Launch Setup
Open **SpendSnap** from your home screen → tap **Settings (⚙)**:
- Paste your **Gemini API Key** ([Get from Google AI Studio](https://aistudio.google.com/apikey)).
- Optional: Add the **last 4 digits** next to your credit cards in Section 4 (e.g., `RHB Shell | card | 4821, Shell`) so Gemini automatically picks the exact card from terminal slips!
- Tap **Sign in with Google** → done!

---

## 5. Sharing with a Colleague on Another Google Workspace Domain

1. If your Google OAuth app is in *Testing* mode, add their email in Google Cloud Console → `Audience / Test users` (or set status to *In Production*).
2. In SpendSnap **Settings (⚙)**, tap **Copy Colleague Invite Link** and send it to them.
3. When your colleague opens that link:
   - Your OAuth Client ID is pre-filled automatically.
   - They tap **Colleague Simple Preset** in Settings (gives clean `Cash`, `QR / eWallet`, `Credit Card`, `Online Banking` instead of your 8 personal cards).
   - They paste their own Gemini API Key and tap **Sign in with Google** using *their* Google Workspace account.
   - Their receipts and `Expense Ledger` Sheet are created inside **their own Google Drive**—100% isolated from yours.
