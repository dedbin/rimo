# Одна проверка состояния Compose

`scripts/monitor-service.mjs` — операторский агрегатор для пяти сервисов Rimo. За один вызов он выдаёт один JSON и завершается. Нужны Node.js 22.12+, Docker Compose и доступ оператора к выбранному Docker engine и приватному env-файлу. Docker socket приложению не передаётся.

```sh
node scripts/monitor-service.mjs --project rimo --env-file /srv/rimo/.env --compose-file /srv/rimo/docker-compose.yml
```

Все три параметра обязательны. Проект выбирается явно; пути могут быть абсолютными или относительными к текущему каталогу. Значения из выбранного env-файла имеют приоритет над совпадающими переменными вызывающего процесса. Пароли и tokens не передаются аргументами. `--help` показывает только синтаксис и не обращается к Docker.

Команда выполняет только `compose ps`, ограниченный `inspect`, чтение `logs` и фиксированные `exec` с проверками. Она не запускает миграции, backup, SQL-запись, уборку, рестарт или создание контейнеров. Из `inspect` выбираются только ID, project/service labels, state, health, restart count и OOM flag; `Config.Env` не читается. Содержимое досок, IDs пользователей, cookies, пути данных и сырые stderr/logs в JSON не выводятся.

## Формат и коды

Верхний уровень содержит `version: 1`, `checkedAt` в UTC, `project`, `status`, `reasonCodes`, `limits` и `checks`. Каждый check имеет собственные `status`, `reasonCodes`, безопасный `data` и `durationMs`. Отсутствующая или невалидная проверка даёт critical; она не считается нулём ошибок.

| Exit | Status | Значение |
| --- | --- | --- |
| 0 | `healthy` | Все проверки доступны, предупреждающих причин нет |
| 1 | `warning` | Нужна проверка оператора; занятие может продолжаться |
| 2 | `critical` | Обнаружен отказ либо наблюдение неполное/недоступно |

Общий status — самый серьёзный из проверок. Для `app service-status` проверяется согласованность JSON и exit: его exit 1 с `warning` остаётся warning. Ошибка конфигурации тоже возвращает один безопасный critical JSON; текст исключения не печатается. SIGINT, SIGTERM и общий deadline дают critical с `MONITOR_INTERRUPTED_OR_DEADLINE`.

## Что проверяется

| Check | Источник и граница |
| --- | --- |
| `containers` | Ровно по одному `app`, `collaboration`, `db`, `export-worker`, `caddy` выбранного проекта; state/health/restarts/OOM |
| `application` | Существующий `scripts/service-status.ts` внутри app: PostgreSQL aggregate query, квоты и доступность/место файлов загрузок |
| `postgresFilesystems` | Числовые `avail/size` для `$PGDATA` и `$PGDATA/pg_wal` через GNU `df` внутри db; WAL может находиться на отдельной файловой системе |
| `pdfQueue` | Только GET `/healthz` на loopback существующего worker; возвращаются `running` и `waiting` |
| `collaborationEvents` | Известные persistence/ACL records выбранного collaboration за последние 300 секунд, с ограничением tail и объёма |

Контейнер в состоянии, отличном от running, unhealthy или с OOM flag даёт critical. Отсутствующий/неоднозначный сервис — critical. Health `starting` и ненулевой lifetime restart count — warning. Обязательные Docker health checks ожидаются у app/collaboration/db. Закреплённый worker image также содержит Docker healthcheck; его очередь дополнительно проверяется по HTTP. У Caddy healthcheck отсутствует: здесь он оценивается по Docker state. Это не проверка публичного HTTPS, DNS или сертификата.

Для обеих файловых систем PostgreSQL warning возникает при свободном месте ниже 2 ГиБ **или** 10%; critical — ниже 256 МиБ **или** 2%. Порог учитывает доступные текущему пользователю байты. Даже если PGDATA и WAL лежат на одном томе, оба результата показаны отдельно. Вывод `df` принимает только две строки целых неотрицательных чисел; имена устройств и пути наружу не передаются. Нужны GNU `df`, `timeout`, `awk` и Unix-пользователь postgres, как в закреплённом PostgreSQL 18 Bookworm image.

Работающий PDF (`running: true`) при `waiting: 0` — healthy. Непустая очередь — warning; она сама по себе не означает ошибку печати. Недоступный endpoint, неожиданный HTTP status или невалидный JSON — critical. Новое задание PDF и Chromium эта проверка не создаёт.

## Счётчики журналов

Сохраняются только численные счётчики:

