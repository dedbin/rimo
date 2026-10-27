FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=pwuser:pwuser tsconfig.json ./
COPY --chown=pwuser:pwuser LICENSE ./LICENSE
COPY --chown=pwuser:pwuser public/licenses/FONT-NOTICES.txt ./licenses/FONT-NOTICES.txt
COPY --chown=pwuser:pwuser export-worker ./export-worker
COPY --chown=pwuser:pwuser lib/board ./lib/board
COPY --chown=pwuser:pwuser types ./types
ENV NODE_ENV=production PDF_WORKER_HOST=0.0.0.0 PDF_WORKER_PORT=3100
USER pwuser
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import=tsx", "export-worker/index.ts"]
