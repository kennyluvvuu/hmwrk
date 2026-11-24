# hmwrk core image (SPEC §9). Build context: repository root.
#
# There is no build step by design: the runtime is `tsx src/index.ts`
# (package.json `start`), `tsc` is used for typechecking only and never in the
# image. This is why tsx — a devDependency — has to exist in the runtime image.
FROM node:22-slim

WORKDIR /app

# `tsx` is a devDependency, but `npm start` needs it in the image. We install
# the full tree (`npm ci`, no --omit=dev) on purpose: typescript and vitest add
# ~60 MB that the runtime never uses, but it is the only install that stays
# driven by package-lock.json alone. The leaner alternative (npm ci --omit=dev,
# then `npm i --no-save tsx@<lock version>`) does NOT work: npm resolves the
# explicit tsx request back to the lockfile's devDependency and then omits it,
# so the image ends up without a runtime. A second, global tsx install would
# introduce a dependency tree the lockfile does not govern. Hence: one command,
# one source of truth; size is irrelevant on a home server next to OpenWebUI.
COPY package.json package-lock.json ./
RUN npm ci \
 && npm cache clean --force

# Only sources go in. models.json is config and lives in the data volume
# (DATA_DIR/models.json or MODELS_CONFIG), never in the image.
COPY tsconfig.json ./
COPY src ./src

# Data dir for SQLite + photos; the hmwrk-data named volume is mounted here.
# Created before the volume mount so an empty named volume inherits node's
# ownership and the non-root process can write to it.
RUN mkdir -p /data && chown node:node /data
USER node

# HOME must point at the node user's own directory: npm writes its cache/logs
# under $HOME, and the image default (/root) is not writable for uid 1000.
ENV NODE_ENV=production \
    HOME=/home/node \
    PORT=8787 \
    DATA_DIR=/data

EXPOSE 8787

# node:22-slim has no curl/wget, so the probe uses Node's global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
