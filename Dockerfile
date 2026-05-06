FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    && pip3 install -U yt-dlp --break-system-packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .
RUN mkdir -p downloads

EXPOSE 3001
CMD ["node", "server.js"]
