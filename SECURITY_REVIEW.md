# Security review

Дата: 2026-07-30
Область: локальный Node.js/TypeScript stdio MCP server, YAZIO auth, read/write
tools, filesystem persistence и dependency tree.

## Executive summary

Открытых Critical/High security findings после исправлений не осталось.
Production dependency audit возвращает 0 vulnerabilities; полный dependency
audit также возвращает 0. Сервер не логирует секреты, фильтрует профиль,
использует fail-closed idempotency, подписанный MRTR state и одноразовое
подтверждение destructive-операций.

Основной остаточный риск — сам неофициальный API YAZIO: контракт, общая
application OAuth-пара и server behavior не имеют официальной гарантии.

## Исправленные findings

### SEC-001 — High — повтор write после неуспешной verification

**Impact:** transport/read error после уже применённой записи мог разрешить
повтор с тем же idempotency key и создать дубль.

Исправлено: после начала mutation journal остаётся `pending` при неоднозначной
ошибке, а не становится retryable; успешный write с неуспешным reread получает
`applied_unverified` и сохраняется как completed. Batch компенсирует также
client-generated ID элемента с неопределённым исходом.

Код: `src/services/write-service.ts:49`, `src/services/write-service.ts:79`,
`src/services/write-service.ts:147`.

Regression test: `tests/writes.test.ts` — “does not repeat a successful write
when verification read fails”.

### SEC-002 — High — небезопасное локальное хранение OAuth tokens

**Impact:** широкие права или symlink-following могли раскрыть access/refresh
token локальному пользователю либо записать его не в ожидаемый файл.

Исправлено: token cache создаётся через `O_CREAT | O_EXCL | O_NOFOLLOW`, mode
`0600`, `fsync` и atomic rename; symlink target отклоняется. Password никогда
не сохраняется.

Код: `src/auth/token-store.ts:24`, `src/auth/token-store.ts:48`.

Test: `tests/auth.test.ts` проверяет refresh flow, отсутствие password и mode
`0600`.

### SEC-003 — Medium — раскрытие лишнего PII из `/user`

**Impact:** полный upstream profile содержит email, DOB, user token и
платёжные идентификаторы, которые могли попасть в model context.

Исправлено: `getUserProfile` строит явный allowlist и не распространяет raw
object.

Код: `src/adapters/yazio-adapter.ts:120`, tool metadata:
`src/server.ts:170`.

Protocol smoke дополнительно проверяет, что fixture email и user token не
появляются в `structuredContent`.

### SEC-004 — Medium — lost update и cross-process race для water

**Impact:** YAZIO water POST принимает cumulative total; параллельные
read-modify-write могли перезаписать друг друга.

Исправлено в пределах локальной конфигурации с общим state path:
per-date process queue и owner-aware inter-process filesystem lock с heartbeat
покрывают весь read-modify-write; живой lock нельзя вытеснить по одному
возрасту mtime. Результат проверяется повторным GET.

Код: `src/services/write-service.ts:256`,
`src/persistence/idempotency-store.ts:125`.

### SEC-005 — High — caller мог самостоятельно подтвердить удаление

**Impact:** предсказуемые `confirm=true` и `DELETE:<id>` позволяли модели
обойти реальное участие пользователя.

Исправлено: modern MCP использует elicitation и HMAC-SHA256 `requestState` с
TTL/account binding. Legacy fallback выдаёт случайный одноразовый token,
хранит только его digest и атомарно потребляет token перед DELETE.
MRTR preflight использует отдельные `prepare*` методы: не создаёт невидимых
legacy tokens, а elicitation показывает имя, meal, дату и старое/новое значение.

Код: `src/server.ts`, `src/services/write-service.ts`,
`src/persistence/idempotency-store.ts`.

### SEC-006 — High — эвристическая batch-компенсация

**Impact:** совпадение product/meal/amount могло принять конкурентную запись за
созданную текущим batch и удалить её.

Исправлено: verification и rollback используют только точный client-generated
ID. После DELETE выполняется повторное чтение; недоказанный результат получает
`uncertain`/`rollback_failed`, а оставшиеся элементы — `not_attempted`.

Код: `src/services/write-service.ts`.

### SEC-007 — Medium — upstream drift маскировался нулями

