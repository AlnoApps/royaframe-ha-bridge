# RoyaFrame Bridge Add-on Dockerfile
ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install Node.js
RUN apk add --no-cache nodejs npm

# Copy and install Node application
WORKDIR /app/bridge
COPY bridge/package.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY bridge/src ./src
COPY bridge/public ./public

# Verify Node app exists
RUN test -f /app/bridge/src/server.js || (echo "ERROR: server.js not found" && exit 1)

# Copy s6-overlay service definitions
COPY rootfs /

# Force executable permissions on s6 scripts
RUN chmod 755 /etc/services.d/royaframe_bridge/run && \
    chmod 755 /etc/services.d/royaframe_bridge/finish

# Verify s6 scripts are in place and executable
RUN ls -la /etc/services.d/royaframe_bridge/ && \
    test -x /etc/services.d/royaframe_bridge/run || (echo "ERROR: run not executable" && exit 1)

# Labels
LABEL \
    io.hass.name="RoyaFrame Bridge" \
    io.hass.description="Local bridge between Home Assistant and RoyaFrame" \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="amd64|aarch64"
