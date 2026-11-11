# deepseek4free

**English** | [Русский](README.ru.md)

A local **OpenAI-compatible proxy for `chat.deepseek.com`** with a from-scratch PoW (proof-of-work) implementation in pure JavaScript — no WASM, no Python, no browser, no external dependencies.

```
Telegram bot / OpenAI SDK / curl
            │
            ▼
   http://127.0.0.1:9270/v1/chat/completions
            │
            ▼
   deepseek4free  (this project)
     ├─ DeepSeekHashV1 PoW solver (pure JS, worker_threads)
     ├─ thread sessions (session_key → chat_session_id)
     ├─ token rotation + cooldown
     └─ SSE → OpenAI chunks
            │
            ▼
   https://chat.deepseek.com/api/v0/...
```

> ⚠️ **Disclaimer.** This is an educational reverse-engineering project. Use it only with **your own account** and follow DeepSeek's Terms of Service. The authors are not responsible for account bans, service violations, or any other damage. Never commit `tokens.txt` to git.

---

## Features

- **OpenAI-compatible API**: `POST /v1/chat/completions` (stream and non-stream), `GET /v1/models`.
- **Pure-JS PoW**: `DeepSeekHashV1` (SHA3-256 with Keccak round 0 skipped) + solver. About 0.5 s at difficulty 144,000, executed in a worker thread.
- **Thread sessions**: `session_key` (or `conversation_id`, `user`, `X-Session-Id`) maps to a server-side DeepSeek chat. IDs are written to `data/sessions.json` immediately, so a restart continues the same chat instead of creating a new one.
- **Gentle pacing**: one upstream request per token at a time, a configurable delay plus jitter, and separate cooldowns for auth errors and rate limits.
- **Thinking and web search**: `deepseek-reasoner` / `thinking: true` returns `reasoning_content`; `search: true` enables DeepSeek search.
- **Token rotation**: multiple accounts, round-robin, cooldown on 401/403, hot reload without restart.
- **Cloudflare-ready**: optional `cf_clearance` from `data/cookies.json` (compatible with xtekky/deepseek4free) and a clear error if Cloudflare challenges.
- **Auto-continue**: when DeepSeek returns `INCOMPLETE`/`auto_continue`, the proxy calls `/api/v0/chat/continue` automatically.
- **Zero dependencies**: Node.js ≥ 18.17 only.

---

## Quick start

```bash
git clone https://github.com/pvuno/deepseek4free.git
cd deepseek4free

cp tokens.txt.example tokens.txt   # Windows: copy tokens.txt.example tokens.txt
# put your token into tokens.txt — see "Get your token" below

npm start
# or: node src/index.js
```

No file needed — pass the token through the environment:

```bash
DEEPSEEK_TOKEN="your-token" node src/index.js
```

Quick check:

```bash
curl http://127.0.0.1:9270/health
curl http://127.0.0.1:9270/v1/models

curl http://127.0.0.1:9270/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello!"}]}'
```

### Get your token

Open `https://chat.deepseek.com`, sign in, open DevTools (F12) → **Console** and run:

```js
JSON.parse(localStorage.getItem("userToken")).value
```

This prints your token. To copy it to the clipboard right away:

```js
copy(JSON.parse(localStorage.getItem("userToken")).value)
```

If `userToken` is stored as a plain string (older versions of the site):

```js
localStorage.getItem("userToken")
```

Manual alternative: DevTools → **Application** → **Local Storage** → `https://chat.deepseek.com` → key **`userToken`** → field `value`.

Put the token on its own line in `tokens.txt`. Multiple lines are allowed — tokens rotate. Lines in the form `user@example.com:password` are treated as credentials and logged in through `/api/v0/users/login`.

> The token is full access to your account. Never share it and never commit `tokens.txt`.

### Docker

