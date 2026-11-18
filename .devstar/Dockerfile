FROM node:24-alpine

RUN apk add --no-cache ca-certificates git

WORKDIR /workspace
COPY . .

ENTRYPOINT ["sh", ".devstar/entrypoint.sh"]
