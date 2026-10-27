# Проверка редактора при задержке сети

Стенд проверяет R08: 3000 объектов, 500 в viewport, два настоящих браузера, целевая доставка конечного изменения p95 до 300 мс и первый пригодный экран до пяти секунд при RTT около 100 мс и канале с потолком 50 Мбит/с. Это отдельная проверка от часового профиля 50 соединений/10 редакторов и от замера локального SVG-переноса 500 объектов.

## Что проверено

27 октября 2026, начало `01:09:40 UTC`: временная версия стенда завершила сценарий через Caddy свежего Rimo. Исторический результат относится к исходникам в `temp/network-acceptance/` и снимку Git `92bdbe3f345a7942b8402d4bb37ec550bcef8bac` с незакоммиченными изменениями. Перенос в `scripts/performance/network/` изменил imports, пути артефактов и fingerprint Docker-контекста. Новые пути калибратора, самотеста и прерываний проверены на инертном echo; новый сценарий Rimo ожидает отдельного общего окна. Прежняя приёмка Rimo не объявляется исполнением перенесённого кода.

| Измерение | Результат |
|---|---:|
| Первый пригодный экран владельца / гостя editor | 1947,8 / 1820,8 мс |
| Все 50 видимых изображений декодированы | 1951,9 / 1824,2 мс от начала открытия |
| RTT штатного WebSocket, 20 запросов | p50 116,2; p95 119,3; max 122,3 мс |
| Конечное изменение до DOM соседа, 20 переносов в обе стороны | p50 159,0; p95 172,1; max 177,4 мс |
| Десять полных повторных открытий | 1690,3–1756,3 мс |
| JS heap после явного GC, median первых / последних трёх | 18 489 312 / 18 470 112 байт |
| DOM nodes после GC | 2851–2852 |
| Ошибки страниц / шрифтов | 0 / 0 |

Все 3000 исходных координат восстановились после undo и совпали с подтверждённым сохранённым документом. Два helper, браузеры, тестовая доска и API-контексты очищены; все девять шагов cleanup завершились успешно. Ручная проверка десяти наблюдений не обнаружила устойчивого роста времени или JS heap: наклоны ряда составили около −0,96 мс и −45 904 байт на повторное открытие. Первая heap-точка была выше последующих; остальные лежали в диапазоне 18 467 960–18 508 300 байт. Этот ряд не доказывает отсутствие любой утечки и не измеряет полный RSS Chromium.

### Зафиксированное окружение

- Windows 10.0.19045 x64; AMD Ryzen 5 7600X, 12 logical CPUs, RAM 33 444 225 024 байт.
- Docker Desktop: Linux kernel `6.18.33.2-microsoft-standard-WSL2`, 12 CPUs и 25 200 041 984 байт RAM в VM; CPU квоты сервисам не задавались. Это не кандидат VPS 2 vCPU/4 ГБ.
- Host Node `22.15.0`; app/collaboration Node `22.23.4`; PDF worker Node `24.22.1`; PostgreSQL `18.6`.
- Два отдельных Chromium `156.0.8078.4`, headless, viewport 1440×1000, deviceScaleFactor 1, ru-RU. Playwright `1.64.1`, Next `15.5.28`, Hocuspocus `4.7.1`, Yjs `13.6.33`.
- App/collaboration image `sha256:c49c1ecf7c36bd6cc8625a830d6cef56725e20926cc423ecd8000ac3eeaf0e23`.
- Helper image `sha256:3767ae903e885f3d9925e196993c09be253269a730e5167ac389b30f22877c05`: Toxiproxy `2.12.0`, Tinyproxy `1.11.1`, iproute2 `6.1.0`.

Исторические сырые артефакты остаются в игнорируемом `temp/network-acceptance/service-result.json` и `calibration.json`; приватный guest state не является отчётом. Исходный `networkSourceSha256` — `f8e0e0f3c8a05787249945b4aa4211dc6d3e31db7526c6bf2ab8cd8073ce8472`, configuration fingerprint helper — `5bc886ab9079173cbad5deed44c180f6f3ef657ec2f95dd02bde94f536656513`. При переносе старые исходники и отчёты сохранены без изменений.

После исправления lifecycle перенесённый source имеет SHA-256 `3ac3086d28ec7b223500285b97156fa38ac798650db8cd55d62e69e238a2e07a`: он включает все `.mjs`, `Dockerfile`, `tinyproxy.conf` и `.dockerignore`, всего 12 файлов. Этот fingerprint прошёл шесть проверок прерывания, полный инертный самотест и калибровку. Новая калибровка: HTTP median 113,6 мс, WebSocket 109,1 мс; payload 42,7 Мбит/с один download, 43,9 Мбит/с шесть download и 44,1 Мбит/с шесть upload. Она не является новым запуском Rimo. Скрипты вычисляют текущий SHA-256 при запуске и требуют успешной калибровки соответствующего image/configuration fingerprint.

