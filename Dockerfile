FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY tools ./tools

# The proxy refuses to bind 0.0.0.0 without PROXY_API_KEY.
ENV HOST=0.0.0.0
ENV PORT=9270
ENV TOKENS_FILE=/data/tokens.txt
ENV SESSIONS_FILE=/data/sessions.json

VOLUME ["/data"]
EXPOSE 9270

# docker run -d -p 127.0.0.1:9270:9270 \
#   -e PROXY_API_KEY=change-me \
#   -e DEEPSEEK_TOKEN=your-token \
#   deepseek4free
#
# or mount a tokens file instead of DEEPSEEK_TOKEN:
#   -v "$PWD/tokens.txt:/data/tokens.txt:ro"
CMD ["node", "src/index.js"]