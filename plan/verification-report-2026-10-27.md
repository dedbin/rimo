# Проверки переработки Rimo

Промежуточный протокол 27 октября. Ветка `codex/service-rework`.
Проверки повторяются после изменений поведения. Часовой профиль пока не прошёл:
предыдущие попытки остановились с ошибками; результаты образов указаны отдельно.

## Зафиксированный стенд

- Windows x64, AMD Ryzen 5 7600X, 12 логических CPU, 32 ГБ RAM.
- Docker Desktop Linux VM около 24 ГБ RAM, Compose 2.34.0.
- Исторический app/collaboration image для приведённых ниже R08/network измерений:
  `sha256:c49c1ecf7c36bd6cc8625a830d6cef56725e20926cc423ecd8000ac3eeaf0e23`.
- Исторический образ после native ESM и восстановления при квоте (source `d383dde`):
  `sha256:31726ed066c5096175b8313daa78d3fb18d4b8f693ff130a6614d237a0a295c1`.
- Образ после ACL и SVG/rich-text/avatar исправлений (source `8ef7b3b`):
  `sha256:221b1d0d4ea7f6539b173147714e65d87536a57e4b91241824a70aa213e16f0b`.
- Диагностический образ с runtime GC/heap/event-loop счётчиками (source `0e9a474`):
  `sha256:b71bc2cf585c022ab0e0dbcb38f6ec26c68b0a44494652db63ba26ef1479eb7b`.
- Предыдущий кандидат с yield очереди и проверкой закрытых соединений (source `b17c6c0`):
  `sha256:2f10ad2a9ba420c16c21e304634b5e968f7c7d29133face0b864678cab6f48c4`.
- Предыдущий кандидат с pre-auth ingress и offline handshake (source `a933227`):
  `sha256:f0c30b895fc449fbe362ac6daaa91daa0cd74a7e04ac1a45892e1370b0a87faa`.
- Текущий кандидат с queue64 и deferred presence (source `662234d`):
  `sha256:535ac030bbdcde0b861a9295755d4cca7a5c0d029bc37234a70ef8d052887b50`.
  Worker: `sha256:c51b10d47452c1e9375df2d81526a97f6658ab8733d813ff1735495618e0a393`;
  предыдущие PDF/аватарные измерения использовали worker672111ed0fed.
- Промежуточный образ живых ролей и прежних сетевых/TLS проверок:
  `sha256:48116dd68d90d8b09293440075e97dea48f6f0f120d4dc5fc6239e0a586d9ce2`.
- Node: host 22.15.0, app/collaboration 22.23.4, PDF worker 24.22.1.
  PostgreSQL 18.6 в Docker и18.1 для локального PG-suite, Chromium156.0.8078.4, Next15.5.28,
  Hocuspocus 4.7.1, Yjs 13.6.33.
- Исторические профили не ограничивали сервис двумя CPU. Новый час с20:18UTC
  применяет CPUset0,1 к пяти сервисам; результат ещё ожидается. Сумма steady caps
  3,375ГиБ не является лимитом ОС4ГиБ. Размер и стоимость VPS не проверены.

## Выполненные проверки

