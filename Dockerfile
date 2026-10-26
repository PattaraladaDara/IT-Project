FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api
ARG VITE_KU_ALLLOGIN_URL=
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_KU_ALLLOGIN_URL=${VITE_KU_ALLLOGIN_URL}

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server

USER node

EXPOSE 3000

CMD ["npm", "start"]
