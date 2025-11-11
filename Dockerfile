# Базовый образ с Node.js
FROM node:22

# Устанавливаем ffmpeg и yt-dlp
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip && \
    pip install -U yt-dlp

# Создаём директорию приложения
WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install

# Копируем остальные файлы проекта
COPY . .

# Указываем порт
ENV PORT=10000

# Запуск
CMD ["node", "server.js"]
