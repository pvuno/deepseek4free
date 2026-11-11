# deepseek4free

[English](README.md) | **Русский**

Локальный **OpenAI-совместимый прокси к `chat.deepseek.com`** с собственной реализацией PoW (proof-of-work) на чистом JavaScript — без WASM, без Python, без браузера и без внешних зависимостей.

```
Telegram-бот / OpenAI SDK / curl
            │
            ▼
   http://127.0.0.1:9270/v1/chat/completions
            │
            ▼
   deepseek4free  (этот проект)
     ├─ DeepSeekHashV1 PoW solver (чистый JS, worker_threads)
     ├─ thread-сессии (session_key → chat_session_id)
     ├─ ротация токенов + cooldown
     └─ SSE → OpenAI chunks
            │
            ▼
   https://chat.deepseek.com/api/v0/...
```

> ⚠️ **Дисклеймер.** Проект учебный: он показывает, как устроен веб-протокол DeepSeek и его PoW. Используй только **свой аккаунт** и соблюдай Terms of Service DeepSeek. Авторы не несут ответственности за блокировки аккаунтов, нарушение правил сервиса или любой другой ущерб. Не коммить `tokens.txt` в git.

---

## Возможности

- **OpenAI-compatible API**: `POST /v1/chat/completions` (stream и non-stream), `GET /v1/models`.
- **PoW на чистом JS**: `DeepSeekHashV1` (SHA3-256 с пропуском round 0) + solver. ~0.5 c на сложность 144 000, вычисления в отдельном worker-потоке.
- **Сессии-треды**: `session_key` (или `conversation_id`, `user`, `X-Session-Id`) → отдельный чат на стороне DeepSeek. ID пишутся в `data/sessions.json` сразу, поэтому рестарт продолжает тот же чат, а не создаёт новый.
- **Ровный пейсинг**: один upstream-запрос на токен одновременно, настраиваемая пауза + джиттер, отдельные cooldown'ы для auth-ошибок и rate limit.
- **Thinking и web search**: `deepseek-reasoner` / `thinking: true` отдаёт `reasoning_content`; `search: true` включает поиск DeepSeek.
- **Ротация токенов**: несколько аккаунтов, round-robin, cooldown на 401/403, hot-reload без рестарта.
- **Cloudflare-ready**: поддержка `cf_clearance` из `data/cookies.json` (совместим с xtekky/deepseek4free) и понятная ошибка, если Cloudflare всё же включился.
- **Авто-продолжение**: если DeepSeek вернул `INCOMPLETE`/`auto_continue`, прокси сам дергает `/api/v0/chat/continue`.
- **Ноль зависимостей**: только Node.js ≥ 18.17.

---

## Быстрый старт

```bash
git clone https://github.com/pvuno/deepseek4free.git
cd deepseek4free

cp tokens.txt.example tokens.txt   # Windows: copy tokens.txt.example tokens.txt
# вставь свой токен в tokens.txt — как получить, см. «Где взять токен» ниже

npm start
# или: node src/index.js
```

Можно вообще без файла — передать токен через окружение:

```bash
DEEPSEEK_TOKEN="твой_токен" node src/index.js
```

Проверка:

```bash
curl http://127.0.0.1:9270/health
curl http://127.0.0.1:9270/v1/models

curl http://127.0.0.1:9270/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Привет!"}]}'
```

### Где взять токен

Открой `https://chat.deepseek.com`, войди в аккаунт, открой DevTools (F12) → **Console** и выполни:

```js
JSON.parse(localStorage.getItem("userToken")).value
```

Команда выведет токен. Чтобы сразу скопировать его в буфер обмена:

```js
copy(JSON.parse(localStorage.getItem("userToken")).value)
```

Если в старой версии сайта `userToken` хранится просто строкой:

```js
localStorage.getItem("userToken")
```

Вручную: DevTools → **Application** → **Local Storage** → `https://chat.deepseek.com` → ключ **`userToken`** → поле `value`.

Вставь токен одной строкой в `tokens.txt`. Можно несколько строк — токены ротируются. Строки формата `user@example.com:password` прокси попробует залогинить через `/api/v0/users/login`.

