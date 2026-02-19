FROM node:20-alpine AS base

WORKDIR /app

COPY package*.json ./
COPY scripts ./scripts
RUN npm install

COPY . .

FROM base AS dev

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM base AS build

RUN npm run build

FROM nginx:1.27-alpine AS prod

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
