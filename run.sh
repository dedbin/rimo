#!/bin/bash

cp .env.local .env

echo "🚀 Собираем и запускаем Rimo в dev-режиме..."
docker-compose up --build -d

echo "✅ Запущено. Открывай: http://goga-nado.ru:3000"
echo "📊 Следи за ресурсами: docker stats rimo-dev"
