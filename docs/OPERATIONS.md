# Operating R9K

The Compose stack, backup/restore scripts and deploy workflow were written without
a Docker host to test on. Validate them on a disposable host before production.
Run exactly one bot instance per token. CI only publishes images; it has no server
access. Set the GHCR package visibility to public for unauthenticated pulls, or
log the server into GHCR with a read-only packages credential.

## VPS setup

1. Provision a Linux VPS (2 CPUs, 2–4 GB RAM), configure SSH keys and a firewall
   allowing only SSH. Enable automatic security updates. Use an encrypted disk
   or encrypted provider volume; backups are encrypted separately. Protect the
   running host too: disk encryption does not prevent privileged live access.
2. Install Docker Engine and the Compose plugin using the official instructions
   for your distribution: <https://docs.docker.com/engine/install/>. Use a recent
   Compose release supporting `!reset`. Install git, age, gzip and util-linux
   (flock) through your distribution package manager.
3. `git clone https://github.com/NocturnalAviator/R9K.git && cd R9K`.
4. Create `.env` locally from `.env.example`, mode 600. Supply a BotFather token,
   a strong URL-safe POSTGRES_PASSWORD, and optional ALERT_CHAT_ID and PRIVACY_URL.
   Never commit secrets. Fill in the policy's operator contact before launch.
5. Run `docker compose -f compose.yaml -f compose.prod.yaml pull`, then
   `docker compose -f compose.yaml -f compose.prod.yaml up -d`.
6. Inspect `docker compose ps` and logs. Add the bot to a test supergroup with
   delete/restrict rights and verify commands. Neither PostgreSQL nor the health
   port is published on the host. Container logs rotate at 10 MB, three files.

## Updates and recovery

Pushes to main run checks and publish `latest` and the commit SHA to GHCR with
GITHUB_TOKEN. On the server, back up first, `git pull --ff-only`, then run the
pull and up commands above. Migrations run at startup. Pin the image to a tested
SHA for controlled releases. Rollbacks may require restoring the matching backup;
do not assume old code understands newer schema.

## Backups

Generate an age identity on a secure machine (`age-keygen`); place only its public
recipient on the server. Export BACKUP_AGE_RECIPIENT and BACKUP_DIR before running
`scripts/backup.sh`. It streams pg_dump from Compose db through gzip and age,
atomically publishes a UTC-dated file and retains the newest 14 local files.
Concurrent runs are locked. No plaintext backup file is created by backup.sh.

For cron, put exports in a root/operator-owned mode-600 shell file outside the
repository (for example `/etc/r9k-backup.conf`), then use:

```cron
0 3 * * * /bin/bash -c 'source /etc/r9k-backup.conf; /srv/R9K/scripts/backup.sh' >> /var/log/r9k-backup.log 2>&1
```

Copy successful encrypted files off-site with your provider's tool or rsync to a
separate host. Monitor cron failures and backup age, enforce off-site expiration,
and test restores regularly. Keep the age private identity separately.

To restore, export BACKUP_AGE_IDENTITY pointing to the private key, then run
`scripts/restore.sh /path/to/backup.sql.gz.age` and type RESTORE. It decrypts and
validates gzip into a private temporary plaintext file, stops the bot, replaces
the database, imports with errors fatal and starts the bot only on success.
Ensure temporary storage is encrypted. On failure the bot stays stopped for
manual recovery. Reapply privacy deletion requests made since the backup.

## Monitoring and alerts

HEALTH_PORT enables GET /healthz on 0.0.0.0. It reports 200 only when SELECT 1
succeeds and polling or processed-update activity is younger than two minutes;
otherwise 503. Compose probes the internal port 8080 without publishing it.
An empty successful getUpdates cycle counts as activity. Initial status is 503.

For an uptime ping, run a host timer that executes the internal health probe and
calls your monitoring service's heartbeat URL only on success. Store that URL
privately. Alert on missing heartbeats and unhealthy containers; Docker health
status alone does not restart a container. Do not expose an unauthenticated
health port publicly just for monitoring.

Start a private conversation with the bot, obtain your numeric chat id using a
trusted client, and set ALERT_CHAT_ID. Restart the bot. Error-boundary and job
failures send sanitized error categories, never exception messages or content.
Alerts are limited to one per minute with the suppressed count in the next alert.
If alert delivery fails, check container logs and external monitoring.

## Scheduling and data

Weekly leaderboards default off; enable them in Settings → Memory. The job runs
every ten minutes on Monday after 09:00 UTC for the previous ISO week. The database
claim is saved before delivery: restarts cannot duplicate a post, but a crash or
ambiguous network failure after claiming can skip that week's post. There is no
automatic retry. A whole Monday outage also skips that week.

Retention uses independently committed batches of at most 500 rows per mutation.
Chat removal uses cascading deletion after seven days. Lifetime score history
has no text and supports correcting old edits; /forgetme and chat purge erase it.
Edits adjust the original message's week, and recalculate streaks in original
message order. Weekly output shows the current lifetime streak. Migration reconstructs scores from stored message classifications and strike audit records. Older repeats whose audit records are missing cannot be reconstructed. See [the privacy policy](PRIVACY.md) for all retention periods.
