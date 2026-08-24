# Tiny TCP forwarder: publishes the loopback port for the gateway, which sits
# on the sealed internal network (published ports don't work on internal
# networks, by design). Dual-homed: internal (to reach the gateway) + egress
# (a normal bridge network so Docker can publish the host port).
# Accepts inbound only; relays to openclaw-gateway:18789. No data path out.
FROM alpine:3.22

RUN apk add --no-cache socat

USER nobody

EXPOSE 18789

ENTRYPOINT ["socat", "TCP-LISTEN:18789,fork,reuseaddr", "TCP:openclaw-gateway:18789"]
