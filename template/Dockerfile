FROM node:22-alpine

WORKDIR /app

# Copy package manifest first (keeps layer caching idiomatic for when deps are added).
COPY --chown=node:node package.json ./
# No dependencies yet. When you add some, uncomment:
# RUN npm install --omit=dev

# App files. --chown keeps db.json writable by the non-root `node` user
# (the app rewrites db.json on POST/PUT/DELETE).
COPY --chown=node:node core.js db.json docs.txt ./

ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "core.js"]