```bash
docker build -t deepseek4free .
docker run -d --name deepseek4free \
  -p 127.0.0.1:9270:9270 \
  -e PROXY_API_KEY=change-me \
  -e DEEPSEEK_TOKEN=your-token \
  -v deepseek-data:/data \
  deepseek4free
```

The `/data` volume keeps `sessions.json`, so container restarts continue the same chats.

---

## API

### `POST /v1/chat/completions`

Standard OpenAI fields are accepted: `model`, `messages`, `stream`, `stream_options.include_usage`. `temperature` and `max_tokens` are accepted but ignored — the DeepSeek web API does not support them.

Extra fields:

| Field | Description |
|---|---|
| `session_key` | Thread name. One key = one server-side DeepSeek conversation. |
| `conversation_id`, `user`, `X-Session-Id` | Alternative names for `session_key`. |
| `thinking` / `thinking_enabled` | `true` enables reasoning. |
| `search` / `search_enabled` | `true` enables DeepSeek web search. |
| `include_reasoning` | `false` hides `reasoning_content` (returned by default). |

```bash
# non-stream
curl http://127.0.0.1:9270/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "session_key": "chat:42",
    "messages": [
      {"role": "system", "content": "You are a cat."},
      {"role": "user", "content": "Meow?"}
    ]
  }'

# stream
curl -N http://127.0.0.1:9270/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-reasoner","stream":true,"messages":[{"role":"user","content":"2+2?"}]}'
```

With the official OpenAI SDK:

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:9270/v1',
  apiKey: 'local',
});

const r = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(r.choices[0].message.content);
```

### Service endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Status, version, tokens, sessions. |
| `GET` | `/v1/models` | Model aliases. |
| `POST`/`GET` | `/v1/tokens/status` | Token count, active token, cooldowns. |
| `POST`/`GET` | `/v1/tokens/reload` | Reload `tokens.txt` without a restart (sessions are cleared). |
| `POST`/`GET` | `/v1/tokens/check` | Validate the active token (create and delete a test session). |
| `POST`/`GET`/`DELETE` | `/v1/chat/reset?session=KEY` | Forget a thread. `session=*` forgets all; no parameter forgets the unnamed one. |

---

## How it works

### 1. PoW

Before every message DeepSeek requires a solved challenge:

```
POST /api/v0/chat/create_pow_challenge   {"target_path":"/api/v0/chat/completion"}

{
  "algorithm": "DeepSeekHashV1",
  "challenge": "<64 hex>",     // = hash(prefix + answer)
  "salt": "...",
  "expire_at": 1700000000,
  "difficulty": 144000,
  "signature": "...",
  "target_path": "/api/v0/chat/completion"
}
```

The client walks `nonce ∈ [0, difficulty)` and finds the value where:

```
DeepSeekHashV1(salt + "_" + expire_at + "_" + nonce) === challenge
```

The answer goes into the `x-ds-pow-response` header as `base64(JSON)`:

```json
{"algorithm":"DeepSeekHashV1","challenge":"...","salt":"...",
 "answer":72000,"signature":"...","target_path":"/api/v0/chat/completion"}
```

**DeepSeekHashV1** is SHA3-256 where Keccak-f[1600] runs only rounds **1..23** (round 0 is skipped). Everything else is standard: rate 136, padding `0x06 ... 0x80`, 32-byte output. Node's built-in `sha3-256` does **not** match — a custom permutation is required (`src/pow.js`).

Test vectors from the official WASM build:

```
hash("")                                 = e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3
hash("testsalt_1700000000_42")           = d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09
hash("testsalt_1700000000_100000")       = abea2f35796b65486e9be1b36f7878c66cab021e96faa473fdf4decd31f9ba30
hash("abc123salt_1700000000_12345")      = 74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1
```

### 2. Full request

```
POST /api/v0/chat_session/create            {"agent":"chat"}          → session_id
POST /api/v0/chat/create_pow_challenge      {"target_path":...}        → challenge
   (solve PoW locally)
