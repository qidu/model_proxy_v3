# Consul Cli Installation
Refer to https://developer.hashicorp.com/consul/install

# Consul Server Setup

Refer to https://www.atlantic.net/vps-hosting/how-to-install-consul-server-on-ubuntu/

## Step 1 - Install Consul

Install the required packages, download the Consul binary, unzip it, move it into `/usr/bin` or `/usr/local/bin`, and verify the version with `consul --version`.

Example commands:

```bash
apt-get update -y
apt-get install unzip gnupg2 curl wget -y
wget https://releases.hashicorp.com/consul/1.21.0/consul_1.21.0_linux_amd64.zip
unzip consul_1.21.0_linux_amd64.zip
mv consul /usr/local/bin/
consul --version
```

## Step 2 - Create the Consul service

Create a dedicated `consul` user and group, then prepare the data and config directories:

```bash
groupadd --system consul
useradd -s /sbin/nologin --system -g consul consul
mkdir -p /var/lib/consul
mkdir /etc/consul.d
chown -R consul:consul /var/lib/consul /etc/consul.d
chmod -R 775 /var/lib/consul
```

Create a systemd service file such as `/etc/systemd/system/consul.service` and run Consul in server mode with the config directory and data directory you created.

After saving the service file, reload systemd:

```bash
systemctl daemon-reload
```

## Step 3 - Configure the Consul server

Generate an encryption key, create `/etc/consul.d/config.json`, and set the server IP, node name, data directory, and encryption key.

Example:

```bash
consul keygen
nano /etc/consul.d/config.json
```

A minimal server config includes:

- `bootstrap: true`
- `server: true`
- `datacenter`
- `bind_addr`
- `node_name`
- `data_dir`
- `encrypt`

Then start and enable the service:

```bash
systemctl start consul
systemctl enable consul
```

You can confirm Consul is listening on port `8500` after startup.
