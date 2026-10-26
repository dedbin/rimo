# Наблюдения аудита Rimo

Дата: 25 октября 2026.

- Next.js 15.3.2, React 18.3.1, TypeScript, Tailwind 4.
- Внешние сервисы: Clerk, Convex, Liveblocks.
- В репозитории есть Dockerfile, Compose и 11 файлов тестов.
- npm build отключает lint; npm lint использует next lint.
- Локальный файл .env.local присутствует; значения секретов не выводятся в отчеты.
- Независимые агенты проверяют дефекты кода и варианты развития продукта.

## Итоговые проверки

- Чистая установка с отключенными install scripts: 741 пакетов; сборка успешна.
- 29 тестов в 11 файлах проходят после чистой установки.
- TypeScript: 2 ошибки namespace vi в тесте API preview.
- ESLint из lock-файла, выбранные директории исходников: 71 ошибка и 14 предупреждений.
- npm audit production: 16 записей уязвимых пакетов, из них 3 critical, 11 high, 2 moderate; полный аудит 85 записей.
- В 35 клиентских JS-файлах сборки совпадений с фактическим Liveblocks secret не найдено.
- Неиспользуемые usehooks-ts, calendar/react-day-picker, ui/sonner/next-themes; motion нельзя удалять без учета транзитивного framer-motion.
- Прямые импорты i18next и framer-motion отсутствуют в декларациях зависимостей.
- Итоговые документы: hosting-audit-2026-10-25.md и questions-for-tomorrow-2026-10-25.md.
- Локальный запуск после привязки к localhost: GET / и POST /api/generate-cover дают 200; в браузере отображается лендинг. Clerk загружается с development keys. Вход и совместная доска не проверены.