## Как устроена сеть

Каждый Chromium получает свой контейнер и отдельный общий предел скорости:

```text
Chromium HTTP / CONNECT для WebSocket
  -> loopback port -> Toxiproxy:50 ms upstream + 50 ms downstream
  -> Tinyproxy -> loopback-forward Toxiproxy -> host.docker.internal:3080 -> Caddy
```

Браузер продолжает обращаться к `http://localhost:3080`; origin, cookies и адрес WebSocket сервиса не переписываются. Правило Chromium `<-loopback>` отключает неявный обход localhost. Tinyproxy нужен для штатного HTTP CONNECT, которым Chromium проксирует WebSocket. Один TCP proxy перед Caddy такой CONNECT не обслуживает.

HTB внутри контейнера ограничивает суммарный поток всех TCP-соединений браузера двумя классами: до 50 Мбит/с в каждом направлении. Bandwidth toxic Toxiproxy для этого не подходит, поскольку ограничивает каждое соединение отдельно. Калибровка исторического профиля Rimo дала HTTP median 113,4 мс и настоящий WebSocket echo RTT 108,4 мс против baseline 4,8 и 0,9 мс. Полезная скорость: 43,3 Мбит/с для одного download, суммарно 44,6 Мбит/с для шести download и 44,2 Мбит/с для шести upload. Это измеренная полезная скорость ниже настроенного потолка 50, а не обещание ровно 50 Мбит/с на уровне приложения.

Helper получает только `NET_ADMIN` в своём network namespace, без host networking, bind mounts, Docker socket и секретов приложения. Память — 192 МиБ, pids — 128, остальные capabilities сняты, `no-new-privileges` включён. Публикуются только случайные порты на `127.0.0.1`. Собственный echo калибратора также слушает только loopback; эта топология проверена на Docker Desktop Windows. Для другого Docker-хоста доступ к host loopback необходимо отдельно подтвердить калибровкой.

Docker build context — только каталог `scripts/performance/network/`. Его `.dockerignore` исключает всё и разрешает ровно `Dockerfile`, `boot.mjs` и `tinyproxy.conf`. Dockerfile копирует из контекста только последние два файла; бинарный Toxiproxy берёт из закреплённого официального образа. Измеритель, состояния входа и отчёты в helper не попадают.

## Воспроизведение

Нужны зависимости проекта, собранный локальный Compose на `http://localhost:3080`, отдельный тестовый владелец и его приватный Playwright storage state. Создание владельца описано в [README](../README.md). Все команды выполняются из корня репозитория. В Windows runner должен иметь доступ к Docker engine и остановке собственных браузеров.

Состояние входа можно получить интерактивно: открыть codegen, войти тестовым владельцем и закрыть браузер. Пароль не передаётся аргументом команды:

```powershell
New-Item -ItemType Directory -Force temp/performance | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\temp\playwright-browsers"
npx playwright codegen --save-storage temp/performance/network-owner-storage.json http://localhost:3080
```

Затем собрать только helper и откалибровать его:

```powershell
docker build -t rimo-network-probe:local -f scripts/performance/network/Dockerfile scripts/performance/network
node scripts/performance/network/interrupt-test.mjs
node scripts/performance/network/calibrate.mjs
node --import=tsx scripts/performance/network/probe-self-test.mjs
```

Калибровка не обращается к Rimo. Она проверяет реальный browser HTTP, WebSocket и общий предел при одном/шести параллельных потоках. Самотест использует инертную SVG-сцену с 500 слоями, чужим курсором, draft и непустым временным transform. Прежний неверный count равен 502; измеритель должен принять ровно 500 слоёв. Также проверяются исчезнувший helper, повторный close и продолжение cleanup после ошибки.

После успешной калибровки и при свободном от сборок/других нагрузок CPU:

```powershell
node --import=tsx scripts/performance/network/measure-network.mjs --allow-service-test --storage-state temp/performance/network-owner-storage.json --label ACTUAL_IMAGE_AND_HOST
```

`--allow-service-test` обязателен; runner принимает только локальный origin `http://localhost:3080`. `--compose-project` по умолчанию равен `rimo-rework`; для другого локального имени проекта его нужно передать явно. `--output` меняет путь результата. Runner не создаёт владельцев и работает только со своей новой доской. Guest editor — одна переиспользуемая anonymous session: после удаления доски её аккаунт остаётся для следующего замера, поскольку публичное удаление гостей отключено.

Артефакты перенесённого стенда:

| Путь | Назначение |
|---|---|
| `temp/performance/network-calibration.json` | Полный результат калибровки |
| `temp/performance/network-service.json` | Основной отчёт по умолчанию |
| `temp/performance/network-self-test.json` | Отчёт инертного самотеста |
| `temp/performance/network-interruptions.json` | Результаты шести проверок прерывания |
| `temp/performance/network-owner-storage.json` | Приватное состояние владельца, если использован пример выше |
| `temp/performance/network-guest-storage.json` | Приватное переиспользуемое состояние гостя |
| `temp/performance/network-cid-<runId>` | Временный ID собственного Docker-контейнера |