**Impact:** изменившийся YAZIO 2xx payload мог выглядеть как пустой дневник,
нулевая вода или нулевая аналитика.

Исправлено: endpoint-specific raw schemas требуют подтверждённые обязательные
поля и преобразуют mismatch в `UPSTREAM_INVALID_RESPONSE`.

Код: `src/adapters/yazio-adapter.ts`.

### SEC-008 — High — потеря или дублирование при изменении количества

**Impact:** эмуляция update через удаление старой записи до создания новой
могла потерять данные; необработанный сбой после POST мог оставить дубль.

Исправлено: `update_consumed_item` сначала создаёт replacement с новым UUID,
проверяет точный ID, затем удаляет исходную запись и снова читает дневник. Если
исходная запись осталась, удаляется только replacement. Неподтверждённое
восстановление возвращает `partial_failure` с обоими IDs и не повторяется
вслепую благодаря idempotency journal. Tool требует MRTR либо одноразовый
confirmation token. Ошибка transport после применённого POST reconciled по
точному replacement ID, а полный flow сериализован по date/item ID.

Код: `src/services/write-service.ts`, `src/server.ts`.
Regression tests: `tests/update-consumed-item.test.ts`.

### SEC-009 — High — token cache мог относиться к другому аккаунту

**Impact:** после изменения `YAZIO_USERNAME` пригодный cached token мог
продолжить работу с предыдущим аккаунтом.

Исправлено: новый token получает `account_binding` — SHA-256 от нормализованных
username, base URL и client ID. При несовпадении или legacy cache без binding
сервер очищает cache и выполняет password grant для настроенного пользователя.

Код: `src/auth/auth-manager.ts`, `src/auth/token-store.ts`.
Regression test: `tests/auth.test.ts`.

### SEC-010 — Medium — частичные diary totals выглядели полными

**Impact:** recipe/simple rows без nutrients исключались из item sum, поэтому
дневник мог вернуть правдоподобный, но заниженный total.

Исправлено: при строках без nutrition adapter получает totals из daily-summary.
Fallback item sum сопровождается `totals_complete: false`,
`totals_source` и `missing_nutrition_item_ids`.

Код: `src/adapters/yazio-adapter.ts`, `src/schemas.ts`.
Regression test: `tests/recipes-adapter.test.ts`.

## Остаточные риски

### RISK-001 — High operational — неофициальный API

YAZIO может изменить `/v19`, payload или OAuth behavior без уведомления.
Mitigation: configurable base URL, strict response validation, bounded
timeouts/concurrency, `Retry-After` только для GET, unified errors,
mock/live tests и documented unsupported features.

### RISK-002 — Medium — secrets в environment/client configuration

Environment изолирует secrets от git, но некоторые MCP clients сохраняют
literal password в plaintext config. Используйте forwarding (`env_vars`) или OS
secret manager и ограничьте права client config. Любой password, раскрытый в
чате или shell history, необходимо сменить. Встроенная application OAuth-пара
является общей и уже опубликована upstream; она не является пользовательским
секретом, но может быть отозвана YAZIO.

### RISK-003 — Medium — Windows ACL

POSIX mode `0600` не является полноценной ACL-гарантией на Windows. Пользователь
должен ограничить ACL каталога token/state средствами Windows.

### RISK-004 — Low — tokens не шифруются at rest

Tokens защищены filesystem permissions, но не отдельным key encryption.
Для локального single-user threat model это принято; при multi-user или
managed endpoint следует заменить `TokenStore` на OS keychain-backed adapter.

### RISK-005 — Verification gap

Live tests не являются частью default suite и требуют явного
`YAZIO_LIVE_TEST=1`. Mock tests доказывают локальные контракты, но не
гарантируют текущее поведение частного YAZIO API. В частности, read-only
recipe endpoints из открытого PR реализованы только внутри adapter и не
экспонируются как MCP tools до отдельного live-probe на v19.

## Выполненные проверки

- ESLint type-aware rules;
- strict TypeScript typecheck;
- unit/mock tests, включая auth/idempotency/batch/locking/strict-upstream regression;
- modern MCP 2026-07-28 MRTR и legacy one-time-token stdio smoke;
- `npm audit --omit=dev` и полный `npm audit`;
- npm registry signatures/attestations;
- repository secret-pattern scan и `git diff --check`;
- privacy assertion в protocol smoke.
