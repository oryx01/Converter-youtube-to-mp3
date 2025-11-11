# Используем Node 22 как базовый образ
FROM node:22

# Устанавливаем необходимые пакеты
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip && \
    pip install -U yt-dlp 

# Копируем проект
WORKDIR /app
COPY . .

# Устанавливаем зависимости Node.js
RUN npm install

# Указываем порт (тот, который Render ждёт)
ENV PORT=10000
EXPOSE 10000

# Запускаем сервер
CMD ["npm", "start"]
