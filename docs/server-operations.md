# Эксплуатация сервера Rimo

Релизы находятся в `/srv/rimo/releases/<commit>`, текущий выбран symlink
`/srv/rimo/current`. Основные Docker volumes и `rimo_ntfy-data` принадлежат
постоянному Compose project `rimo`, поэтому переключение релиза сохраняет данные.
Приватные настройки находятся в `/srv/rimo/private`, доступны только root.
Пароли, токены и содержимое этих файлов в Git и журнал прогресса не включаются.

## Ежедневная копия

`deploy/backup-daily.sh` запускается в 04:00 по `Europe/Moscow`:

1. Резервирует `flock` в `/srv/rimo/backups/daily.lock` и новый закрытый staging.
2. Штатным `backup-service.mjs` кратко останавливает app/collaboration,
   сохраняет согласованные PostgreSQL/assets и возобновляет исходных writers.
3. `backup-ops.sh` создаёт отдельные зашифрованные snapshots конфигурации и ntfy.
4. Штатный `restic-backup.mjs` передаёт core и выполняет полный `check --read-data`
   уже после ops snapshots. Ошибка ops не отменяет попытку передать core;
   итоговый daily unit при этом завершается ошибкой.

В `complete` находятся ровно `database.dump`, `assets.tar`, `manifest.json`.
Только core получает тег `rimo-service:rimo` и исходный timestamp для age-check.
Настройки `/srv/rimo/private`, `config`, `deploy/ops` получают отдельный тег
`rimo-ops:configuration`. Поток `ntfy.tar` получает только `rimo-ops:ntfy`.
Он передаётся через `--stdin-from-command`: ненулевой код tar/Docker отменяет
создание snapshot, включая случай уже прочитанного частичного потока.
Такое поведение описано в [документации restic 0.19.1](https://github.com/restic/restic/blob/v0.19.1/doc/040_backup.rst#reading-data-from-a-command).
Stdout/stderr restic и ошибка производителя остаются в приватном `ntfy-restic.log`.
Приватные служебные логи находятся рядом с `complete`, вне core snapshot.

Для ntfy проверяются container ID, Compose labels и владелец named volume.
Если он running, перед чтением SQLite он останавливается; EXIT/INT/TERM trap
запускает прежний container ID и проверяет Running. Изначально exited/created
остаётся остановленным. Неустойчивые состояния требуют отдельного разбора.
Running не доказывает HTTP-готовность: её проверяют отдельно после запуска.
При сбое Docker restart возвращается ошибка, а не ложный успех.
SIGKILL или выключение сервера trap не выполняют: после такого сбоя оператор
проверяет и восстанавливает штатное состояние сервисов вручную.
Для ops restore выбирают snapshot успешного daily; частичная configuration-копия
с restic exit3 не должна автоматически приниматься как пригодный latest.

`backup.env` содержит `RESTIC_REPOSITORY` и `RESTIC_PASSWORD_FILE`.
Текущее назначение — `/srv/rimo/backups/restic`; это зашифрованная **локальная**
копия, внешний offsite ещё требует отдельного хранилища и приёмки восстановления.
Ключ restic нужно хранить также независимо от этого сервера.
Staging и snapshots автоматически не очищаются; расход места проверяется
перед ростом данных. `down --volumes`, `volume prune` и непроверенный `forget/prune`
в обычном обновлении не используются.

## Установка расписаний

На сервере должны быть доступны Node 22.23.4, restic 0.19.1, Docker Compose,
`flock` и штатные Linux utilities. Пути в units: `/usr/local/bin/node`,
restic находится через `PATH=/usr/local/bin:/usr/bin:/bin`.
До включения таймеров оператор проверяет один фактический backup и восстановление.

```sh
cd /srv/rimo/current
install -m 0644 deploy/systemd/rimo-*.service deploy/systemd/rimo-*.timer /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/rimo-*.service /etc/systemd/system/rimo-*.timer
systemctl start rimo-backup.service
systemctl start rimo-monitor.service rimo-restic-age.service
systemctl enable --now rimo-backup.timer rimo-monitor.timer rimo-restic-age.timer
systemctl list-timers 'rimo-*' --all
```

Daily timeout 75 мин; после простоя Persistent timer догоняет пропущенный запуск.
Monitor выполняется раз в минуту, имеет внутренний deadline 45 с и внешний 55 с.
Exit 0 = healthy, 1 = warning (успешный unit с сохранённым warning JSON), 2 = critical.
Во время согласованной копии writers и ntfy временно недоступны;
её сопоставляют с журналом backup, не с полным отказом сервиса.
Независимый age-check запускается раз в час и проверяет именно возраст исходного
core snapshot: отсутствие/старше 24 ч даёт exit 1 и failed unit.
Таймеры пишут в journal; отдельная автоматическая доставка тревог не включается
самой установкой этих units.

```sh
journalctl -u rimo-backup.service -u rimo-monitor.service -u rimo-restic-age.service --since today
systemctl --failed
```

Перед обновлением проверить, что backup не выполняется; рабочие сценарии обновления
должны использовать тот же project `rimo`. Не удалять текущий/предыдущий релиз
и данные до проверки нового запуска. Для восстановления core используются
существующие инструкции [полной копии](backup-and-archives.md) и
[restic](offsite-backup.md); ops snapshots восстанавливаются отдельно.