> Токен — это полный доступ к аккаунту. Никому его не передавай и не коммить `tokens.txt`.

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

Том `/data` хранит `sessions.json`, поэтому рестарт контейнера продолжает те же чаты.

---

## API

### `POST /v1/chat/completions`

Поддерживаются обычные поля OpenAI (`model`, `messages`, `stream`, `stream_options.include_usage`, `temperature`, `max_tokens` — два последних принимаются, но веб-API DeepSeek их не использует).

Дополнительные поля:

| Поле | Описание |
|---|---|
| `session_key` | Имя треда. Один ключ = один диалог на сервере DeepSeek. |
| `conversation_id`, `user`, `X-Session-Id` | Альтернативные имена для `session_key`. |
| `thinking` / `thinking_enabled` | `true` — включить рассуждения. |
| `search` / `search_enabled` | `true` — включить веб-поиск DeepSeek. |
| `include_reasoning` | `false` — не отдавать `reasoning_content` (по умолчанию отдаём). |

```bash
# non-stream
curl http://127.0.0.1:9270/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "session_key": "chat:42",
    "messages": [
      {"role": "system", "content": "Ты кот."},
      {"role": "user", "content": "Мяу?"}
    ]
  }'

# stream
curl -N http://127.0.0.1:9270/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-reasoner","stream":true,"messages":[{"role":"user","content":"2+2?"}]}'
```

Пример через официальный OpenAI SDK:

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:9270/v1',
  apiKey: 'local',
});

const r = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Привет!' }],
});
console.log(r.choices[0].message.content);
```

### Служебные эндпоинты

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Статус, версия, токены, сессии. |
| `GET` | `/v1/models` | Список моделей-алиасов. |
| `POST`/`GET` | `/v1/tokens/status` | Сколько токенов, какой активен, кто в cooldown. |
| `POST`/`GET` | `/v1/tokens/reload` | Перечитать `tokens.txt` без рестарта (сессии сбрасываются). |
| `POST`/`GET` | `/v1/tokens/check` | Проверить активный токен (создать и удалить тестовую сессию). |
| `POST`/`GET`/`DELETE` | `/v1/chat/reset?session=KEY` | Забыть тред. `session=*` — забыть все, без параметра — безымянный. |

---

## Как это работает

### 1. PoW (самое интересное)

Перед каждым сообщением DeepSeek требует решить challenge:

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

Клиент перебирает `nonce ∈ [0, difficulty)` и ищет такой, что:

```
DeepSeekHashV1(salt + "_" + expire_at + "_" + nonce) === challenge
```

Готовый ответ кладётся в заголовок `x-ds-pow-response` как `base64(JSON)`:

```json
{"algorithm":"DeepSeekHashV1","challenge":"...","salt":"...",
 "answer":72000,"signature":"...","target_path":"/api/v0/chat/completion"}
```

**DeepSeekHashV1** — это SHA3-256, в котором Keccak-f[1600] делает только раунды **1..23** (раунд 0 пропущен). Всё остальное стандартное: rate = 136, padding `0x06 ... 0x80`, выход 32 байта. Поэтому обычный `sha3-256` из Node/OpenSSL **не подходит** — нужна своя перестановка (`src/pow.js`).

Тест-векторы из официального WASM:

```
hash("")                                 = e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3
hash("testsalt_1700000000_42")           = d4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09
hash("testsalt_1700000000_100000")       = abea2f35796b65486e9be1b36f7878c66cab021e96faa473fdf4decd31f9ba30
hash("abc123salt_1700000000_12345")      = 74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1
```

### 2. Полный запрос

```
POST /api/v0/chat_session/create            {"agent":"chat"}          → session_id
POST /api/v0/chat/create_pow_challenge      {"target_path":...}        → challenge
   (локально решаем PoW)
