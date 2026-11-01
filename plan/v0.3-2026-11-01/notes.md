# Наблюдения: Rimo v0.3

## Исходное состояние
- Дата: 1 ноября 2026, Москва. База: `ed77abb` (merge v0.2).
- Приложение: Next.js, React, TypeScript, Yjs/Hocuspocus, PostgreSQL.
- Уже есть личные параметры маркера, pan/pinch и прямые/отрезки со стрелками.
- В presence пока нет камеры, laser или альфа-канала penColor.
- Ветка master изначально совпадает с origin/master; внешняя синхронизация не выполнялась.
- Исходные чужие изменения: eslint.config.mjs, tsconfig.json; каталоги animations/,
  content-factory/, lessons/ и их планы. Они не относятся к этому выпуску.

## Проверки
- Исходные lint и typecheck прошли до реализации функций.
- Исторические результаты v0.2 не считаются приёмкой v0.3.

## Архитектурные решения
- Пунктир: optional `strokeStyle` (`solid` / `dashed`), старые линии сплошные;
  альфа маркера хранится в существующем `Color.a`, миграция документа не нужна.
- Серверная allowlist в `collaboration-server/awareness.ts` должна пропускать
  ограниченные и проверенные поля камеры и лазера.
- В checkout уже есть старые метаданные bisect; они сохраняются, reset не выполняется.

## Итог приёмки
- Направленные проверки и независимые review выполнены агентами; найденные
  рассогласование UI пунктира и resize в Laser исправлены с regression tests.
- Unit: 929 passed / 152 opt-in skipped. Integration: 161 passed / 17 skipped;
  после build отдельно подтверждён скомпилированный runtime (1 passed).
- Browser Chromium: новые 6 и регрессионные 16 passed; оба runner завершились exit 0.
- Lint, typecheck, production build, diff check прошли. Production audit: 0 vulnerabilities.
- Артефакты browser runs: `test-results/e2e/d7bf4776-e261-411a-9782-73347346bd1a/`
  и `test-results/e2e/cadeb10c-2b95-49ba-9d11-8467e706ce0b/` (игнорируются Git).
- Физический планшет/Safari, S3 и прежняя длительная нагрузочная приёмка
  не подтверждаются этими проверками. Подробнее в `implementation-report.md`.
- Старый локальный v0.2 остановлен с проверкой PID; собственные E2E процессы
  завершены. v0.3 оставлен запущенным для ручной проверки, demo screenshot просмотрен.
- Постоянные skills/agents/config не менялись; обновление AGENTS.md не требуется.
