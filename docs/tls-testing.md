# Локальная приёмка HTTPS/WSS

Постоянный helper `scripts/tls-acceptance/run.mjs` поднимает собственный Compose
со свежими PostgreSQL/assets/Caddy volumes и выполняет UI-сценарий в двух
Chromium contexts. Существующие проекты и `.env` не используются.

Нужны локальный Docker Compose и заранее собранные образы приложения и worker.
Helper не собирает и не скачивает образы. По умолчанию используются теги
`rimo:local` и `rimo-export:local`; перед созданием контейнеров они однократно
разрешаются в immutable image ID. Все сервисы текущего прогона используют
именно эти ID, даже если теги изменились параллельно.

```powershell
$env:RIMO_TEST_DOCKER_TLS = '1'
node scripts/tls-acceptance/run.mjs
Remove-Item Env:RIMO_TEST_DOCKER_TLS
```

Доступны `--app-image`, `--worker-image` и `--deadline-ms` (1–360000,
по умолчанию 360000). `--help` не требует opt-in и не обращается к Docker.
Пути конфигурации, browser source и отчётов вычисляются относительно самого
helper: рабочий каталог вызывающего процесса не влияет на назначение файлов.
Результаты находятся только в игнорируемом `temp/tls-acceptance/`.
Отчёт содержит Git commit/dirty, Node и Docker client/server/Compose версии,
immutable image ID и SHA-256 каждого runtime input: run, browser,
`docker-compose.yml`, `config/chromium-seccomp.json`, а также их общий SHA-256.
Git/Docker версии при недоступности записываются как null; Config.Env не читается.

## Изоляция и сертификат

Каждый запуск получает случайный проект `rimo-tls-<16 hex>`. Только Caddy
публикует два случайных порта на `127.0.0.1`; app, collaboration, PostgreSQL,
worker и отдельный browser container не имеют host ports. Caddy получает
собственный read-only конфиг с `tls internal` и `skip_install_trust`.
Общий Compose, hosts, DNS, proxy, firewall и системный trust store не меняются.

Hostname `rimo.test` существует только как alias своей Docker-сети и правило
`--host-resolver-rules` Chromium. Проверка Secure-cookie не использует
localhost-исключение. В двух тестовых contexts включён `ignoreHTTPSErrors`
для собственной самоподписанной CA. Отдельные Node HTTP/1.1 и HTTP/2 пробы
проверяют цепочку этой CA и SNI полностью через параметр одного соединения.

Browser container использует worker image без app/DB/PDF secrets: non-root,
read-only FS, tmpfs, ограниченные RAM/CPU/PID, production seccomp и
`chromiumSandbox: true`. Учётные данные тестового владельца передаются только
приватным stdin. Владелец создаётся через штатный `scripts/create-owner.ts`.
Пароли, email, cookie values и invite tokens не записываются в отчёт/CLI.

## Что проверяется

- Настоящий owner login и anonymous editor по приглашению через UI.
- `isSecureContext`, Secure/HttpOnly/SameSite=Lax у session-cookie обоих
  contexts, недоступность HttpOnly cookie через `document.cookie`.
- Первоначальный HTTP-запрос после входа действительно наблюдён до 308 redirect;
  Secure session-cookie в нём отсутствует.
- Session API отдаёт `wss:` того же host/port; реальные WSS-кадры доставляются.
  Фигуры двух участников получают «Сохранено» и восстанавливаются после reload.
- Приватное HTTPS-изображение доступно owner/editor, запрос без cookie получает
  401; браузер декодирует изображение, ответ имеет private/no-store.
- PDF preview именованного фрейма: POST 201, iframe GET 200, видимый SVG.
- Нет page errors, mixed content или незашифрованных subrequests.

## Остановка и cleanup

SIGINT, SIGTERM и общий deadline прерывают работу через единый `finally`.
Текущий Docker CLI завершается; cleanup независимо от abort выполняет
`down --volumes` только для проверенного собственного проекта. Затем проверяет
отсутствие контейнеров, сетей и volumes с точной меткой этого проекта.
Browser process в контейнере также ограничен deadline; закрывается браузер,
а удаление контейнера завершает его оставшиеся процессы.

Перед рекурсивной очисткой `run-*` проверяется абсолютный родительский каталог.
При неудаче Docker cleanup временный Compose сохраняется для ручной диагностики;
отчёт получает неуспешный статус. Повторный сигнал не обрывает уже идущую уборку.
Сигнал во время записи итогового JSON приводит к повторной записи `interrupted`,
а не к ложному `passed`. Коды остановки: SIGINT — 130, SIGTERM — 143, deadline —
124; ошибка cleanup всегда даёт ненулевой код.

Узкие unit tests без Docker/Chromium проверяют opt-in, остановку настоящего
дочернего Node-процесса и поздний сигнал во время записи отчёта:

```powershell
node node_modules/vitest/vitest.mjs run __tests__/tls-acceptance.test.ts
```

## Историческая проверка и границы

Исходные temp scripts и отчёт `temp/tls-acceptance/result-1793068133162.json`
сохранены как историческое подтверждение: 45,527 с, приложение C49 и worker
4eaeba, два Linux Chromium contexts, оба Secure cookie, WSS/Saved/reload,
изображение и PDF preview прошли. Перенесённый helper требует отдельного
реального прогона на текущих разрешённых image ID; старый результат не является
измерением новой сборки.

Постоянный helper повторно прошёл в `03:38:31 UTC` на app/collaboration
`sha256:48116dd68d90d8b09293440075e97dea48f6f0f120d4dc5fc6239e0a586d9ce2`
и worker
`sha256:672111ed0fedc85f785f15799818f76c5bb83e890a3313a710bc1da67dd21a23`.
Время — 45,625 с; source SHA-256 —
`2c157b43601ab03123822599760aee623c3c8906bfd5c5d619b787f220975364`.
Отчёт: `temp/tls-acceptance/result-1793072356735-8188651a331642c9.json`.
HTTP/1.1 и HTTP/2 проверили собственную CA; два contexts получили Secure cookies,
HTTP-запрос без session-cookie вернул308, WSS передал78кадров, Saved/reload,
private image и PDF preview прошли. Page/mixed-content/socket errors —0.
Все контейнеры, сети, тома и временный run-каталог удалены и проверены.

Windows Chromium того окружения возвращал 499 до входа; прямые проверенные
HTTP/1.1 и HTTP/2 запросы и Linux browser возвращали 200. Поэтому helper
воспроизводимо использует отдельный Linux browser container.

Это локальная проверка production-пути с собственной CA. Публичный TLS/ACME,
DNS реального сервера и доверие браузера к публичному сертификату не проверяются.
