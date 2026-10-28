# Проверки отказов ресурсов

`__tests__/resource-compose.integration.test.ts` проверяет настоящий Linux
`ENOSPC` при загрузке изображения. По умолчанию тест пропускается. Для запуска
нужны Docker Compose и заранее собранный `rimo:local`; PostgreSQL 18 берётся по
digest из `docker-compose.yml`. Образы автоматически не загружаются и не собираются.

```powershell
$env:RIMO_TEST_DOCKER_RESOURCES = '1'
node node_modules/vitest/vitest.mjs run __tests__/resource-compose.integration.test.ts
Remove-Item Env:RIMO_TEST_DOCKER_RESOURCES
```

Тест создаёт случайный проект `rimo-resource-<16 hex>`. Его Compose-файл и
случайные секреты хранятся только в `temp/resource-compose-*`. Существующие
Compose-проекты и локальный PostgreSQL не используются. У двух контейнеров нет
проброшенных портов или host bind mounts; единственная сеть имеет `internal: true`.
Перед отказом и после восстановления тест проверяет метки проекта, типы
монтирования, отсутствие host ports и закрытость сети.

| Контейнер | Файловая граница | Ограничения |
| --- | --- | --- |
| `app` | `/app/data/assets` — tmpfs 1 МиБ; `/tmp` — tmpfs 16 МиБ | 512 МиБ RAM, 0,5 CPU, 128 процессов |
| `db` | `/var/lib/postgresql` — собственный tmpfs 256 МиБ | 256 МиБ RAM, 0,5 CPU, 128 процессов |

Внутри `app` сценарий запускает миграции из source, создаёт одного владельца и
доску, получает настоящую HTTP cookie. Корректное PNG нормализуется штатным
`normalizeImage`. Заполняется только отдельный `.resource-filler` в assets tmpfs;
тип и размер файловой системы проверяются до заполнения.

Критерии проверки:

- Запись filler достигает настоящего `ENOSPC`, свободных блоков остаётся ноль.
- `uploadAsset` отклоняет корректное изображение с `HttpError(507, STORAGE_FULL)`;
  HTTP POST возвращает 507 с тем же понятным сообщением, без системного пути,
  кода ОС или `asset`; таблица `assets` остаётся пустой.
- Для каждого оставшегося неподтверждённого файла HTTP GET возвращает 404.
  Отчёт содержит число и размеры таких файлов, без ID, cookie или секретов.
  Пустой/частичный orphan не считается успешной загрузкой; его штатная уборка
  после защитного интервала проверяется отдельными тестами операций.
- `/api/health` отвечает 200 при заполненном assets tmpfs: проверяется работа
  HTTP и БД. Готовность приёма вложений эта проверка не обещает; состояние диска
  отдельно показывает операторский status.
- После удаления только filler реальный HTTP POST первым записывает файл и
  создаёт одну строку, возвращая 201. Повторный source `uploadAsset` подтверждает
  dedup той же записи.
- Файл декодируется Sharp до пикселей; нормализованные байты, размер, SHA-256,
  метаданные БД, `downloadAsset` и настоящая HTTP-выдача совпадают.

Каждый Docker-процесс имеет deadline и ограничение вывода, исполняется через
`spawn` с `shell: false`, `windowsHide: true`. Двоичные потоки обрабатываются
Node Buffer без PowerShell redirection. Внутренний fixture завершается не позднее
45 секунд; весь тест ограничен тремя минутами. `finally` выполняет `down --volumes`
только для проверенного случайного имени. Перед рекурсивной очисткой temp
проверяется абсолютный родительский каталог. Если Docker cleanup завершился
ошибкой, узкий каталог с Compose остаётся для повторной уборки этим же проектом.

## PostgreSQL и persisted ACK

`__tests__/postgres-resource-compose.integration.test.ts` проверяет настоящий
`SQLSTATE 53100` при записи снимка через `createPostgresRepository` и
`createCollaborationServer`, настоящие Hocuspocus Provider и WebSocket.
Opt-in отдельный от assets-сценария:

```powershell
$env:RIMO_TEST_DOCKER_POSTGRES_RESOURCES = '1'
node node_modules/vitest/vitest.mjs run __tests__/postgres-resource-compose.integration.test.ts
Remove-Item Env:RIMO_TEST_DOCKER_POSTGRES_RESOURCES
```

