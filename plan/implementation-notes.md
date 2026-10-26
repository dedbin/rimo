# Наблюдения и решения по переработке

## Исходное состояние

- Next.js 15.3.2, React 18, TypeScript, SVG-редактор.
- Текущие сервисы: Clerk, Convex, Liveblocks.
- Требования нового выпуска описаны в `rimo-development-plan-2026-10-26.md`.
- Локальные изменения внешнего вида существовали до начала этой работы; их нужно сохранить.
- Цель уже активна в Codex; длительность работы запрошена пользователем — 20 часов.

## Проверки

- Исходно: 29 тестов проходили; typecheck — две ошибки старого `vi.Mock`; ESLint захватывал `.next`; установленный `node_modules` не совпадал с lock.
- npm resolver дважды не смог согласовать старый Vite 6 с optional peers Better Auth. Создан чистый lock в `temp/dependency-lock`, выполнен `npm ci` без `--force`/`--legacy-peer-deps`.
- Установлены фиксированные Better Auth 1.7.13, Hocuspocus 4.7.1, Yjs 13.6.33, pg 8.23.1, Next.js 15.5.28, sharp 0.35.5. PostCSS 8.5.31 закреплён override из-за уязвимого транзитивного пакета Next 15.
- После обновления `npm audit` сообщает 0 известных уязвимостей. Typecheck общего проекта прошёл.
- Шрифты Geist/Poppins поставляются локально, сборка не обращается к Google Fonts.
- Тестовый PostgreSQL 18.1 запущен отдельно на localhost:55432, кластер и локальные секреты игнорируются Git.
- Docker Desktop запущен; доступны Linux engine 28.0.4 и Compose 2.34.0.
- Серверный агент: 8 тестов реального HTTP/auth/ACL/assets прошли; миграции идемпотентны.
- Агент совместной работы: 10 тестов WS/persistence/ACL/presence, включая SIGKILL после подтверждения записи на настоящем PostgreSQL, прошли.
- Последний полный прогон `npm run test:integration`: 71 тест, 20 файлов, все прошли. `lint` без предупреждений, `typecheck` прошёл, production build прошёл.
- Docker Compose собран и поднят: db/app/collaboration healthy, Caddy отвечает; `/api/health` через localhost:3080 возвращает 200. UID приложения — 1000, `.env`, `.env.local` и `.git` отсутствуют в runtime image. Базовые образы закреплены фактически проверенными digest.
- Браузер Chromium v1248: вход владельца, открытие dashboard/board без page errors; два независимых контекста прошли приглашение, совместные фигуры, перемещение и локальную отмену с сохранением чужой фигуры, viewer и отзыв активного editor.
- Браузер обнаружил незакрытый дефект: пустой текст не активируется двойным кликом. Исполнитель редактора воспроизводит и исправляет; следующий контрольный запуск должен закрыть также text/image/reload сценарий.
- Старые 37 файлов `public/uploads` (около 8 МиБ) перемещены в игнорируемый `temp/legacy-public-uploads`, чтобы новая версия не выдавала прежние изображения публично. Нужные исходникам ссылки на этот каталог отсутствуют.
- Независимое ревью выявило и устранило mismatch presence, неверную обработку logical close на клиенте и отсутствие deadline повторной проверки прав при зависшей БД.

## Принятые контракты

- `Y.Doc`: `meta.schemaVersion=1`, `layers` как map per-field maps, `layerIds` как массив; порядок нормализуется при чтении.
- Better Auth обслуживает аккаунты и анонимных гостей; публичный sign-up закрыт, владельцы создаются через CLI.
- Секрет приглашения в URL fragment, в БД только SHA-256; права и членство находятся вне CRDT.
- WebSocket проверяет cookie и Origin; повторная проверка сессии и ACL не реже пяти секунд.
- Первая реализация сохраняет полные snapshots без журнала. ACK содержит Yjs snapshot с delete-set и отправляется после COMMIT. Синхронизация транспорта не означает сохранение.
- Старые Convex/Clerk/Liveblocks исходники и публичные upload endpoints удалены, используются API с проверкой доступа и стабильные `/api/assets/:id`.
- Получение внешнего HTML для link cards временно заменено metadata по URL без сети; hardened preview — отдельная дальнейшая задача.

## Источники

- https://nextjs.org/blog/nextjs-security-update-october-14-2026 — исправление Next.js/Sharp.
- https://better-auth.com/docs/installation — поддерживаемая настройка auth и БД.
- https://docs.yjs.dev/api/undo-manager — локальные origins и undo.
- https://vite.dev/guide/features — JSX runtime и встроенные tsconfig paths Vite 8.
