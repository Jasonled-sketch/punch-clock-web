FROM node:22-slim
# ffmpeg：做回顧影片；fonts-noto-cjk：影片上的中文字
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
COPY scripts ./scripts
ENV NODE_ENV=production DATA_DIR=/data
CMD ["npm", "start"]
