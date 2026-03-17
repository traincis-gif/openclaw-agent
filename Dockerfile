FROM node:22-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY agent.js .
CMD ["node", "agent.js"]
