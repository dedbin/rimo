# Rimo

**Rimo** (React Miro) — современное веб-приложение для визуального совместного редактирования, вдохновленное Miro. Позволяет командам работать над досками в реальном времени: рисовать, размещать фигуры, перемещать объекты и взаимодействовать друг с другом онлайн.

---

## 🔍 Обзор

* **Мультипользовательская коллаборация**: одновременное редактирование несколькими участниками.
* **Реальное время**: мгновенная синхронизация состояния доски благодаря Convex и Liveblocks.
* **Интуитивный интерфейс**: простая навигация, масштабирование, перетаскивание и набор инструментов для рисования.
* **Масштабируемая архитектура**: поддержка множества досок и организаций.

---

## ⚙️ Технологический стек

* **Frontend**: React, TypeScript, Next.js, Tailwind CSS, shadcn/ui
* **Backend / Real-time DB**: Convex (серверные функции и хранилище данных)
* **Collaboration Layer**: Liveblocks для присутствия, курсоров, передачи событий
* **Code Quality & Tooling**: ESLint, Prettier, VSCode, GitHub Actions

---

## 📐 Архитектура и структура проекта

```
├── app/                     # Основные страницы (Next.js App Router)
│   ├── (dashboard)/         # Дашборд с перечнем досок и орг-меню
│   └── board/[boardId]/     # Страница конкретной доски и её компоненты
├── components/              # Переиспользуемые UI-компоненты и модалки
├── convex/                  # Convex схемы и серверные функции
├── hooks/                   # Кастомные React-хуки
├── lib/                     # Утилитарные функции
├── providers/               # Провайдеры контекста (Convex, модалки)
├── public/                  # Статические ресурсы: иконки, SVG
├── scripts/                 # Вспомогательные утилиты (генерация аватарок)
└── types/                   # Общие TypeScript типы
```

* **App Router**: маршрутизация и лэйауты в `app/layout.tsx`, страницы в `app/(dashboard)` и `app/board/[boardId]`.
* **Convex**: все операции с базой данных в `convex/schema.ts`, `convex/boards.ts`, `convex/board.ts`.
* **Liveblocks**: конфигурация в `liveblocks.config.ts`, авторизация через API-роут `app/api/liveblocks-auth/route.ts`.

---

## 🚀 Быстрый старт

1. **Клонировать репозиторий**

   ```bash
   git clone https://github.com/dedbin/rimo.git
   cd rimo
   ```

2. **Установить зависимости**

   ```bash
   npm install
   ```

3. **Создать файл окружения**

   ```text
   CONVEX_DEPLOYMENT=<your_convex_deployment>
   NEXT_PUBLIC_CONVEX_URL=<your_convex_url>
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<your_clerk_publishable_key>
   CLERK_SECRET_KEY=<your_clerk_secret_key>
   CLERK_FRONTEND_API_URL=<your_clerk_frontend_api_url>
   NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY=<your_liveblocks_public_key>
   NEXT_PUBLIC_LIVEBLOCKS_SECRET_KEY=<your_liveblocks_secret_key>
   AITUNNEL_API_KEY=<your_aitunnel_api_key> (optional, not ready yet)



4. **Запустить локально**
   ```bash
   npm run dev
   ````

5. **Открыть в браузере**: [http://localhost:3000](http://localhost:3000)

---

## 🎨 Основные возможности

* Создание и удаление досок
* Генерация уникальных аватарок досок
* Добавление, выбор и перемещение прямоугольников и других фигур
* Выделение объектов рамкой, смена цвета
* Панорамирование и масштабирование холста
* Просмотр курсоров участников и их аватарок в реальном времени
* Приглашение участников по ссылке

---

## 🤝 Вклад и TODO

Если вы хотите помочь развитию Rimo, создавайте issue или PR.

**TODO (отмечены в коде как `TODO:`):**

* **Мобильная адаптация**: доработать отзывчивость интерфейса для смартфонов и планшетов. 
* **Тестирование**: покрыть ключевые модули юнит- и интеграционными тестами.
* **Оптимизация производительности**: улучшить рендеринг большого числа объектов и lazy-load компонентов.
* **Импорт досок из Miro**: дать пользователям возможность импорта досок из miro (напимер используя api miro)
---

## 📖 Лицензия

MIT © 2025 dedbin
