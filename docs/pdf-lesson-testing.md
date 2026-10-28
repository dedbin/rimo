# PDF параллельно уроку двух браузеров

Локальный профиль runtime221b после включения Docker init принят: 20 экспортов
по20 проверенных страниц и20 причинно подтверждённых пересечений с вводом,
Saved/Undo/durable audit и cleanup прошли. Подробные результаты и прежние
неуспешные попытки: [протокол приёмки](../plan/verification-report-2026-10-27.md).

Это отдельная проверка R09/R10 на подготовленном изолированном Compose. Она не запускается при сборке и не выполняется обычными unit-тестами. Нужен согласованный свободный интервал: без другого PDF, браузерной приёмки, сборки и нагрузки 50/10. Текущий часовой прогон нельзя прерывать ради этой проверки.

## Что выполняется

`scripts/performance/pdf-lesson/run.mjs` создаёт одну свою доску. Переиспользуется контрольная сцена R08 версии 1: всего 3000 объектов, 500 видимых. Семь объектов `benchmark_02990`–`benchmark_02996` за пределами viewport заменяются семью объектами текущего PDF-control fixture: русский rich text, формулы, три локальные гарнитуры, две фигуры, штрих и WebP. Они находятся около `(10000,10000)`, поэтому состав видимых 500 объектов сохраняется. Добавляются 20 именованных фреймов вокруг этих семи объектов; страницы чередуют A4 portrait и A3 landscape. Доска содержит два небольших изображения: исходное R08 и контрольное PDF. Точный состав и числа типов записываются в отчёт.

После подготовки seed provider отключается. Урок ведут два независимых процесса Chromium: владелец и отдельный anonymous editor, присоединившийся через штатное приглашение. Каждый браузер использует свой уже проверенный network helper: 50 мс в каждую сторону и общий предел 50 Мбит/с на направление. HTTP и WebSocket идут через proxy; CDP network emulation не используется.

До измеряемых перемещений владелец через обычный HTTP API создаёт один фиксированный snapshot по 20 фреймам. В этот подготовительный интервал входят inspect и проверка предупреждений. Подготовка выполняется через Node owner API без сетевого ограничения и явно отделяется от измерения. Token хранится только в памяти, в отчёт не попадает. Его штатный TTL не продлевается.

По умолчанию выполняются **20 последовательных экспортов этого же 20-страничного snapshot**, без параллельного fanout. Это объявленный стресс сценарий повторных выгрузок во время урока. `--exports N` задаёт от 1 до 100 запросов; при `N < 20` приёмка невозможна. Количество запросов не увеличивается автоматически ради подходящего результата, печать искусственно не замедляется.

Каждый download POST выполняет настоящий `fetch` страницы внутри Chromium владельца, через его proxy и штатный public endpoint. Код страницы получает Blob и инициирует обычный download; Playwright сохраняет локальный PDF. PDF bytes, base64, token, cookie, приглашение и текст доски не включаются в JSON или stdout.

Для каждой итерации сначала устанавливается observer постоянного `style` у peer и выполняются настоящий pointerdown и drag прямоугольника на 20 px. Только после этой подготовки начинается public POST. Источник чередуется owner/editor. Протокол отпускания мыши версии 2 ждёт два последних последовательных correlated health-ответа `running: true, waiting: 0` после начала этой операции. Затем отправляется один настоящий `mouse.up`: подготовка элемента, observer и промежуточные движения больше не расходуют короткий интервал печати. Разрыв sequence, idle, ошибка или непустая очередь между ответами не образуют пару; устаревшая пара перед новым idle также не запускает ввод. В `releaseTrigger.busyObservations` сохраняются оба sequence, request/reply ID и границы host send/receive. Собственный небольшой `input.mjs` разделяет подготовку и завершение того же жеста; калиброванные `network/browser-probe.mjs` и другие общие network sources не меняются. Если download закончился раньше пары, мышь всё равно отпускается и перенос попадает в отчёт без предположения об overlap. Worker не замедляется.