POST /api/v0/chat/completion                {chat_session_id, parent_message_id,
                                             prompt, thinking_enabled, ...}
   headers: authorization: Bearer <userToken>
            x-ds-pow-response: <base64>
   response: text/event-stream (JSON patches)
```

DeepSeek's SSE is not a plain delta stream; it sends patches to a response object:

```jsonc
{"v":{"response":{"message_id":2,"fragments":[{"type":"THINK","content":"..."}]}}}
{"p":"response/fragments/-1/content","o":"APPEND","v":"Hel"}
{"v":"lo"}                                  // continuation of the previous path
{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":""}]}
{"p":"response/status","o":"SET","v":"FINISHED"}
```

`src/sse.js` rebuilds clean text, reasoning, and usage, ignoring `TIP`, `quasi_status`, `elapsed_secs`, and other service noise.

### 3. Threads and context

- The **first** request with a new `session_key` sends the whole `messages` history (system prompt + turns) so the server-side chat starts with the same context.
- **Follow-up** requests send only the latest user message — DeepSeek keeps the history.
- `parent_message_id` is updated after every answer.
- The session record is saved to `data/sessions.json` **immediately**, so a restart resumes the same chat.
- Without `session_key`, a one-off chat is created and deleted after the answer.
- Requests with the same key are serialized (DeepSeek dislikes parallel completions in one chat).

---

## Sessions and account safety

- `data/sessions.json` is written on every change. A new DeepSeek chat is created only when there is no record, the record belongs to another token, or the thread expired by `SESSION_TTL_MS`.
- If the process crashes during the first request, the record is kept with `seeded: false`. The next request reuses that chat and sends the full history again instead of creating another one.
- Per token, only one upstream request runs at a time. Between requests the proxy waits `MIN_REQUEST_INTERVAL_MS` plus random jitter.
- `401/403` puts the token on cooldown; `429` uses `RATE_LIMIT_COOLDOWN_MS` (or the upstream `Retry-After`) and rotates to another token.
- Do not run the same token in several bot instances at once: pacing is per process.
- `DEEPSEEK_PROFILE=web` sends browser-like headers; `data/cookies.json` or `CF_CLEARANCE` handles Cloudflare.

This keeps traffic steady and avoids obvious bursts, but it is not a guarantee against bans.

---

## Cloudflare

Requests usually work with the default `android` profile. If Cloudflare starts returning "Just a moment…", provide `cf_clearance`:

1. Put the cookie into `data/cookies.json`:
   ```json
   {
     "cookies": { "cf_clearance": "..." },
     "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
   }
   ```
2. Or set `CF_CLEARANCE=...` in the environment.

The format is compatible with `xtekky/deepseek4free`, so you can obtain the cookie with their script:

```bash
python -m dsk.bypass   # from xtekky/deepseek4free
```

Or manually: DevTools → Application → Cookies → `https://chat.deepseek.com` → `cf_clearance`. The file is picked up on the fly (30-second cache).

With `DEEPSEEK_PROFILE=web`, the proxy sends browser-like `Origin`, `Referer`, `User-Agent`, and `x-app-version` headers, which reduces the chance of a challenge. The default `android` profile is tested and works without cookies.

---

## Comparison with xtekky/deepseek4free

| | this project | [xtekky/deepseek4free](https://github.com/xtekky/deepseek4free) |
|---|---|---|
| Language | Node.js, **zero dependencies** | Python + `wasmtime`, `numpy`, `curl-cffi`, `nodriver` |
| PoW | custom `DeepSeekHashV1` in JS | official DeepSeek WASM |
| Interface | **OpenAI-compatible HTTP API** | Python library |
| Streaming | OpenAI SSE chunks | Python chunk generator |
| Threads | `session_key` + persistence | manual `chat_session_id` |
| Multiple accounts | token rotation + cooldown | one token |
| Cloudflare | `data/cookies.json` / `CF_CLEARANCE` | built-in headless browser |
| Install | `node src/index.js` | `pip install -r requirements.txt` + browser |

Same idea and protocol; this project is tailored for bots and OpenAI clients.

---

## Integration with a bot or your own client

Start the proxy and use `http://127.0.0.1:9270/v1` as the OpenAI base URL. Useful features for bots:

- port `9270` (change with `PORT`);
- `session_key` in `/v1/chat/completions` — one conversation per chat;
- `POST /v1/chat/reset`, `?session=...`, `?session=*`;
- `GET /v1/tokens/status` → `{tokens, active}`;
- `POST /v1/tokens/reload` → `{status:"reloaded", tokens}`.

If your client expects a local `proxy.js` shim, create one next to it:

```js
// proxy.js — starts this proxy in the same process
require('/path/to/deepseek4free/src/index.js');
```

Or run the proxy as a separate process (`npm start`) and connect to `127.0.0.1:9270`.

---

## Configuration

All settings are environment variables (see `.env.example`). The most important ones:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `9270` | API address. |
| `TOKENS_FILE` | `tokens.txt` | Token file. |
| `SESSIONS_FILE` | `data/sessions.json` | Persisted thread state. |
| `DEEPSEEK_TOKEN(S)` | — | Token(s) via env when the file is empty. |
| `PROXY_API_KEY` | — | If set, clients must send `Authorization: Bearer <key>`. Required when `HOST≠127.0.0.1`. |
| `THINKING` | `off` | Default reasoning mode. |
| `SEARCH_ENABLED` | `0` | Default DeepSeek web search. |
| `DEEPSEEK_PROFILE` | `android` | `android` or `web` (browser-like headers). |
| `COOKIES_FILE` | `data/cookies.json` | Cloudflare cookies (optional). |
| `POW_WORKERS` | `1` | PoW threads (`0` = main thread). |
| `MAX_RETRIES` | `3` | Retries on 5xx/PoW errors. |
| `TOKEN_COOLDOWN_MS` | `600000` | Cooldown after 401/403. |
| `RATE_LIMIT_COOLDOWN_MS` | `60000` | Cooldown after 429 / rate limit. |
| `MIN_REQUEST_INTERVAL_MS` | `1500` | Minimum gap between upstream requests per token (`0` disables). |
| `REQUEST_JITTER_MS` | `500` | Random extra delay added to the gap. |
| `SESSION_TTL_MS` | `21600000` | Drop unused threads after this time. |
| `AUTO_CONTINUE` | `1` | Continue truncated answers. |

Node.js does **not** load `.env` automatically. Use:

```bash
node --env-file=.env src/index.js
```

---

## Development

Structure:

```
src/
  index.js      entry point
  app.js        HTTP router + OpenAI layer
  deepseek.js   chat.deepseek.com client (sessions, PoW, stream, rotation)
  pow.js        DeepSeekHashV1 + solver (pure JS)
  pow-pool.js   worker_threads pool
  pow-worker.js
  sse.js        DeepSeek JSON-patch SSE parser
  sessions.js   threads + persistence
  tokens.js     tokens.txt + round-robin + cooldown
  config.js
  logger.js
```

---

## Limitations

- No file uploads (`ref_file_ids` is not supported).
- DeepSeek search is enabled with `search: true`; only the answer text is returned, without a source list.
- `temperature`/`max_tokens` are ignored — a limitation of the web API, not the proxy.
- Free web accounts have limits and may require captcha/confirmation; the proxy does not bypass captchas.
- A token is full access to an account. Leaking `tokens.txt` means leaking the account.

## Security

- Listens on `127.0.0.1` by default.
- `PROXY_API_KEY` is mandatory for any other `HOST`.
- Tokens are never logged (only `abcd...wxyz`).
- `.gitignore` excludes `tokens.txt`, `.env`, and `data/`.

## License

MIT