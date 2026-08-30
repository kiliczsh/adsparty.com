FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