Состояния входа, cidfile и результаты остаются вне Git и вне Docker-контекста. Старые временные отчёты не перемещаются в новую папку как результаты нового кода.

## Что означает отчёт

Первый пригодный экран: начало навигации → Saved, доступный select tool, 500 постоянных viewport-слоёв, `document.fonts.ready`, два rAF. Presence и временный transform не считаются слоями. Проверяются ошибки font face; полный статус шрифтов сохраняется. Декодирование всех 50 видимых изображений измеряется отдельно. Сцена содержит 300 слоёв изображения, но только один уникальный небольшой WebP: это нагрузка рендеринга, а не 300 уникальных сетевых файлов.

Доставка конечного изменения измеряется от capture pointerup одного браузера до изменения постоянного style прямоугольника у соседа. Временный drag preview не завершает этот таймер. Часы обоих процессов принадлежат одному хосту; это DOM proxy, не момент показа пикселей compositor. RTT — запрос `persistence-status` и cached `persisted` на существующем авторизованном WS во время покоя, без ожидания новой записи в БД. Seed provider отключён до измерения; финальный штатный WS проверяет все 3000 координат и подтверждение сохранения после серии undo.

Десять reload выполняются с отключённым HTTP cache; browser/server процессы и серверный cache остаются прежними. CDP heap/DOM записываются до и после явного GC после загрузки шрифтов/изображений и 500 мс покоя. Это JS heap конкретного target, не полный RSS браузера. `manualReviewRequired` оставляет оценку устойчивого роста времени/памяти на просмотр полного ряда, median и наклона, без придуманного универсального порога.

`status: complete` означает завершённый сценарий. Для приёмки нужны успешные автоматические criteria, отсутствие ошибок/незавершённого cleanup и отдельная ручная оценка памяти. Отчёт содержит реальную версию Chromium, hash всех network scripts, commit/dirty, образы и лимиты сервисов. Перед работой проверяется совпадение image ID и configuration fingerprint helper с полной успешной калибровкой. Числа этого компьютера не заменяют замер VPS и не доказывают часовой профиль 50/10.

## Очистка после прерывания

Общий lifecycle обрабатывает SIGINT/SIGTERM и deadline до конца независимой очистки и записи отчёта. Встроенные signal handlers Playwright отключены: иначе SIGINT мог вызвать `process.exit(130)` раньше удаления detached helper. При прерывании итог — `status: interrupted`, причина и ненулевой код 130/143/124; даже сигнал во время итоговой записи не оставляет ложный `complete`. Deadline: калибровка 180 секунд, инертный самотест 60 секунд, Rimo 10 минут. `RIMO_NETWORK_DEADLINE_MS` позволяет только сократить соответствующий предел.

Проверки прерывания используют живые Chromium/helper/echo и подтверждают завершение cleanup и отсутствие контейнеров за ограниченное время. На POSIX runner посылает настоящие сигналы. У Windows нет catchable внешнего SIGTERM: там IPC preload явно вызывает зарегистрированный Node handler; реальный watchdog проверяется таймером в обоих процессах. Это не доказательство перехвата Windows `TerminateProcess` или `taskkill /F`. Проверки прерывания оставляют калибровочный отчёт `interrupted`, поэтому после них необходимы обычные успешные калибровка и самотест, как в порядке команд выше.

Перед `docker run` уникальный UUID label записывается в отчёт. `--cidfile` и точный label позволяют восстановить ID после неопределённого ответа CLI. Cleanup сверяет label и известный ID; уже отсутствующий helper считается очищенным. Ошибка одного шага не пропускает остальные ресурсы и запись итогового отчёта. После SIGKILL runner оператор сверяет `helperAttempts`, `helpers` и `createdBoards` с реальным состоянием и удаляет только ресурсы соответствующего запуска. Рабочие контейнеры Rimo этим скриптом не останавливаются.

## Первичные источники

- [Toxiproxy](https://github.com/Shopify/toxiproxy): directional latency и TCP proxy.
- [Bandwidth toxic 2.12](https://github.com/Shopify/toxiproxy/blob/v2.12.0/toxics/bandwidth.go): предел одного соединения.
- [Chromium proxy](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/docs/proxy.md): CONNECT/WebSocket и `<-loopback>`.
- [Tinyproxy configuration](https://github.com/tinyproxy/tinyproxy/blob/1.11.2/docs/man5/tinyproxy.conf.txt.in): listener, ACL и CONNECT ports.
- [iproute2 HTB](https://man7.org/linux/man-pages/man8/tc-htb.8.html): общие классы outbound rate/ceil.