Один busy-ответ может прийти менее чем за миллисекунду до pointerup; с учётом запаса 2 мс и границ browser clock этого недостаточно для доказательства перекрытия. Такая граница исключила одну операцию из первого causal-прогона на образе `221b`: 19 из 20 overlaps, итог `not-accepted`. Ожидание второй последовательной положительной проверки изменяет только момент ввода; интервалы доказательства, погрешности, минимум 20 overlaps и предел 300 мс сохраняются. Старый отчёт не пересчитывается.

Задержка измеряется от source `pointerup` до persistent style mutation у peer, без временного preview. Сохраняются `rawPropagationMs`, обе группы clock echoes и `propagationMs` — консервативная верхняя оценка с учётом source/peer clock bounds. Порог p95 ≤300 мс применяется к верхней оценке. После каждой операции оба клиента дожидаются «Сохранено». Один undo возвращает фигуру, затем оба клиента проверяют координаты и сохранение. Undo проверяется функционально; распределение задержек относится к 20 переносам, а не к клавише undo. Следующий PDF начинается только после завершения предыдущего download и undo.

## Доказательство перекрытия

Один постоянный read-only `docker exec Node` выполняет штатный `http://127.0.0.1:3100/healthz` внутри namespace текущего export-worker по команде runner. Он не читает env, токены или заголовки пользователей. Runner отправляет `health{id}` через stdin, хранит фактический `hostSentAt` в pending map и при чтении stdout фиксирует `hostReceivedAt`. Remote отвечает с тем же ID и возрастающим `sequence`. В каждый момент выполняется не более одного health-запроса; следующий отправляется через 25 мс после предыдущего ответа. Раз в секунду дополнительно читается память. Оба host timestamps используют `performance.timeOrigin + performance.now()`.

Overlap имеет причинные границы: `firstRunning.hostReceivedAt + 2` и `lastRunning.hostSentAt - 2`. Ответ на первый GET уже получен до `pointerup`, а последний GET отправлен после него, поэтому соответствующие наблюдения busy находятся по разные стороны ввода независимо от скорости remote часов. Все промежуточные health samples должны быть `running=true, waiting=0`, с непрерывным sequence, совпадающими request/reply ID и корректным host send/receive order. Медленные stdin, stdout или HTTP-ответ сужают интервал, не расширяют его. Один sample, idle gap, пропущенный sequence, неизвестный/повторный ID, нечисловая или обратная host граница не дают подтверждения. Acceptance содержит явный `causalProbeObservationsValid`; сравнение часов host↔worker и утверждение об их стабильности удалены.

Оба Chromium продолжают обмениваться тремя короткими clock echoes с runner до drag и после доставки изменения. Их `performance.timeOrigin + performance.now()` должен оставаться в прежнем допуске ±5 мс к host monotonic epoch, с конечными bounds не шире 50 мс; эти bounds используются для перевода source `pointerup`, peer DOM и PDF POST в одну шкалу. Весь диапазон возможного `pointerup` должен находиться внутри причинного busy-интервала и собственного browser POST interval с учётом clock bounds владельца. Worker `Date.now()`/`performance.now()` и wall timestamps host/browser сохраняются только для диагностики. Скачки или дрейф любых часов Docker VM не участвуют в acceptance и не превращаются в доказательство overlap.

Это **proxy занятости очереди worker**, включая чтение задания, Chromium startup/layout/print и выдачу результата. Точное время CPU печати или идентификатор задания по health не заявляются. Интервал public POST включает также сеть и доставку; сам по себе он не считается overlap. Не прошедшие overlap итерации остаются в общем отчёте. Публикуются отдельные full и overlap distributions.

## Условия приёмки

Для `status=accepted` одновременно требуются:

