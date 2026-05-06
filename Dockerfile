FROM node:20-alpine

# Install system dependencies
RUN apk add --no-cache \
    ffmpeg \
    git \
    python3 \
    py3-pip \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    ttf-dejavu \
    curl \
    bash

# Upgrade pip and install latest yt-dlp
RUN python3 -m ensurepip --upgrade 2>/dev/null || true && \
    python3 -m pip install --upgrade pip --break-system-packages 2>/dev/null || true && \
    pip3 install -U yt-dlp --break-system-packages && \
    yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

RUN mkdir -p temp logs database/sessions database/temp src/media

EXPOSE 3000

CMD ["node", "start.js"]
