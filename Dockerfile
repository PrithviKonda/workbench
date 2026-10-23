FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY .github/scripts .github/scripts
RUN npm ci
COPY . .
# Packaged, so the app runs as a release build (unpackaged it opens DevTools and calls itself "Workbench Dev")
RUN npm run build && npx electron-builder --linux dir && mv dist/linux*-unpacked /workbench

FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 libatk1.0-0 \
      libdrm2 libxkbcommon0 libxkbfile1 libsecret-1-0 libcups2 libxcomposite1 libxdamage1 \
      libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation fonts-noto-color-emoji \
      git gh python3 xterm xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/* \
    && echo '<meta http-equiv="refresh" content="0;url=vnc.html?autoconnect=true&resize=scale">' > /usr/share/novnc/index.html
RUN npm i -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force

COPY --from=build /workbench /opt/workbench
COPY docker/start.sh /usr/local/bin/start.sh
# No browser in the container: Codex signs in with a device code (Settings > Accounts opens it in xterm)
ENV WORKBENCH_CODEX_DEVICE_AUTH=1
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace

EXPOSE 6080
CMD ["start.sh"]
