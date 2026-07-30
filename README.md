# nutrition-mcp

Локальный stdio MCP-сервер для персонального учёта питания через неофициальный
reverse-engineered API YAZIO.

> [!WARNING]
> YAZIO не публикует и не поддерживает публичный API. Маршруты могут измениться
> без предупреждения, аккаунт может попасть под ограничения сервиса, а операции
> записи нельзя считать транзакционными. Используйте сервер только для своего
> аккаунта и на свой риск.

## Возможности

- MCP `2026-07-28` через официальный split SDK v2 и совместимость с legacy
  MCP-клиентами через `serveStdio`;
- refresh-token flow с fallback на password grant;
- безопасный token cache (`0600` на POSIX, каталог `0700`);
- русский поиск по умолчанию: `RU` / `ru_RU`;
- даты в явной timezone, по умолчанию `Europe/Moscow`;
- `structuredContent`, `outputSchema`, короткий текстовый fallback и единый
  machine-readable error envelope;
- диапазоны дневника, локально собранные из подтверждённых однодневных запросов;
- `dry_run`, durable idempotency journal, duplicate detection и read-after-write;
- batch-компенсация с результатом каждого элемента;
- MRTR-подтверждение удаления и безопасный fallback для legacy-клиентов;
- тренды, сравнение периодов и поиск вероятно пропущенных приёмов пищи.

Проект не использует пакет `yazio` как runtime-зависимость. Интеграция
изолирована в сменном `NutritionBackend` / `YazioAdapter`.

## Требования и установка

Node.js 20+ поддерживается. Для production рекомендуется актуальная LTS-ветка
Node.js 22 или 24.

```bash
git clone <local-or-approved-repository>
cd nutrition-mcp
npm ci
npm run build
```

Сервер запускается командой:

```bash
node /absolute/path/to/nutrition-mcp/dist/index.js
```

stdout зарезервирован только для MCP JSON-RPC. Диагностика transport отправляется
в stderr.

## Конфигурация

Скопируйте `.env.example` только как список переменных. Сервер сам не загружает
`.env`; передавайте значения через environment вашего MCP-клиента или менеджер
секретов.

Обязательные для первой авторизации:

| Переменная | Назначение |
|---|---|
| `YAZIO_USERNAME` | Логин личного аккаунта |
| `YAZIO_PASSWORD` | Пароль личного аккаунта |
| `YAZIO_CLIENT_ID` | OAuth client ID из трафика вашего авторизованного клиента |
| `YAZIO_CLIENT_SECRET` | Соответствующий OAuth client secret |

После первой авторизации access/refresh token сохраняются локально. Password
остаётся только в environment и используется снова, если refresh token отклонён.

Дополнительные переменные:

| Переменная | Default |
|---|---|
| `YAZIO_BASE_URL` | `https://yzapi.yazio.com/v20` |
| `YAZIO_TOKEN_CACHE_PATH` | `~/.nutrition-mcp/token.json` |
| `NUTRITION_MCP_STATE_PATH` | `~/.nutrition-mcp/state.json` |
| `NUTRITION_MCP_TIMEZONE` | `Europe/Moscow` |
| `YAZIO_PRODUCT_COUNTRIES` | `RU` |
| `YAZIO_PRODUCT_LOCALES` | `ru_RU` |
| `YAZIO_DEFAULT_SEX` | `male` |
| `YAZIO_HTTP_TIMEOUT_MS` | `15000` |

`YAZIO_BASE_URL` настраиваемый, потому что API неофициальный. Не передавайте его
из prompt/tool input: это только доверенная локальная конфигурация.

## Подключение клиентов

В примерах замените `/absolute/path/to/nutrition-mcp` на фактический путь.
Секреты не следует коммитить в client config. Предпочтительно экспортировать их
из shell/secret manager и использовать forwarding, если клиент это поддерживает.

### Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  nutrition:
    command: "node"
    args: ["/absolute/path/to/nutrition-mcp/dist/index.js"]
    env:
      YAZIO_USERNAME: "set-locally"
      YAZIO_PASSWORD: "set-locally"
      YAZIO_CLIENT_ID: "set-locally"
      YAZIO_CLIENT_SECRET: "set-locally"
      NUTRITION_MCP_TIMEZONE: "Europe/Moscow"
    timeout: 90
    connect_timeout: 15
    supports_parallel_tool_calls: false
    enabled: true
```

Parallel calls отключены как консервативный default для неофициального API.
Сам сервер сериализует запись воды между процессами при общем
`NUTRITION_MCP_STATE_PATH`. Формат `mcp_servers` подтверждён
[документацией Hermes](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md).

### Claude Code

Проектный `.mcp.json`:

```json
{
  "mcpServers": {
    "nutrition": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/nutrition-mcp/dist/index.js"],
      "env": {
        "YAZIO_USERNAME": "${YAZIO_USERNAME}",
        "YAZIO_PASSWORD": "${YAZIO_PASSWORD}",
        "YAZIO_CLIENT_ID": "${YAZIO_CLIENT_ID}",
        "YAZIO_CLIENT_SECRET": "${YAZIO_CLIENT_SECRET}"
      }
    }
  }
}
```

Проверка:

```bash
claude mcp list
```

Синтаксис stdio и `--env` описан в
[официальной документации Claude Code](https://code.claude.com/docs/en/mcp).

### Claude Desktop

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`.
Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "nutrition": {
      "command": "node",
      "args": ["/absolute/path/to/nutrition-mcp/dist/index.js"],
      "env": {
        "YAZIO_USERNAME": "set-locally",
        "YAZIO_PASSWORD": "set-locally",
        "YAZIO_CLIENT_ID": "set-locally",
        "YAZIO_CLIENT_SECRET": "set-locally"
      }
    }
  }
}
```

Desktop-конфиг содержит literal values. Ограничьте права файла и, если
возможно, запускайте Desktop через OS secret manager/launcher, а не храните
пароль в plaintext.

### Codex / ChatGPT desktop app

Безопаснее всего экспортировать секреты в окружение и forward-ить их через
`~/.codex/config.toml`:

```toml
[mcp_servers.nutrition]
command = "node"
args = ["/absolute/path/to/nutrition-mcp/dist/index.js"]
env_vars = [
  "YAZIO_USERNAME",
  "YAZIO_PASSWORD",
  "YAZIO_CLIENT_ID",
  "YAZIO_CLIENT_SECRET"
]
default_tools_approval_mode = "writes"
startup_timeout_sec = 15
tool_timeout_sec = 90
enabled = true
```

Либо через CLI:

```bash
codex mcp add nutrition --env YAZIO_USERNAME="$YAZIO_USERNAME" --env YAZIO_PASSWORD="$YAZIO_PASSWORD" --env YAZIO_CLIENT_ID="$YAZIO_CLIENT_ID" --env YAZIO_CLIENT_SECRET="$YAZIO_CLIENT_SECRET" -- node /absolute/path/to/nutrition-mcp/dist/index.js
```

`env_vars` предпочтительнее CLI-варианта: последний сохраняет переданные
значения в локальную конфигурацию. Codex CLI, IDE и desktop app используют
общую MCP-конфигурацию; после изменения перезапустите клиент.

## Инструменты

| Tool | Назначение |
|---|---|
| `get_user_profile` | Privacy-filtered профиль без email/DOB/token/payment PII |
| `get_goals` | Цели калорий, БЖУ, воды, шагов и веса |
| `search_products` | Поиск с RU/ru_RU default |
| `get_product` | Полная карточка и nutrients на 100 g/ml |
| `get_diary` | Дата или диапазон до 31 дня |
| `get_daily_summary` | Сводка дня и meal buckets |
| `get_water_intake` | Кумулятивная вода |
| `get_weight` | Последний вес на дату |
| `get_exercises` | Упражнения на дату |
| `add_consumed_item` | Preview, duplicate check, idempotency, verification |
| `add_meal_batch` | До 25 позиций с компенсацией |
| `remove_consumed_item` | MRTR/explicit confirmation и verification |
| `add_water_intake` | Read-modify-write кумулятивного total |
| `get_nutrition_trends` | День/ISO-неделя/месяц, averages/goals/stability |
| `compare_periods` | Сравнение средних двух периодов |
| `detect_probable_missing_meals` | Только вероятные пропуски, без auto-write |

Каждый write-tool требует `client_request_id`. `dry_run` по умолчанию `true`.
Чтобы выполнить запись, явно передайте `dry_run: false`.

Примеры prompt:

```text
Найди овсяные хлопья в российской базе YAZIO.
Покажи дневник с 2026-07-01 по 2026-07-07.
Сначала dry-run: добавь 80 г продукта <uuid> на завтрак 2026-07-30.
Сравни средние калории и БЖУ за две последние полные недели.
Найди вероятно пропущенные завтраки, но ничего не добавляй.
```

### Удаление и MRTR

Modern MCP 2026-клиент получает form elicitation. Для клиента без MRTR:

1. вызовите `remove_consumed_item` с `dry_run: true`;
2. проверьте item в preview;
3. повторите с `dry_run: false` и одноразовым `confirmation_token` из preview.

Token случаен, действует десять минут, привязан к аккаунту, item/date и
атомарно потребляется при первом использовании. Предсказуемая строка или
`confirm: true` не принимаются. MRTR `requestState` подписан HMAC-SHA256,
ограничен TTL и привязан к аккаунту и MCP-методу.

### Batch semantics

YAZIO не документирует транзакционность массива consumed items. Сервер поэтому
пишет элементы последовательно. При ошибке он удаляет уже созданные IDs в
обратном порядке. Ответ каждого элемента имеет статус `applied`,
`applied_unverified`, `failed`, `not_attempted`, `uncertain`, `rolled_back`
или `rollback_failed`.
`partial_failure` означает, что полная компенсация не подтверждена.
Компенсация использует только сгенерированный этим batch ID и подтверждается
повторным чтением; похожая конкурентная запись никогда не удаляется
эвристически.

## Подтверждённые YAZIO маршруты

Источники: merged-код
[`juriadams/yazio`](https://github.com/juriadams/yazio), прототип
[`fliptheweb/yazio-mcp`](https://github.com/fliptheweb/yazio-mcp), открытый
[PR v20/refresh](https://github.com/juriadams/yazio/pull/6) и безопасные
публичные GET-probes.

| Method | Path | Статус |
|---|---|---|
| `POST` | `/oauth/token` password grant | merged upstream |
| `POST` | `/oauth/token` refresh grant | issue + open PR; mock-tested здесь |
| `GET` | `/user` | merged upstream |
| `GET` | `/user/goals/unmodified?date=` | merged upstream |
| `GET` | `/products/search?...` | merged + публичный v15/v20 probe |
| `GET` | `/products/{uuid}` | merged + публичный v15/v20 probe |
| `GET` | `/user/consumed-items?date=` | merged upstream |
| `POST` | `/user/consumed-items` | merged upstream |
| `DELETE` | `/user/consumed-items` body `["entry-uuid"]` | merged upstream |
| `GET` | `/user/widgets/daily-summary?date=` | merged upstream |
| `GET` | `/user/water-intake?date=` | merged upstream |
| `POST` | `/user/water-intake` cumulative array payload | issue + working prototype |
| `GET` | `/user/bodyvalues/weight/last?date=` | merged upstream |
| `GET` | `/user/exercises?date=` | merged upstream |

Default `/v20` наблюдается в открытом upstream PR и отвечает на публичные
product GET-запросы. Это не официальный стабильный контракт; при регрессии
можно временно задать `/v15` через `YAZIO_BASE_URL`.

## Unsupported

- `update_consumed_item`: подтверждённых `PUT/PATCH` не найдено;
- нативные range endpoints: диапазоны реализованы bounded-перебором дат;
- полная история веса: подтверждён только `/weight/last`;
- create/update recipes: не подтверждены;
- read/delete recipes: только в незамёрженном upstream PR, поэтому не exposed;
- нативный barcode lookup: не найден; поиск EAN как текста не выдаётся за API;
- гарантированная атомарность batch: YAZIO её не документирует;
- безопасный atomic increment воды: API принимает cumulative total, поэтому
  writers вне этого MCP-сервера или процессы с разными state path могут создать
  lost update. Процессы nutrition-mcp с общим state path используют owner-aware
  lock с heartbeat.

## Ответы и ошибки

Success:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "timezone": "Europe/Moscow",
    "backend": "yazio-unofficial-v20",
    "generated_at": "2026-07-30T00:00:00.000Z"
  }
}
```

