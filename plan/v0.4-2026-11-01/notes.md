# Исследование Rimo v0.4

## Исходное состояние
- База: текущий `master`, Rimo v0.3.0.
- React 18, Next.js 15, TypeScript, совместный SVG-редактор на Yjs.
- Есть личные настройки маркера, линии, лазер, следование и жесты доски.
- Чужие локальные изменения зафиксированы в плане и не относятся к v0.4.

## Библиотеки-кандидаты
- Mafs: React/SVG, готовые Cartesian axes, functions, inequalities, pan/zoom.
  https://mafs.dev/guides/display/mafs
- JSXGraph: самостоятельная интерактивная математическая доска SVG/canvas.
  https://jsxgraph.org/docs/
- mathjs: готовый математический parser; для пользовательского ввода нужен
  ограниченный AST и лимиты, исключающие assignments и тяжёлые операции.
  https://mathjs.org/docs/expressions/security.html

## Архитектура
Уточняется после исследования совместимости отрисовки и экспорта.
