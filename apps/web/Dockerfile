# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# v3.7.9 — use Docker's embedded DNS (127.0.0.11) + a variable in
# proxy_pass so nginx re-resolves "api" on every request instead of
# caching the IP at startup. Without this, restarting the api
# container assigns it a new IP and nginx keeps trying the old one
# (502 Bad Gateway / "Connection refused" while connecting to upstream).
RUN printf 'server {\n  listen 80;\n  server_name _;\n  root /usr/share/nginx/html;\n  index index.html;\n  client_max_body_size 10240m;\n  resolver 127.0.0.11 valid=30s ipv6=off;\n  location /api/ {\n    set $upstream_api "api:8000";\n    rewrite ^/api/(.*)$ /$1 break;\n    proxy_pass http://$upstream_api;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_read_timeout 1800s;\n  }\n  location = /index.html {\n    add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0";\n    expires off;\n    try_files /index.html =404;\n  }\n  location /assets/ {\n    add_header Cache-Control "public, max-age=31536000, immutable";\n    try_files $uri =404;\n  }\nlocation / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
