FROM node:20-alpine

# Install dependencies including git
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
    ttf-dejavu

# Ensure pip3 is available on any platform/base image
RUN python3 -m ensurepip --upgrade 2>/dev/null || true && \
    python3 -m pip install --upgrade pip 2>/dev/null || true && \
    (command -v pip3 || ln -sf $(command -v pip) /usr/local/bin/pip3 || \
     ln -sf $(python3 -c "import sys; print(sys.executable.replace('python3','pip3'))") /usr/local/bin/pip3 2>/dev/null || true)

WORKDIR /app

COPY package*.json ./
RUN npm install --production --legacy-peer-deps
RUN pip3 install --upgrade yt-dlp --break-system-packages

COPY . .

RUN mkdir -p temp logs database/sessions src/media

EXPOSE 3000

# CMD ["node", "start.js"]
CMD ["node", "connect.js"]