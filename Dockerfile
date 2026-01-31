FROM node:18-alpine

WORKDIR /app

# 先拷贝依赖清单以利用缓存
COPY package*.json ./
RUN npm ci --only=production

# 再拷贝源码
COPY . .

ENV NODE_ENV=production
# 建议在容器中把运行时数据写到 /data（docker-compose 已默认设置）
ENV DATA_DIR=/data

EXPOSE 8080 8443 8094

CMD ["node", "whiteHitBlack.js"]
