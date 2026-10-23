#!/bin/sh
set -e

# No host DISPLAY (Linux X11 / WSLg / XQuartz): run a virtual one and serve it over noVNC on 6080
if [ -z "$DISPLAY" ]; then
  export DISPLAY=:99
  Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp &
  sleep 1
  x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet &
  websockify --web /usr/share/novnc 6080 localhost:5900 &
fi

if [ -n "$OPENAI_API_KEY" ] && [ ! -f "$HOME/.codex/auth.json" ]; then
  printenv OPENAI_API_KEY | codex login --with-api-key
fi

# The container is the sandbox, and there is no keyring inside it
exec /opt/workbench/workbench --no-sandbox --disable-gpu --password-store=basic --ozone-platform=x11
