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
   NEXT\_PUBLIC\_CONVEX\_URL=\<your\_convex\_url>
   NEXT\_PUBLIC\_CLERK\_PUBLISHABLE\_KEY=\<your\_clerk\_publishable\_key>
   CLERK\_SECRET\_KEY=\<your\_clerk\_secret\_key>
   CLERK\_FRONTEND\_API\_URL=\<your\_clerk\_frontend\_api\_url>
   NEXT\_PUBLIC\_LIVEBLOCKS\_PUBLIC\_KEY=\<your\_liveblocks\_public\_key>
   NEXT\_PUBLIC\_LIVEBLOCKS\_SECRET\_KEY=\<your\_liveblocks\_secret\_key>
   AITUNNEL\_API\_KEY=\<your\_aitunnel\_api\_key>



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

* **Генерация аватарок досок**: реализовать автоматический запуск скрипта `scripts/img_generation.py` при создании новой доски, сохранять сгенерированные файлы. ([github.com](https://github.com/dedbin/rimo))
* **Мобильная адаптация**: доработать отзывчивость интерфейса для смартфонов и планшетов. TODO: помечено в `components/landing-navbar.tsx`.
* **Тестирование**: покрыть ключевые модули юнит- и интеграционными тестами. TODO: в `hooks/use-selection-bounds.ts` и других местах.
* **Оптимизация производительности**: улучшить рендеринг большого числа объектов и lazy-load компонентов. TODO: в `board/_components/canvas.tsx`.

---

## 📖 Лицензия

MIT © 2025 dedbin
