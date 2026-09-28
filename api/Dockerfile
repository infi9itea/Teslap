FROM node:20-slim

# node:20-slim ships without OpenSSL, and Prisma needs it to pick the right
# query/schema engine binary. Without this, `prisma migrate deploy` fails
# with "Schema engine error" inside the container. Must be installed BEFORE
# `prisma generate` so the correct engine gets downloaded.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx prisma generate

EXPOSE 4000

CMD ["node", "src/main.js"]