- `persistenceFailureRecords`: точные сообщения `[onStoreDocument] Board persistence failed` и `[onLoadDocument] Board persistence failed` установленного Hocuspocus. Это число известных log records, а не точное число уникальных неуспешных SQL-транзакций; фоновые retry не обязаны создавать новую запись.
- `acl.timeout` и `acl.dependencyError`: известное JSON-событие `collaboration_access_check_failed`; наличие таких records даёт critical.
- `acl.denied` и `acl.editorLimit`: информационные счётчики. Нормальный отзыв доступа или достижение лимита не поднимает status сам по себе.

Persistence records дают critical, даже если последующий retry уже восстановился: окно сообщает о недавнем отказе. Неизвестные сообщения/stack lines игнорируются без копирования. Неизвестный kind у известного ACL event считается невалидным наблюдением и даёт critical. При достижении tail limit появляется `COLLABORATION_LOG_WINDOW_TRUNCATED`: отсутствие ошибки в хвосте не доказывает её отсутствие во всём окне. Эти счётчики не заменяют расследование и не охватывают все возможные сообщения сторонних библиотек.

Docker stdout и stderr разбираются раздельно в памяти, поскольку runtime пишет известные события в оба потока. В итог идут только разрешённые счётчики, а не исходные строки, stack traces или stderr Docker CLI.

## Ограничения выполнения

Общий deadline — 45 секунд, одна Docker-команда — 10 секунд. Совокупный вывод обычной команды ограничен 64 КиБ; для logs — 256 КиБ и tail 500. HTTP body worker ограничен 4 КиБ. Проверки после получения inventory выполняются независимо: сбой одной не пропускает остальные.

Удалённый app status имеет собственный 8-секундный таймер завершения Node; worker fetch — AbortSignal 5 секунд и внутренний таймер 7 секунд. GNU timeout для `df` — 6 секунд с принудительным завершением через секунду. Это нужно потому, что остановка локального Docker CLI сама по себе не гарантирует остановку процесса `docker exec`. После прерывания уже запущенная удалённая read-only проверка может жить до своего внутреннего предела.

Env-файл ограничен 64 КиБ, Compose-файл — 256 КиБ. CLI не сохраняет отчёт на диск: перенаправление одного JSON или хранение журнала выбирает оператор. Приватный env-файл должен быть доступен только оператору; на Windows это определяется ACL родительского каталога.

## Пример systemd timer для будущего Linux-сервера

Это пример конфигурации, а не установленный scheduler. В рамках локальной проверки таймер не создаётся и не запускается. Пользователь `rimo-monitor`, пути Node/репозитория и доступ к Docker должны быть настроены оператором на целевом сервере.

`rimo-monitor.service`:

```ini
[Unit]
Description=Read-only Rimo Compose status
After=docker.service

[Service]
Type=oneshot
User=rimo-monitor
WorkingDirectory=/srv/rimo
ExecStart=/usr/bin/node /srv/rimo/scripts/monitor-service.mjs --project rimo --env-file /srv/rimo/.env --compose-file /srv/rimo/docker-compose.yml
TimeoutStartSec=60
SuccessExitStatus=1
UMask=0077
StandardOutput=journal
StandardError=null
```

`rimo-monitor.timer`:

```ini
[Unit]
Description=Observe Rimo every two minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=10s
Unit=rimo-monitor.service

[Install]
WantedBy=timers.target
```

Exit 1 считается успешным завершением systemd unit, но warning остаётся в JSON. Exit 2 означает failed unit. Следующий запуск не создаёт отдельный демон; одновременно работающий oneshot не запускается таймером повторно. Двухминутный интервал намеренно меньше пяти минут logs lookback: окна пересекаются, их счётчики нельзя суммировать как накопительные totals. При длительном пропуске scheduler этот простой monitor не восстанавливает пропущенную историю.

Оператор подключает подходящий канал уведомлений отдельно и проверяет его доставку на реальном сервере. Без такого канала timer только сохраняет результаты в journal. В JSON monitor нет настроек почты, webhook secrets или содержимого приложения.

## Проверки перед включением

```sh
npx vitest run __tests__/monitor-service.test.ts --maxWorkers 1
```

Unit suite проверяет redaction, изоляцию project/service, недоступные checks, warning/exit consistency, PGDATA/WAL отдельно, busy PDF, ACL/persistence counters, output/deadline bounds. Изолированная Compose-приёмка 27 октября прошла девять наблюдений: healthy, остановку и восстановление PDF/БД, предупреждение по квоте владельцев и помеченные synthetic ACL events. Она выполнена вместе с зашифрованным восстановлением за 94,5 с; отчёт `temp/operations-acceptance/5fd53f68-dedb-4ab9-a13c-6bf8f5795465.json`. Эти локальные проверки не доказывают установленное расписание или доставку уведомлений на будущем VPS.
