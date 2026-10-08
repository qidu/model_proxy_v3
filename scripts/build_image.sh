git describe --tags --abbrev=0 > /tmp/proxy_version && \
    git branch | grep "*" >> /tmp/proxy_version && \
    git rev-parse --short HEAD >> /tmp/proxy_version

VERSION=$(cat /tmp/proxy_version | tr -d '\n')

sudo docker build -t model-proxy-v3 .
