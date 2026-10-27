FROM ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e AS proxy
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN apt-get update && apt-get install --no-install-recommends -y iproute2 tinyproxy-bin && rm -rf /var/lib/apt/lists/*
COPY --from=proxy /toxiproxy /usr/local/bin/toxiproxy
WORKDIR /probe
COPY boot.mjs tinyproxy.conf ./
ENV LOG_LEVEL=error
CMD ["node", "boot.mjs"]