Tool failure возвращается с `isError: true`:

```json
{
  "ok": false,
  "error": {
    "code": "DUPLICATE_DETECTED",
    "message": "Найдена вероятная дублирующая запись; запись не выполнена.",
    "retryable": false
  }
}
```

Password, access/refresh token, Authorization header, полный `/user` response и
auth response body не попадают в ошибки или логи.

## Разработка и проверки

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke
npm audit --omit=dev --audit-level=high
```

`npm run smoke` поднимает локальный mock YAZIO, запускает собранный сервер как
дочерний stdio process и проверяет modern `2026-07-28` MRTR, подписанный
`requestState`, legacy one-time-token fallback, tool schemas и
`structuredContent`.

### Live-тесты

Live-тесты выключены по умолчанию:

```bash
export YAZIO_LIVE_TEST=1
export YAZIO_USERNAME='...'
export YAZIO_PASSWORD='...'
export YAZIO_CLIENT_ID='...'
export YAZIO_CLIENT_SECRET='...'
export YAZIO_LIVE_PRODUCT_ID='safe-product-uuid'
npm run test:live
```

Live write-test создаёт запись в `try` и удаляет тот же generated entry ID в
`finally`, затем проверяет удаление. Если cleanup не подтверждён, тест падает.
Не запускайте write-test на важной дате без резервной ручной проверки дневника.

## Privacy и security

- сервер предназначен для одного локального пользователя;
- token/state files создаются атомарно и с POSIX mode `0600`; default-каталог
  при первом создании получает `0700`, а права custom parent directory сервер
  намеренно не изменяет;
- на Windows mode bits не заменяют ACL — защитите каталог средствами ОС;
- profile использует allowlist и не возвращает email, DOB, `user_token`,
  Stripe ID или полный upstream object;
- idempotency journal не хранит password/tokens;
- одноразовые confirmation tokens хранятся только в виде SHA-256 digest;
- изменившиеся успешные YAZIO payloads дают `UPSTREAM_INVALID_RESPONSE`, а не
  правдоподобные нули;
- range reads и product enrichment ограничены шестью параллельными запросами;
- GET после `429` повторяется один раз с учётом `Retry-After`; mutations
  автоматически не повторяются;
- write retries не выполняются вслепую;
- secrets не должны попадать в git, shell history, issue или screenshot;
- после раскрытия password в любом чате/логе его следует сменить.

## MCP compatibility

Монолитный `@modelcontextprotocol/sdk@1.30.0` остаётся v1 и поддерживает максимум
протокол `2025-11-25`. Поэтому проект использует стабильные официальные split
packages `@modelcontextprotocol/server@2.0.0` и
`@modelcontextprotocol/client@2.0.0`, которые реализуют `2026-07-28`,
`server/discover`, stateless request metadata и MRTR. `serveStdio` оставляет
legacy shim включённым для существующих Claude/Hermes клиентов.

Спецификация:
[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28),
[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

## Происхождение

Endpoint contracts и общая ориентация сверялись с upstream-референсами.
Production-код написан заново и не импортирует их runtime. MIT attribution для
`fliptheweb/yazio-mcp` сохранён в `THIRD_PARTY_NOTICES.md`.
