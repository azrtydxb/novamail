# Bare-metal (systemd) deployment

The data-plane binaries run as plain systemd services. Postgres and RabbitMQ are
prerequisites (install separately or point at existing instances).

```
# 1. Build the binaries (or copy from CI artifacts)
task build                      # -> bin/ingress, bin/delivery, bin/dsn
sudo install -m755 bin/ingress  /usr/local/bin/novamail-ingress
sudo install -m755 bin/delivery /usr/local/bin/novamail-delivery
sudo install -m755 bin/dsn      /usr/local/bin/novamail-dsn

# 2. User, dirs, config
sudo useradd --system --no-create-home novamail || true
sudo mkdir -p /var/lib/novamail/bodies /etc/novamail
sudo chown -R novamail:novamail /var/lib/novamail
sudo cp novamail.env.example /etc/novamail/novamail.env   # then edit

# 3. Install + apply migrations
psql "$DSN" -f ../../migrations/0001_init.sql   # ...and 0002..0004 in order

# 4. Units
sudo cp novamail-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now novamail-ingress novamail-delivery novamail-dsn
```

For multiple hosts, run `novamail-ingress` and `novamail-delivery` on as many
nodes as you like — they coordinate through Postgres + RabbitMQ. The body store
(`NOVAMAIL_BODY_STORE`) must be a shared filesystem (NFS) across hosts.
