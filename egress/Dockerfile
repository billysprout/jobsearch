# Minimal squid egress allowlist proxy.
# Built locally (no third-party proxy image) to keep the supply chain short:
# base = pinned alpine minor, one apk package, one config file.
FROM alpine:3.22

RUN apk add --no-cache squid

COPY squid.conf /etc/squid/squid.conf

# Foreground, unprivileged, no disk cache (cache deny all), stdio logging.
USER squid
EXPOSE 3128

ENTRYPOINT ["squid", "-N", "-d", "1", "-f", "/etc/squid/squid.conf"]