Случайный проект `rimo-pg-resource-<16 hex>` содержит только `db` и `harness`.
PGDATA находится в tmpfs 128 МиБ; PostgreSQL ограничен 384 МиБ RAM, 0,5 CPU,
128 процессами. Harness ограничен 512 МиБ RAM, 0,5 CPU, 128 процессами, его
`/tmp` — tmpfs 16 МиБ. Сеть закрытая, host ports и bind mounts запрещены.
Compose-файл без секретов находится в `temp/pg-resource/run-*`; случайный пароль
передаётся только через окружение дочернего Docker-процесса.

Production image не содержит dev-зависимость `ws`. Тест копирует установленный
пакет из host `node_modules` через двоичный stdin в `/tmp/pg-resource-ws` своего
harness. Установки, внешняя сеть, изменение image или production runtime для
этого не нужны. Repository не подменяется; тестовый authenticate выдаёт владельца
только одной тестовой доски. Настоящие cookie/ACL проверяются отдельными тестами.

Последовательность проверки:

1. Миграции и первая правка проходят через настоящий PostgreSQL; клиент получает
   persisted ACK, совпадающий с его Yjs snapshot.
2. SQL `COPY` пишет только `/var/lib/postgresql/.resource-filler`, вне каталога
   `18/docker`. Получены настоящий `53100` и ноль свободных блоков tmpfs.
3. Клиент добавляет 1000 допустимых объектов в одной транзакции. Запись снимка
   падает с `53100`; лог PostgreSQL подтверждает отказ расширения relation
   запросом `INSERT INTO board_documents`. Лог точки отказа не содержит PANIC.
4. Приходит `persistence-error`, нового persisted ACK нет. Общий с клиентским
   runtime предикат `matchesPersistedSnapshot` возвращает Saved=false; прежняя
   revision и байты PostgreSQL не изменились.
5. Удаляется только filler. Штатный retry получает новый ACK; проверяются все
   прежние подтверждённые и новые правки в байтах из БД.
6. Создаются новый collaboration server и новый WS-клиент. Проверяются все
   1001 объект и их координаты, Saved=true и сохранённая revision.

Fixture ограничен 90 секундами, Docker exec — 100 секундами, тест — тремя
минутами. Логи PG используются только для проверок и не выводятся. При сбое
печатаются только разрешённые phase/error-kind/code, без SQL, env или путей.
`finally` удаляет только проверенный собственный проект и его run-каталог.

## Измеренные прогоны

27 октября 2026 года, Docker Desktop, Compose 2.34.0, образ `rimo:local`:
`sha256:c49c1ecf7c36bd6cc8625a830d6cef56725e20926cc423ecd8000ac3eeaf0e23`.
Это image/manifest ID, возвращённый локальным `docker image inspect`; config ID
сборки — `sha256:1fb9863922c8c2d33558ec37baebf427204325b4ee60e2d3bdaf5f3f27ae8012`.
Время включает создание и удаление тестовых контейнеров.

| Сценарий | Время | Результат |
| --- | --- | --- |
| Assets ENOSPC | 12,88 с | filler 1 048 576 байт; source и HTTP `507 STORAGE_FULL`; rows=0, orphanFiles=0; первый HTTP retry=201, одна строка; WebP 64 × 48, 1 068 байт, decode/download/hash совпали |
| PostgreSQL + WS | 17,16 с | filler и запись `53100`; relation extension; baseline revision=2 неизменна, нового ACK нет, Saved=false; после удаления filler revision=3, 185 082 байта; новый server/WS загрузили все 1001 объект, Saved=true |

SHA-256 восстановленного изображения:
`2c1cda90e7aaad7c5cb62918c32c8f0b2d86d3791a512879926dc93920c4af84`.
Каждый тест выводит отдельный JSON-отчёт только с разрешёнными полями.
Оба проекта и временные каталоги удалены в `finally`. Основной стек `rimo-rework`
этими сценариями не запускался и не перезапускался.

Первый PG запуск остановился до подключения к БД из-за отсутствия `ws` в
production image. После добавления только тестового WS-пакета в собственный
tmpfs полный сценарий прошёл с теми же ожиданиями записи, ACK и восстановления.

## Границы доказательства

Тест не заполняет host disk и не моделирует потерю питания или отказ блочного
устройства. Успешный retry доказывает восстановление записи и чтения вложений
после освобождения места в файловом хранилище.

PG сценарий доказывает обработку настоящего отказа записи/расширения relation.
Точная фаза отказа `COMMIT`, заполнение нового WAL-сегмента и авария postmaster
этим тестом не проверяются. Полная потеря питания, VPS и внешнее восстановление
резервной копии имеют отдельные критерии проверки.