- завершены все объявленные экспорты и есть минимум 20 подтверждённых overlapping final-operation samples;
- у каждого полученного PDF подтверждены 20 страниц, порядок, размеры бумаги и целые русские фразы двумя независимыми extractor — штатным `__tests__/pdf-readability.py`;
- каждый public PDF request от начала `fetch` до получения полного Blob имеет конечный неотрицательный `requestDurationMs` не более 30 000 мс; сеть включена, поэтому критерий консервативен к собственному времени печати;
- каждый ответ содержит исходную fixed revision;
- full и overlap p95 конечного перемещения не превышают 300 мс; минимум по десять переносов от каждого клиента;
- калибровка завершена, checks пройдены, source hash/helper image/config совпадают, измеренный collaboration roundtrip p50 находится в 90–200 мс;
- нет ошибок страницы, ошибок probe, посторонней очереди и несовместимости часов;
- оба клиента подтверждают Saved и undo для каждой операции, финальный Node audit подтверждает persisted, все 3000 координат, 20 frames и контрольный rich text;
- записана память worker до, сразу после и после пяти секунд idle, текущая память укладывается в установленный cgroup limit;
- cleanup полностью завершён, прерывания и runtime failure отсутствуют.

Быстрая печать с менее чем 20 overlaps даёт `not-accepted`, даже если все PDFs корректны и full p95 хороший. Ошибка/прерывание сохраняет незавершённые итерации и не превращается в успех. SIGINT/SIGTERM обрабатывает общий `createRunLifecycle`: закрываются активные consumers, затем независимо выполняется очистка и атомарная запись отчёта. Общий deadline — 10 минут; `RIMO_NETWORK_DEADLINE_MS` может только уменьшить его. Remote probe имеет собственный deadline и прекращается при EOF stdin.

Probe читает cgroup memory current/peak/limit и RSS процесса worker. Он находит ровно один Node с текущей командой `node --import=tsx export-worker/index.ts` (допускается абсолютный `/app/export-worker/index.ts`) через `/proc/*/cmdline`; сырые аргументы не сохраняются. `workerPid` и `workerRssBytes` относятся к этому процессу. При отсутствии или неоднозначности кандидата наблюдение памяти не проходит; подмены RSS процесса `init` нет. Прежнее `pid1RssBytes` сохраняется только как диагностика: с `init: true` PID 1 обслуживает Docker init, а Node работает дочерним процессом. Исторический cgroup peak не сбрасывается. Probe сам добавляет небольшой расход памяти и CPU; это отражено в методике. Все численные наблюдения до/после 20 jobs нужны для ручной оценки тенденции, они не доказывают отсутствие утечки и не заменяют VPS-проверку.

