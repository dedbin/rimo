# Наблюдения развёртывания

- Пользователь предоставил домен `rimo-whiteboard.ru`; DNS проверяется отдельно.
- Пять сервисов Rimo, база и assets используют постоянные тома; наружу выходит Caddy.
- Нужна отдельная защищённая панель с журналом прогресса и входящими сообщениями.
- Секреты, ключи, состояния входа и данные владельца в этот документ не включаются.

## Проверенный хост

- Ubuntu24.04.4 LTS, 6 логических CPU, RAM7940МиБ, диск77ГиБ/75ГиБ свободно.
- Первоначально слушает только SSH22 и локальный DNS; Docker отсутствовал.
- SSH host key закреплён локально, дальнейшие соединения проверяют его.
- Авторитетный ns1.reg.ru отдаёт корень и www; внешние1.1.1.1/8.8.8.8 пока NXDOMAIN.

## Инфраструктура панели

- Готовый [ntfy2.34.0](https://github.com/binwiederhier/ntfy/releases/tag/v2.34.0),
  [web app](https://docs.ntfy.sh/subscribe/web/), 30дней истории и закрытые ACL.
- `www:8443` отделяет host-only Rimo cookies; Caddy дополнительно удаляет Cookie upstream.
- Review выявил привязку данных к каталогу релиза; исправляем на постоянный named volume.
- Docker ставится из [официального подписанного apt repo](https://docs.docker.com/engine/install/ubuntu/).
- Установлены Docker29.9.2, Compose5.6.1 и Node22.23.4; Node tar проверен SHA256.
- Источник Rimo — git archive e671653, SHA256
  `51811897dc8548194c9a9059af4cf492cc3f0d91734d8ca3bdd893cc03020e3a`.
- Реально скачанный ntfy digest:
  `sha256:901e14503d3f605f445be0e68f2ac71f0aa73391897ce6ceb599f8c48d8b3792`.
- На VPS собраны image IDs (Docker29/containerd): app
  `sha256:8ad9f8dc3a4abdf08dd7e4f77053405ea2df8d5301511b1045c85ea8f7f93738`, PDF
  `sha256:d36ba1860af5c17687082b6544e5483b0d64a5563756fd2390e4de3449d7fa3e`.
- База/миграции/app/collaboration/PDF/ntfy запущены; создан технический владелец.
- Девять реальных проверок ntfy прошли: anon/wrong-password/чужие темы/неверная
  роль отклонены, оба направления сообщений и две русские подписки подтверждены.
- WHOIS: зарегистрирован28октября04:05UTC, DELEGATED; внешняя RU-зона пока NXDOMAIN.
- В05:24UTC появилась публичная делегация; запущен Caddy с валидными TLS для обоих hosts.
- Новая суточная копия05:58UTC: core+ops snapshots, full read-data check, unit success.
- Server-side monitor через current alias реально вернул healthy после entry guard fix.
- Restore e9177bde принят в отдельном Compose project; loopback порты, те же
  images, полная уборка target и неизменность source подтверждены.
- В06:30UTC завершена контрольная перезагрузка: kernel6.8.0-147, failed units0,
  containers и timers поднялись сами, прежняя HTTPS session cookie сохранилась.
- Панель получила реальное сообщение владельца, ответ опубликован; ни текст,
  ни приватные учётные данные не включаются в tracked evidence.
