FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Must be set before `next build`, Next.js inlines NEXT_PUBLIC_* variables
# into the client bundle at build time; setting this later (e.g. as a
# runtime `environment:` in docker-compose.yml) would have no effect.
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
