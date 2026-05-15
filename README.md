# AnimeX Backend

Express/Node.js anime streaming API scraping aniwaves.ru.

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Edit `.env`:
```
PORT=3000
NODE_ENV=development
```

### 3. Run
```bash
# Development (build + start)
npm run dev

# Or build then start separately
npm run build
npm start
```

The server starts at **http://localhost:3000**

---

## API Endpoints

| Endpoint | Params | Description |
|---|---|---|
| `GET /api/search` | `?q=naruto` | Search anime |
| `GET /api/details` | `?id=naruto-76396` | Anime details |
| `GET /api/episodes` | `?id=naruto-76396` | Episode list |
| `GET /api/servers` | `?id=...&ep=1&type=sub` | Available servers |
| `GET /api/stream` | `?id=...&ep=1&type=sub&server=vidplay` | Stream URL (m3u8) |
| `GET /api/healthz` | — | Health check |

---

## Frontend

Open `frontend/index.html` in your browser.
Click **⚙ API** → set URL to `http://localhost:3000` → Save.

## Requirements
- Node.js 18+
- npm 8+
