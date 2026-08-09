# A second service exists for exactly one reason: a trace with one service in it
# teaches you nothing about distributed tracing. This is the "third party payment
# gateway" that orders-api calls over HTTP, so you can watch context propagate
# across a process boundary and see whose latency is whose.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN apk add --no-cache curl

CMD ["npx", "tsx", "src/index.ts"]
