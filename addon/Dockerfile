# RoyaFrame Bridge Add-on Dockerfile
ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install Node.js
RUN apk add --no-cache nodejs npm

# Copy bridge application
WORKDIR /app/bridge
COPY bridge/package.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY bridge/src ./src
COPY bridge/public ./public

# Copy s6-overlay service definitions
COPY rootfs /

# Set executable permissions
RUN chmod 755 /etc/services.d/royaframe_bridge/run \
    && chmod 755 /etc/services.d/royaframe_bridge/finish

# Labels
LABEL \
    io.hass.name="RoyaFrame Bridge" \
    io.hass.description="Local bridge between Home Assistant and RoyaFrame" \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="amd64|aarch64"