| Сценарий | Наблюдаемый результат |
| --- | --- |
| Полный набор с PostgreSQL | На исходниках `662234d`: 784 passed, 17 opt-in skipped; 107 test files (101 passed / 6 skipped), 67,89 с; lint и TypeScript прошли. Лог: `temp/queue64-full-pg-suite.log`, SHA256457bb5e3ba5cf807dc7ba08ac5fe527884e8d29317961567c32e59bdcba46b2a |
| Последний полностью успешный GitHub Actions | На `f7c6305` [verify успешно](https://github.com/dedbin/rimo/actions/runs/40581522989): официальный Playwright container, Node22/Python3.12, npm ci, PostgreSQL/migrate, lint/type/784tests, PDF с двумя extractor, build, UI E2E, standalone и audit. Предыдущий CI662234d был отменён на установке Chromium и не считается полностью успешным |
| UI через Caddy на текущем535ac | 5/5 E2E за1,1мин: clipboard, collaboration/Undo/revoke, PDF/archive, rich text/math/Markdown/reload, живые роли. Лог: `temp/acceptance-queue64-docker.log` |
| UI через Caddy на текущем f0c | 5/5 E2E за 58,8 с: clipboard, два редактора/своя отмена/отзыв, фреймы/PDF/архив, текст/формулы/Markdown/reload, живые роли. Лог: `temp/acceptance-ingress-a933-docker.log` |
| Production UI на Windows | Свежий production build на `0e9a474`, 5/5 E2E за 1,0 мин, включая живую смену ролей и штатную остановку трёх дочерних серверов; порты освобождены |
| UI через Caddy на образе 221b | 5/5 E2E за 1,1 мин: collaboration, rich text, clipboard, PDF/archive и live roles; функциональный прогон шёл параллельно отдельному TLS-стенду и unit suite |
| Переносимый архив | На14967a7 [CI](https://github.com/dedbin/rimo/actions/runs/40568460151) проверил итоговый .rimo → новая пустая БД → PDF после удаления source schema/files: rich text, LaTeX, точные WebP, новые IDs/revision; pypdf+pdfminer подтвердили две страницы и обратный frame order. Отдельный тест7,869с; весь PDF-набор14/14 за9,83с |
| Полная зашифрованная копия сервиса | Restic 0.19.1, check-data, restore-verify, manifest/hash, PostgreSQL, files, прежний вход и HTTP на чистом Compose: 94,5 с вместе с monitor faults; внешний offsite ещё не настроен |
| Монитор эксплуатации | Девять наблюдений на изолированных Compose: healthy, реальные остановки/восстановления PDF и БД, квота владельцев, synthetic denied/timeout; cleanup без оставшихся контейнеров/томов/сетей/locks |
| Проверка ACL под нагрузкой | Сессия и роль читаются одним SQL без кеширования прав; отдельные PG parity и expiry-boundary проверки прошли, опрос распределён по возрасту на монотонных часах, deadline не увеличен |
| Аватары | Linux Chromium на 221b: self и три настоящих peer-сценария, SVG/UUIDasset decode, API400/unchanged, foreign/page/route errors=0, все14 критериев и cleanup29/29; peer использует реальные ACL/WS без подстановок |
| Повторные PDF и процессы | 100 публичных экспортов без restart: p95 HTTP414,5 мс, max441,2 мс; PID47→47, peak126 при прежнем256, zombie0/events0; первые/последние20страниц независимо проверены, cleanup4/4 |
| Assets ENOSPC | 12,88 с; настоящий полный tmpfs, HTTP 507, rows/orphans=0; после освобождения места HTTP 201, decode/hash/выдача совпали |
| PostgreSQL ENOSPC | 17,16 с; настоящий SQLSTATE 53100 при расширении relation; новый ACK отсутствует, прежние bytes/revision сохранены; retry и новый WS восстановили все 1001 объект |
| PDF | Linux sandbox=true, лимит 768 МиБ, 20 страниц: print 384 мс, inspect+print 829 мс; оба независимых extractor проверили русский текст, гарнитуры, code и порядок; PNG просмотрен |
| Standalone | На свежем `0e9a474` BUILD_ID `13sjW9ZaLfdcFQXNTLftN`, три runtime WebSocket URL без пересборки, CSS/woff2 совпадают через HTTP; dotenv в артефакте отсутствует |
| Границы комнат | Реальные WS/PG регрессии для uppercase UUID, параллельного auth при лимите комнат, ошибок load, TTL и stop |
| Живые права | editor→viewer отменяет активный текст и начатый drag; viewer→editor снова разрешает изменение без reload; readonly и auth-failure остаются серверными ограничениями |
| HTTPS/WSS на текущем 221b | 51,168 с, compiled ESM entry, Node CA/SNI HTTP1/H2, два Linux Chromium contexts, Secure/HttpOnly/Lax cookies, HTTP308 без secure cookie, WSS/Saved/reload, private image и PDF preview; 78WSSframes, errors0, свой проект/тома удалены |
| Native ESM collaboration | Docker PID 1 запускает compiled ESM на Node 22.23.4; реальные WS/PG проверили ACK, строгий XML, отзыв доступа и SIGTERM drain/restart; source map указывает исходную TypeScript строку |
| Отказ по квоте документа | Настоящий Chromium на образе 31726: baseline 5 242 860 байт, обычная вставка отвергнута; черновик/pending/error остались, за 6,508 с новых отправок и reconnect нет; новая вкладка Saved, UI-архив содержит точный исходный revision 2 и Yjs hash, unauth 401; cleanup 5/5 |

Команды и границы отказов: [failure-testing.md](../docs/failure-testing.md).
Браузерные сценарии: [e2e/README.md](../e2e/README.md).

## Сеть и длинная доска

Два отдельных Chromium, отдельный сетевой helper на каждого, настоящий
WebSocket через CONNECT. Калибровка: HTTP 113,4 мс, WS 108,4 мс;
направления ограничены общими HTB-классами 50 Мбит/с. Полезная скорость
составила 43,3 Мбит/с для одного download, 44,6 для шести и 44,2 для uploads.

На сцене 3000 объектов / 500 видимых / 50 декодированных изображений:

- Первый пригодный экран: 1947,8 / 1820,8 мс. Все изображения: 1951,9 / 1824,2 мс.
- Реальный round trip приложения: p95 119,3 мс.
- Двадцать конечных двусторонних переносов с undo: p95 доставки в DOM другого
  браузера 172,1 мс, максимум 177,4 мс. Это DOM proxy, не compositor input-to-photon.
- Десять повторных открытий с отключённым HTTP cache: 1690–1756 мс.
- JS heap после GC: примерно 18,47–18,51 МБ, DOM nodes 2851–2852;
  устойчивого роста в десяти наблюдениях не видно. Полный RSS не измерялся.
- Все 3000 координат восстановлены и подтверждены снимком БД, page/font errors=0,
  доска, два browser и два helper очищены.

Исходный отчёт находится в игнорируемом
`temp/network-acceptance/service-result.json`; source SHA-256
`f8e0e0f3c8a05787249945b4aa4211dc6d3e31db7526c6bf2ab8cd8073ce8472`.
Постоянные пути повторно прошли на текущем 48116-образе в `03:05:51 UTC`:
первый экран 1931,2/1798,7 мс, app RTT p95 118,1 мс,
доставка p95 177,0 / max 205,3 мс. Десять повторных открытий 1687,1–1755,8 мс,
heap median первых/последних трёх 18 665 372/18 653 284 байта,
DOM 2851–2852; устойчивого роста не видно. Все критерии и cleanup прошли.
Отчёт `temp/performance/network-service-48116.json`, source SHA-256
`3ac3086d28ec7b223500285b97156fa38ac798650db8cd55d62e69e238a2e07a`.
Методика: [network-testing.md](../docs/network-testing.md).

Верхний профиль на текущем 221b также прошёл: 3000/500/50 при документе
5 177 321 байт (5 МиБ минус 65 559 байт запаса), после движений 5 177 994.
Первый экран 3221,4/2810,2 мс, доставка DOM p95 254,6 / max 273,8 мс,
десять reload 2685–2751 мс. Координаты/Saved/строгая валидация и cleanup 9/9
прошли. Post-GC heap после первой более низкой точки оставался 47,99–48,14 МБ,
DOM 2851–2852; этот короткий ряд не заменяет долгий контроль памяти.
Отчёт `temp/performance/network-upper-candidate221b.json`, новый network SHA-256
`03bffc05ebb6889d1a418f4f355e615d2e94e71ddafb9926ed304ac289b8a454`.

После добавления history fixture и runtime sampler состав network fingerprint
изменился; перед следующим сетевым профилем потребуется новая калибровка.
Исторические raw-отчёты и fingerprint не переписываются.

Отдельная inert duplex-проверка без Rimo сравнила0/50мс задержки в каждом
направлении на том же transport helper. По2880frames/23040deliveries в каждой
фазе, потерь/дубликатов0, cadence100%, cleanup10/10. Update peer p95 вырос
10,342→119,126мс, echo10,261→119,166мс, shaped max160,6мс. Эта проверка
не подтверждает гипотезу, что proxy сам добавляет ещё200мс в mixed10.
Отчёт `temp/performance/duplex-network/6685d85b-5ff1-4630-8ac5-0741902a073c.json`;
скрипт `scripts/performance/duplex-network-probe.mjs`, source `6c5b59c`.

### Десять активных соединений на native ESM

Смешанный профиль: два Chromium и восемь Node writers на одной доске,
десять независимых калиброванных путей, измеренный RTT p95 111–119 мс.
За 120 с все writers выдержали заданную частоту: 1920 Node и 240 браузерных
изменений, 13440 причинно подтверждённых Node-доставок без потерь.
Браузерный DOM p95 250,4/238,2 мс прошёл условие 300 мс, но отдельные
Node пары дали p95 364,6–407,8 мс, общий 394,9 мс. Поэтому status
`not-accepted`: дополнительный Node latency критерий не пройден.
Saved получен после остановки всех writers; все координаты проверены свежим
подключением, runtime errors=0, cleanup 35/35. Generator event-loop max 49,7 мс,
p95 максимум 24,9 мс, buffered=0. Отчёт:
`temp/performance/active-room/native317-initial/report.json`, source SHA-256
`25e1a279f473eb6abbee3b85d3577188a568dbefb864023e3074a6b0f31f3f4d`.
Методика: [active-room-testing.md](../docs/active-room-testing.md).

Повтор на 221b: все 10 подключений выдержали 120 с, 1920 Node + 240 browser
операций и 13440 доставок, missing/pending=0. Браузерные p95 207,0/205,7 мс;
Node общий p95 359,0 мс, максимальная пара 371,9 мс. Поэтому общий статус
снова `not-accepted`: Node-критерий 300 мс остаётся открытым. Все Saved,
свежий durable audit и cleanup 35/35 прошли. Отчёт:
`temp/performance/active-room/candidate221b/report.json`.

### PDF во время урока: первая попытка

На том же native ESM образе выполнены 20 последовательных публичных экспортов
по 20 страниц из одного фиксированного revision. Все PDF независимо проверены
двумя extractor: русский текст, копирование, формулы и порядок страниц.
Полный HTTP download занял 593,9–701,7 мс; 20 конечных движений владельца и
редактора доставлены в DOM с p95 156,3 мс, каждый Saved/Undo и свежий durable
аудит прошли. Ошибок страниц нет, cleanup завершён.

Статус `not-accepted`: интервалы занятости worker не удалось достоверно связать
с pointerup. Часы Docker VM `Date.now()` относительно монотонного таймера
изменились примерно на 5,25 с; общий clock interval несовместим. Поэтому ни одно
движение не зачтено как overlap, даже при успешном экспорте и низкой задержке.
Измеритель переводится на монотонные таймеры, пороги не увеличиваются.
Worker cgroup: 178,2 МБ до / 211,3 МБ после / 211,1 МБ после 5 с покоя;
исторический cgroup peak 356,2 МБ при лимите 805,3 МБ. Один такой прогон ещё
не доказывает отсутствие долговременного роста памяти.
Отчёт: `temp/performance/pdf-lesson/native317-initial/report.json`.
Методика: [pdf-lesson-testing.md](../docs/pdf-lesson-testing.md).

Новая причинная методика v3 на 221b не использует часы worker для overlap.
Все 20 экспортов по 20 проверенных страниц, Saved/Undo и durable audit прошли;
полный p95 доставки 163,7 мс, 19 подтверждённых overlap дали p95 170,9 мс.
Статус `not-accepted`: операция №10 отпущена через 0,114 мс после первого
busy-ответа и не поместилась в консервативную границу +2 мс. Это не основание
засчитать двадцатое пересечение. Протокол ввода исправлен на два последних
последовательных busy-ответа, критерии 20/300 и worker не менялись; повтор нужен.
Worker cgroup до/после/5 с idle: 210,7/226,2/226,1 МБ, peak 360,3 МБ;
очередь не росла, cleanup 11/11. Отчёт:
`temp/performance/pdf-lesson/candidate221b-causal-v3/report.json`.

При следующем повторе после четырёх скачиваний пятый PDF завершился ошибкой;
`temp/performance/pdf-lesson/candidate221b-release2/report.json` сохранён как failed.
Read-only диагностика обнаружила157 zombie Chromium, все PPID1; PID1 был Node,
а cgroup зарегистрировал108 достижений лимита256 (peak262). Включён штатный
Docker init без увеличения лимитов или отключения sandbox. RSS Node теперь
определяется по точной команде отдельно от диагностики PID1.

После исправления 100 последовательных публичных экспортов прошли без restart:
PID47→47, наблюдаемый после ответа максимум55, cgroup peak126, zombie0 и
limit events0. Cgroup memory173,2→214,3 МБ; Node RSS198,0→220,4 МБ.
Это проверка конечной серии, а не доказательство отсутствия любой долгой утечки.
Отчёт `temp/pdf-process-lifecycle/candidate221b-init100/report.json`;
первые/последние PDF независимо проверены, cleanup4/4.

Затем принят полный урок: **20/20 подтверждённых causal overlap**, 20PDF по
20страниц проверены двумя extractor, фиксированный revision, оба редактора,
Saved/Undo/durable audit. Полный и overlap p95 доставки157,6 мс, max161,3 мс;
все критерии и cleanup11/11 прошли. Отчёт:
`temp/performance/pdf-lesson/candidate221b-init-release2/report.json`.

## Массовое перемещение и нагрузка

Три переноса 500 объектов на 120×40: без coordinate writes до pointerup,
одна конечная транзакция / 1000 полей, один undo, Saved и полный аудит 3000
координат. Frame p95: 31,1 / 24,0 / 24,1 мс. Реакция DOM+rAF p95:
29,4 / 25,8 / 24,3 мс. Строгий максимум 50 мс ещё не принят: один first-preview
занял 69,8 мс из 540 наблюдений. Он сохранён в отчёте.

Диагностика исключила скрытую задержку порога 3 px: протокол 2 начинает движение
с 4 px, сохраняет 180 events и общий сдвиг. Исходные raw измерения сохранены.
Дополнительный CPU/timeline прогон дал 35,5 / 38,8 / 34,4 мс, подтвердил remount
50 формул, но KaTeX занимал лишь 1,5–2,2 мс; источник исходного выброса
без trace того события остаётся неустановленным.

После сохранения ключей rich text и общего SVG transform серия 20 переносов
на 221b сохранила все 50 формул и 50 изображений до, во время и после жеста.
В каждом случае 0 записей координат до pointerup, 1 транзакция/1000 полей,
1 Undo для всех 500 объектов; Saved и полный аудит прошли. Frame p95
24,3–30,4 мс во всех 20, но max реакции 66,3 мс при пределе 50 мс остаётся
провалом. Raw `temp/performance/editor-221b-shared-20trials.json` относится
к протоколу измерения 4: отдельные rAF stamps предшествуют DOM mutation,
поэтому они могут занижать задержку. Протокол 5 использует actual callback
time и имеет две red/green регрессии.

Его собственная серия `temp/performance/editor-221b-protocol5-20trials.json`
также завершена: frame p95 30,3–30,4 мс во всех20, reaction p95 21,5–27,5 мс,
startup 8,6–13,1 мс. Все100 content nodes сохраняются, writes/Undo/Saved/audit
прошли. Два max выброса 53,1 и52,6 мс не проходят предел50; в первом случае
47,3 мс уже прошли до capture handler. Конкретная причина этой задержки
не установлена, критерий не ослабляется. Page/close/cleanup errors отсутствуют.

История ранних часовых отказов, native ESM, pre-aged fixtures, GC и
альтернатив кодирования вынесена в [отдельный протокол](performance-investigation-2026-10-27.md).
Все исходные неуспехи и raw-пути сохранены. На317 отказ наступил через
27 мин28с, на221b —45 мин16с с ACL timeout; b17 semi64 —38 мин49с
с receive-limit. Эти попытки не являются принятой нагрузкой.

После паузы выполнения собственный host PostgreSQL оказался остановлен,
а прежний порт 55432 уже обслуживал другой проект. Его данные, настройки и
контейнер не менялись. Свой `temp/postgres` проверен через pg_ctl и запущен
на свободном loopback 55439; SQL подтвердил точный data_directory и rimo_dev.
Игнорируемый локальный env получил явный isolated test DSN. Launcher теперь
требует `RIMO_TEST_DATABASE_URL`, без fallback к рабочему `DATABASE_URL`.
Промежуточные 703 теста выявленный reviewer обход не покрывали. В `a933227`
учёт подключён через публичный `handleConnection` до очереди SDK, включая
задержанные auth/load, повторные подключения, общий предел 32 МиБ и release.
Настоящие WS-регрессии, независимое ревью и полный набор 762/16 прошли.
Квота входящих байтов не является доказанной границей decoded heap.

Клиентский offline helper передаёт накопленный Y.Doc штатным state-vector
handshake, не повторяя ранее поставленные в очередь SyncUpdate. Проверен
реальный reconnect документа почти 5 МиБ; OPEN-трафик не отбрасывается.
Для следующей нагрузки app/collaboration временно перераспределены в 768/1024
МиБ; сумма пяти контейнеров прежняя, 3,375 ГиБ. Node old512/semi64 дал heap
limit704 МиБ. Короткий pre-aged профиль b17: 180,00 с, 3540/31860 операций/
доставок, pending/missing/buffer0, p95482,9 мс, max1140,9 мс, cleanup пуст.
Raw: `temp/performance/load-preaged1447-b17-budget1024-old512-semi64.json`.
Час a933227 завершился receive-limit через3092,146с (51мин32с):60620
операций/545199доставок, cadence1,96045Гц, missing0, pending43/max50;
p95566,23мс/max3365,93мс. Cleanup/closeErrors пустые, OOM/restart0.
Лог guard: queued-messages,32кадра/8302байта, общие52359байт, incoming302.
Финальные RSS665,32МиБ/heap404,79МиБ, GCmax14,83мс, loopmax523,5мс.
Средний sampled pending и CPU росли по квартилям; источник последнего
ожидания (ACL/gate/CPU) raw отдельно не измеряет. Полный час не принят.
Raw: temp/performance/load-hour-a933-budget1024-old512-semi64.json.
Следующий кандидат увеличивает только число кадров до64 при прежних
байтовых/скоростных ограничениях и ACLdeadline3с; это запас очереди,
не доказанное исправление throughput. Требуется новый полный профиль.

Подробная методика: [performance.md](../docs/performance.md).

## Открытые условия

- Локальный HTTPS/WSS с compiled ESM повторно прошёл на221b. Публичный
  TLS/ACME, DNS и настоящий сервер остаются внешними условиями;
  методика и результат: [tls-testing.md](../docs/tls-testing.md).
- Часовой профиль 50/10 и рост состояния/памяти в течение него.
- Максимум реакции50 мс: protocol5 зарегистрировал53,1 и52,6 мс. Бюджет
  frame p95 33 мс прошёл20/20, данные/Undo сохраняются.
- Десять активных клиентов: Node p95 359,0 мс выше300 мс, хотя два настоящих
  браузера и сохранность прошли. PDF overlap после исправления принят20/20.
- Предел записи пилота 5 МиБ уже предложенных в плане 20 МиБ;
  его почти предельный сетевой профиль прошёл, повышение требует новой приёмки.
- Внешнее зашифрованное хранилище и расписание копий: назначения пока нет.
- Реальный VPS, публичный домен и пять занятий владельца ещё не участвовали
  в проверках. Эти условия не заменяются автоматическими сценариями.
- Правовые проекты РФ и вопросы владельцу: [docs/legal](../docs/legal/README.md).
  Реквизиты, размещение, сроки хранения, принятие документов и исполнение
  обращений пока не утверждены; соответствие внешнего пилота не объявляется.
