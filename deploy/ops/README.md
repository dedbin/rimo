# Страница прогресса и входящие сообщения

Готовый web app ntfy обслуживается тем же Caddy, что и Rimo:
`https://www.rimo-whiteboard.ru:8443`. Хост `www` отделяет его от host-only
cookies основного приложения; Caddy дополнительно удаляет upstream Cookie.
Внешний порт 8080 не публикуется. Отдельный BasicAuth поверх ntfy не нужен:
его web app использует собственный Bearer token.

## Запуск

В закрытый `.env` основного релиза добавить `DASHBOARD_DOMAIN=www.rimo-whiteboard.ru`.
Оба домена должны разрешаться в сервер, а 80/443/8443 быть доступны снаружи.
Из корня репозитория, от администратора сервера. Один раз перед первым
запуском нового тома задать владельца только его корневого каталога:

```sh
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml run \
  --rm --no-deps --user 0:0 --cap-add CHOWN --cap-add FOWNER --entrypoint sh ntfy \
  -c 'chown 1000:1000 /var/lib/ntfy; chmod 0700 /var/lib/ntfy'
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml up -d --wait
```

`CHOWN`/`FOWNER` добавлены только одноразовой команде инициализации;
штатный ntfy остаётся UID1000 с `cap_drop: ALL`. Рекурсивной смены прав нет.

Образ ntfy закреплён версией 2.34.0 и реально скачанным digest в Compose.
БД авторизации и история сообщений сохраняются в named volume
`rimo_ntfy-data`; постоянное имя проекта `-p rimo` сохраняет его при переключении
каталога релиза. При обычном обновлении нельзя использовать `down --volumes`
или `volume prune`. История удаляется через 30 дней. SMTP, внешние push/upstream
и вложения не включены. Лимит 128 МиБ — исходная настройка, фактический расход
и отсутствие OOM проверяются на сервере.

## Учётные записи

Сначала запустить `serve`: он создаст auth.db с закрытым по умолчанию доступом.
Разные случайные пароли заранее сохранить в приватные серверные файлы
`/root/private/ntfy-owner-password` и `/root/private/ntfy-agent-password`
с режимом 0600, без вывода содержимого в терминал.

Все команды ниже выполняются из корня того же релиза:

```sh
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy sh -c \
  'IFS= read -r NTFY_PASSWORD; export NTFY_PASSWORD; exec ntfy user add owner' \
  < /root/private/ntfy-owner-password
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy sh -c \
  'IFS= read -r NTFY_PASSWORD; export NTFY_PASSWORD; exec ntfy user add codex-agent' \
  < /root/private/ntfy-agent-password
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy ntfy access owner rimo-work ro
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy ntfy access owner rimo-inbox rw
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy ntfy access codex-agent rimo-work wo
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy ntfy access codex-agent rimo-inbox ro
```

Владелец входит как `owner`, подписывается на `rimo-work` для чтения прогресса
и на `rimo-inbox` для отправки сообщений. Агенту доступна публикация только
в `rimo-work` и чтение только `rimo-inbox`.

Токен агента создаётся отдельно; весь вывод команды содержит секрет и остаётся
в закрытом файле:

```sh
umask 077
docker compose -p rimo -f docker-compose.yml -f deploy/ops/compose.yml exec -T ntfy \
  ntfy token add --expires=30d --label=codex-local codex-agent \
  > /root/private/ntfy-agent-token-output
```

Токен и пароли не передаются в argv, Git или журнал прогресса. История сообщений
не является командным интерфейсом: ссылки и вложения автоматически не исполняются.
Панель сама не запускает Codex; для чтения вне активной работы нужен heartbeat
исходного чата и доступный локальный Codex.

## Приёмка

- Проверить сертификаты HTTPS и совпадение hostname на 443/8443.
- Анонимное чтение/публикация и неверный пароль должны быть отклонены.
- `owner` не публикует в `rimo-work`; агент не публикует в `rimo-inbox`.
- Проверить owner→inbox→агент и агент→work→владелец, затем сохранение после restart.
- `/v1/health` проверяет ответ сервера, а сохранность проверяется отдельно.

Основания: [web app](https://docs.ntfy.sh/subscribe/web/),
[официальный Docker healthcheck](https://docs.ntfy.sh/install/#docker),
[конфигурация](https://docs.ntfy.sh/config/),
[релиз 2.34.0](https://github.com/binwiederhier/ntfy/releases/tag/v2.34.0).
