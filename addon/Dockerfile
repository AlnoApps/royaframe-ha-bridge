# RoyaFrame Bridge Add-on Dockerfile
# Uses Home Assistant base image with s6-overlay

ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install Node.js
RUN apk add --no-cache nodejs npm

# Set working directory
WORKDIR /app

# Copy bridge application
COPY bridge/package.json /app/
RUN npm install --omit=dev

COPY bridge/src /app/src
COPY bridge/public /app/public

# Copy s6-overlay service definitions and set executable permissions
COPY rootfs /
RUN chmod +x /etc/services.d/royaframe_bridge/run /etc/services.d/royaframe_bridge/finish

# Labels for Home Assistant
LABEL \
    io.hass.name="RoyaFrame Bridge" \
    io.hass.description="Local bridge between Home Assistant and RoyaFrame" \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="amd64|aarch64"