POST /api/v0/chat/completion                {chat_session_id, parent_message_id,
                                             prompt, thinking_enabled, ...}
   заголовки: authorization: Bearer <userToken>
              x-ds-pow-response: <base64>
   ответ:     text/event-stream (JSON-patch'и)
```

SSE DeepSeek — это не обычные delta-чанки, а патчи к объекту ответа:

```jsonc
{"v":{"response":{"message_id":2,"fragments":[{"type":"THINK","content":"..."}]}}}
{"p":"response/fragments/-1/content","o":"APPEND","v":"Hel"}
{"v":"lo"}                                  // продолжение предыдущего пути
{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":""}]}
{"p":"response/status","o":"SET","v":"FINISHED"}
```

`src/sse.js` собирает из этого чистый текст, reasoning и usage, игнорируя `TIP`, `quasi_status`, `elapsed_secs` и прочий служебный мусор.

### 3. Треды и контекст

- **Первый** запрос с новым `session_key` отправляет DeepSeek всю историю из `messages` (system-промпт + реплики), чтобы серверный чат был в том же контексте.
- **Следующие** запросы отправляют только последнее сообщение пользователя — историю помнит сам DeepSeek.
- `parent_message_id` обновляется после каждого ответа.
- Запись сессии сохраняется в `data/sessions.json` **сразу**, поэтому рестарт продолжает тот же чат.
- Без `session_key` создаётся одноразовый чат, который удаляется после ответа.
- Запросы с одинаковым ключом сериализуются (DeepSeek не любит параллельные completion в одном чате).

---

## Сессии и безопасность аккаунта

- `data/sessions.json` пишется при каждом изменении. Новый чат DeepSeek создаётся только если записи нет, она привязана к другому токену или тред истёк по `SESSION_TTL_MS`.
- Если процесс упал в середине первого запроса, запись остаётся с `seeded: false`. Следующий запрос переиспользует этот чат и снова отправит полную историю — новый чат не создаётся.
- На один токен одновременно идёт только один upstream-запрос. Между запросами прокси ждёт `MIN_REQUEST_INTERVAL_MS` + случайный джиттер.
- `401/403` отправляет токен в cooldown; `429` использует `RATE_LIMIT_COOLDOWN_MS` (или `Retry-After` от DeepSeek) и переключает на другой токен.
- Не запускай один и тот же токен в нескольких экземплярах бота: пейсинг считается в рамках процесса.
- `DEEPSEEK_PROFILE=web` отправляет браузерные заголовки; `data/cookies.json` или `CF_CLEARANCE` закрывают Cloudflare.

Это делает трафик ровным и без резких всплесков, но не гарантирует отсутствие бана.

---

## Cloudflare

Обычно запросы проходят с обычными заголовками (профиль `android`). Если Cloudflare начал отдавать «Just a moment…», нужен `cf_clearance`:

1. Положи cookie в `data/cookies.json`:
   ```json
   {
     "cookies": { "cf_clearance": "..." },
     "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
   }
   ```
2. Или задай `CF_CLEARANCE=...` в окружении.

Формат совместим с `xtekky/deepseek4free`, поэтому cookie можно добыть их скриптом:

```bash
python -m dsk.bypass   # из репозитория xtekky/deepseek4free
```

Либо вручную: DevTools → Application → Cookies → `https://chat.deepseek.com` → `cf_clearance`. Файл подхватывается на лету (кеш 30 секунд).

Если включён профиль `DEEPSEEK_PROFILE=web`, прокси отправляет браузерные `Origin`, `Referer`, `User-Agent`, `x-app-version` — это снижает шанс челленджа. Профиль `android` (по умолчанию) проверен и работает без cookie.

---

## Сравнение с xtekky/deepseek4free

| | этот проект | [xtekky/deepseek4free](https://github.com/xtekky/deepseek4free) |
|---|---|---|
| Язык | Node.js, **0 зависимостей** | Python + `wasmtime`, `numpy`, `curl-cffi`, `nodriver` |
| PoW | своя реализация `DeepSeekHashV1` на JS | официальный WASM DeepSeek |
| Интерфейс | **OpenAI-совместимый HTTP API** | Python-библиотека |
| Стриминг | SSE-чанки OpenAI | Python-генератор чанков |
| Треды | `session_key` + персистентность | `chat_session_id` вручную |
| Несколько аккаунтов | ротация токенов + cooldown | один токен |
| Cloudflare | `data/cookies.json` / `CF_CLEARANCE` | встроенный headless-браузер |
| Установка | `node src/index.js` | `pip install -r requirements.txt` + браузер |

Идея и протокол те же; этот проект заточен под интеграцию с ботами и OpenAI-клиентами.

---

## Интеграция с ботом или своим клиентом

Запусти прокси и используй `http://127.0.0.1:9270/v1` как OpenAI base URL. Полезные для ботов возможности:

- порт `9270` (меняется через `PORT`);
- поле `session_key` в `/v1/chat/completions` — отдельный диалог на каждый чат;
- `POST /v1/chat/reset`, `?session=...`, `?session=*`;
- `GET /v1/tokens/status` → `{tokens, active}`;
- `POST /v1/tokens/reload` → `{status:"reloaded", tokens}`.

Если твой клиент ожидает локальный `proxy.js` (шим для автозапуска), создай его рядом с клиентом:

```js
// proxy.js — запускает этот прокси в том же процессе
require('/path/to/deepseek4free/src/index.js');
```

Либо запускай прокси отдельным процессом (`npm start`) и подключайся к `127.0.0.1:9270`.

---

## Конфигурация

Все настройки — через переменные окружения (см. `.env.example`). Самые важные:

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `9270` | Адрес API. |
| `TOKENS_FILE` | `tokens.txt` | Файл с токенами. |
| `SESSIONS_FILE` | `data/sessions.json` | Состояние тредов. |
| `DEEPSEEK_TOKEN(S)` | — | Токен(ы) через env, если файл пуст. |
| `PROXY_API_KEY` | — | Если задан, клиент обязан прислать `Authorization: Bearer <key>`. Обязателен при `HOST≠127.0.0.1`. |
| `THINKING` | `off` | Режим рассуждений по умолчанию. |
| `SEARCH_ENABLED` | `0` | Веб-поиск DeepSeek по умолчанию. |
| `DEEPSEEK_PROFILE` | `android` | `android` или `web` (браузерные заголовки). |
| `COOKIES_FILE` | `data/cookies.json` | Cloudflare-cookies (необязательно). |
| `POW_WORKERS` | `1` | Потоки для PoW (`0` — в основном потоке). |
| `MAX_RETRIES` | `3` | Повторы при 5xx/PoW-ошибках. |
| `TOKEN_COOLDOWN_MS` | `600000` | Пауза для токена после 401/403. |
| `RATE_LIMIT_COOLDOWN_MS` | `60000` | Пауза после 429 / rate limit. |
| `MIN_REQUEST_INTERVAL_MS` | `1500` | Минимальный интервал между запросами к DeepSeek на токен (`0` — выключить). |
| `REQUEST_JITTER_MS` | `500` | Случайная добавка к интервалу. |
| `SESSION_TTL_MS` | `21600000` | Удалять неиспользуемые треды через это время. |
| `AUTO_CONTINUE` | `1` | Дописывать оборванные ответы. |

Node.js **не читает `.env` автоматически**. Используй:

```bash
node --env-file=.env src/index.js
```

---

## Разработка

Структура:

```
src/
  index.js      точка входа
  app.js        HTTP-роутер + OpenAI-слой
  deepseek.js   клиент chat.deepseek.com (сессии, PoW, стрим, ротация)
  pow.js        DeepSeekHashV1 + solver (чистый JS)
  pow-pool.js   worker_threads-пул
  pow-worker.js
  sse.js        парсер JSON-patch SSE DeepSeek
  sessions.js   треды + персистентность
  tokens.js     tokens.txt + round-robin + cooldown
  config.js
  logger.js
```

---

## Ограничения

- Нет загрузки файлов (`ref_file_ids` не поддерживается).
- Поиск DeepSeek включается флагом `search: true`; прокси отдаёт только текст ответа, без списка источников.
- `temperature`/`max_tokens` игнорируются — это ограничение веб-API, а не прокси.
- Бесплатный веб-аккаунт имеет лимиты и может потребовать капчу/подтверждение; прокси не обходит капчу.
- Токен — это доступ к аккаунту. Утечка `tokens.txt` = утечка аккаунта.

## Безопасность

- По умолчанию слушаем только `127.0.0.1`.
- `PROXY_API_KEY` обязателен для любого другого `HOST`.
- Токены никогда не логируются (только `abcd...wxyz`).
- `.gitignore` исключает `tokens.txt`, `.env` и `data/`.

## License

MIT