Worker в Compose запускается с `init: true`: штатный init передаёт сигналы и собирает завершённые дочерние процессы ([Docker Compose](https://docs.docker.com/reference/compose-file/services/#init)). Это нужно и при штатном закрытии каждого Chromium: его осиротевшие потомки иначе могут остаться zombie у Node/PID 1 и исчерпать `pids_limit`. Проверка долгой эксплуатации отдельно снимает состояния процессов и `pids.events`, а не только память; лимит процессов и Chromium sandbox сохраняются.

До исправления на worker image `672111ed0fed` зафиксированы 157 zombie `chrome-headless`, все с PPID 1; `pids.current=187`, предел 256, `pids.peak=262`, `pids.events max=108`. Это подтверждённое достижение лимита процессов; исправление не объявляется принятым только по добавленной настройке. Безопасный исходный снимок: `temp/pdf-process-lifecycle/before-init-6da0c175-5f99-4e8a-87e7-f7cc3e48adbe.json`.

Для отдельной приёмки жизненного цикла предназначен [verify-pdf-processes.mjs](../scripts/verify-pdf-processes.mjs): 100 последовательных публичных экспортов по 20 страниц, состояния процессов и счётчики cgroup, независимая проверка первого и последнего PDF. Этот сценарий дополняет урок вдвоём, проверяет накопление процессов без повышения `pids_limit` и сохраняет собственный отчёт. Результат фактического запуска фиксируется отдельно от исходного отказа.

## Подготовка и команда

Нужны текущая production Compose-сборка на `http://localhost:3080`, один export-worker с внутренним портом 3100, Chromium, Python с `pypdf` и `pdfplumber`, private owner storage state. До создания доски preflight проверяет, что выбранный `--compose-project` содержит ровно один Caddy и один worker, а этот Caddy публикует TCP 3080 на localhost-совместимом bind (`127.0.0.1`, `0.0.0.0`, `::1` или `::`). Поэтому occupancy другого проекта не может использоваться для браузерного адреса 3080. Читаются только project/service labels, published ports и image IDs, без `Config.Env`; `projectBinding` сохраняет ID контейнеров и port mapping для review. Пример использует уже созданный тестовый state; реальные аккаунты не нужны. Anonymous state переиспользуется через `viewerContext`; его создание/права соответствуют общей инструкции [performance.md](performance.md). Новый anonymous аккаунт остаётся доступным для следующих замеров.

Перед общим окном должны пройти существующие `network/probe-self-test.mjs` и `network/calibrate.mjs`. Новый harness проверяет `temp/performance/network-calibration.json` и отказывается продолжать при изменении network sources/helper configuration. Он не строит Docker image и не перезапускает приложение.

Сначала можно посмотреть справку без браузеров, Docker и чтения credentials:

```text
node --import=tsx scripts/performance/pdf-lesson/run.mjs --help
```

Только после разрешения окна:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\temp\playwright-browsers"
$env:RIMO_PDF_PYTHON = "C:\Users\furhe\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
node --import=tsx scripts/performance/pdf-lesson/run.mjs --allow-service-test --exports 20 --storage-state temp/performance/network-owner-storage.json --compose-project rimo-rework --label IMAGE-DIGEST-HOST --output temp/performance/pdf-lesson-IMAGE-RUN/report.json
```

Путь Python можно задать `--pdf-python PATH`. Auth state задаётся только private file, пароли аргументами не передаются. `--guest-storage-state FILE` меняет приватный anonymous state. Новый output должен находиться внутри игнорируемого `temp`; существующий отчёт не перезаписывается другим запуском.

Рядом с output каждый запуск резервирует новый приватный каталог `pdf-<UUID>/` обычным `mkdir` без recursive и сохраняет туда по одному PDF каждой заявленной итерации. Его путь находится в `pdfArtifactDirectory` отчёта. Даже `run1.json` и `run2.json` в одном родительском каталоге получают разные каталоги PDF; существующий каталог не переиспользуется и не очищается. Наличие Python/extractor проверяется до создания доски; версии записываются в отчёт. Проверка страниц/text выполняется после измеряемой серии, чтобы Python extractor не влиял на input. Ошибка одного PDF не пропускает проверку остальных. JSON содержит только численные timings, hashes, версии, IDs своей доски/контейнеров и безопасные статусы. Отчёт отмечает точный source hash harness и использованных PDF fixtures/extractor. Артефакты — приватные, вне Git.

Очистка закрывает оба браузера, ожидания download, свой read-only probe, только собственные helper containers и созданную доску через owner API. Ошибка одного шага не пропускает следующие; сбой даёт `cleanup-failed`. Существующий owner/anonymous storage state не удаляется. Если процесс принудительно уничтожен, оператор проверяет `createdBoards`/`helperAttempts` из последнего атомарного отчёта и очищает только эти ресурсы.

## Проверки без запуска нагрузки

```text
npx vitest run __tests__/pdf-lesson-harness.test.ts
npx vitest run __tests__/pdf-lesson-timing.test.ts
npx vitest run __tests__/pdf-lesson-probe.test.ts
npx vitest run __tests__/pdf-lesson-release.test.ts
npx eslint scripts/performance/pdf-lesson __tests__/pdf-lesson-harness.test.ts __tests__/pdf-lesson-timing.test.ts __tests__/pdf-lesson-probe.test.ts __tests__/pdf-lesson-release.test.ts --max-warnings=0
npx tsc --noEmit --pretty false
```

Unit-проверки не запускают Chromium, Docker, HTTP-сервисы или нагрузку: они проверяют запрет без явного opt-in, валидность изменённой сцены 3000/500/20 frames, независимость от VM clock jumps/drift, matched-ID control pipe, строгие причинные границы overlap/POST, последовательную busy-пару и разделение подготовки drag и pointerup. Реальные проверки выполняются только в согласованном свободном окне. Отчёты причинной методики имеют `measurementVersion: 3`, текущий протокол ввода — `releaseProtocolVersion: 2`; старые записи со сравнением host/worker часов не пересчитываются в успешные результаты.
