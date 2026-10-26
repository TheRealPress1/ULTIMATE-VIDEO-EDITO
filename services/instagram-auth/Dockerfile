FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json broker.mjs server.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
