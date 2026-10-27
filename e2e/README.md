# Браузерная приёмка

Suite работает с настоящим UI, WebSocket и HTTP API. Он не подключается к PostgreSQL и не внедряет состояние Yjs. Нужен заранее созданный владелец; tests не создают аккаунты владельцев и не меняют чужие доски. Anonymous editor/viewer присоединяются обычной страницей приглашения.

## Готовый сервер или Compose

Задать `RIMO_E2E_BASE_URL` и `RIMO_E2E_EMAIL`/`RIMO_E2E_PASSWORD` через окружение/CI secrets, затем:

```sh
npx playwright install --with-deps chromium
npm run test:e2e
```

При заданном `RIMO_E2E_BASE_URL` Playwright **не запускает** локальные сервисы. URL должен вести на приложение с доступными collaboration и PDF worker. Этот режим подходит для проверки готового стенда или production Compose.

Global setup входит через форму владельца без trace, screenshot или вывода credentials. Состояние входа записывается в уникальный `temp/e2e/owner-<run-id>.json` и удаляется global teardown. Не передавайте пароль аргументом командной строки и не добавляйте auth state в CI artifacts.

Для локальной проверки можно задать `RIMO_E2E_STORAGE_STATE` — путь к уже авторизованному Playwright storage state. Setup проверит вход, но не перезапишет и не удалит этот файл. Нужен state именно проверяемого сервера; local и Compose могут иметь разные аккаунты/секреты.

## Автоматический локальный запуск

Без `RIMO_E2E_BASE_URL` config использует `http://localhost:3000` и управляет тремя процессами:

- готовая production-сборка через `npm start`;
- collaboration на 1234;
- PDF worker на 3100 с отдельным списком разрешённых env, без DB/Better Auth secrets.

Перед этим выполнить `npm run build`, миграции и provision владельца стандартными командами проекта. `.env.local` загружается автоматически. Локально существующие здоровые процессы переиспользуются, в CI сервисы запускаются заново. Для разработки можно явно задать `RIMO_E2E_APP_COMMAND="npm run dev"`.

В Windows с установленным полным Chromium вместо headless shell:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\temp\playwright-browsers"
$env:RIMO_E2E_BROWSER_CHANNEL = "chromium"
$env:PDF_WORKER_BROWSER_CHANNEL = "chromium"
$env:PDF_CHROMIUM_SANDBOX = "false"
npm run test:e2e
```

Последние два значения относятся только к запуску локального PDF worker; production контейнер использует включённый sandbox. Внешний сервер через `RIMO_E2E_BASE_URL` не получает эти переменные от runner.

## Сценарии

| Spec | Проверка |
|---|---|
| `collaboration.spec.ts` | Создание доски через UI, приглашения editor/viewer, изменения двух клиентов, локальная отмена с сохранением чужой фигуры, активный отзыв доступа |
| `rich-text.spec.ts` | Форматирование, LaTeX, Markdown, два текстовых редактора, локальная отмена, reload |
| `clipboard.spec.ts` | Загрузка изображения через UI, реальный clipboard payload между досками, отдельный asset назначения, работа после удаления источника |
| `exports.spec.ts` | Именованный фрейм, предпросмотр и скачивание PDF, экспорт/импорт архива с текстом, формулой, изображением и фреймом |

Fixture регистрирует только ID досок, созданных текущим test через API/UI или импорт. В `finally` закрываются guest contexts и удаляются только эти доски через owner HTTP API, включая импортированные. Ошибка cleanup считается ошибкой проверки. Исходный storage state и другие аккаунты/доски не удаляются.

Запускать одним worker: лимиты пилота и общая очередь экспорта проверяются отдельными нагрузочными tests. Один spec: `npx playwright test e2e/exports.spec.ts`. Просмотр списка без входа и серверных изменений: `npx playwright test --list`.

При падении остаются screenshots и trace в `test-results/e2e/`, CI также создаёт HTML report. Они могут содержать cookies, приглашения и тестовый материал — хранить как приватные CI artifacts с ограниченным сроком. Форма входа в trace не попадает. PDF и архив контрольного сценария тоже сохраняются в output test. Все эти каталоги должны оставаться вне Git.
