![Logo](admin/truenas.png)

# ioBroker.truenas

Monitor **TrueNAS SCALE** devices from ioBroker via the official JSON-RPC 2.0 WebSocket API.

Polls system info, pool health, dataset usage, disk temperatures (SMART), CPU load/temperature, and user login history — no SSH, no scraping, no third-party dependencies beyond the official `@truenas/api-client`.

---

## Requirements

| Component | Minimum version |
|---|---|
| TrueNAS SCALE | 24.x or newer (tested: 25.10.x) |
| ioBroker js-controller | 6.0.11 |
| ioBroker admin adapter | 7.0.23 |
| Node.js | 18 |

---

## TrueNAS setup

### Create a dedicated user (recommended)

1. TrueNAS Web UI → **Credentials → Local Users → Add**
2. Username: e.g. `iobroker`, shell: `nologin`
3. Assign role **Sharing Admin** (gives read access to pools, datasets, disks, audit log)
4. Save

### Create an API Key

1. TrueNAS Web UI → **API Keys → Add**
2. Name: `iobroker`, assign to the user created above
3. Copy the generated key — it is shown only once

> If you use the built-in `root` / `truenas_admin` account instead of a dedicated user,
> everything works but is not recommended for least-privilege operation.

---

## Adapter configuration

| Field | Description |
|---|---|
| **Host** | TrueNAS hostname or IP address — without `https://` prefix (e.g. `truenas.local` or `192.168.1.115`) |
| **Username** | TrueNAS username that owns the API key (default: `root`) |
| **API Key** | The API key generated in TrueNAS (stored encrypted) |
| **Poll interval** | How often to fetch data in seconds (min 10, default 60) |
| **Allow self-signed certificates** | Enable when TrueNAS uses a self-signed TLS certificate (typical for home installations) |

---

## Collected states

### System (`truenas.0.system.*`)

| State | Type | Unit | Description |
|---|---|---|---|
| `hostname` | string | — | System hostname |
| `version` | string | — | TrueNAS version string |
| `uptime` | number | s | System uptime in seconds |
| `loadavg1` | number | — | CPU load average (1 min) |
| `loadavg5` | number | — | CPU load average (5 min) |
| `loadavg15` | number | — | CPU load average (15 min) |
| `cpuTemp` | number | °C | Mean CPU temperature (last hour) |
| `cpuTemp_cpu0` … `cpuTemp_cpuN` | number | °C | Per-core temperature |
| `cpuUsage` | number | % | Overall CPU utilisation (most recent sample) |
| `cpuUsage_cpu0` … `cpuUsage_cpuN` | number | % | Per-core CPU utilisation |

### Pools (`truenas.0.pools.<poolname>.*`)

One channel per ZFS pool.

| State | Type | Unit | Description |
|---|---|---|---|
| `name` | string | — | Pool name |
| `healthy` | boolean | — | `true` = pool is healthy |
| `status` | string | — | Pool status (ONLINE, DEGRADED, …) |
| `statusCode` | string | — | Status code detail |
| `size` | number | B | Total pool size |
| `allocated` | number | B | Used space |
| `free` | number | B | Free space |
| `usedPercent` | number | % | Used space as percentage |
| `freePercent` | number | % | Free space as percentage |

### Datasets (`truenas.0.datasets.<datasetid>.*`)

One channel per ZFS dataset (flat list, all datasets).

| State | Type | Unit | Description |
|---|---|---|---|
| `used` | number | B | Used bytes |
| `available` | number | B | Available bytes |
| `usedText` | string | — | Used space, human-readable (e.g. `1.23 GiB`) |
| `availableText` | string | — | Available space, human-readable |
| `usedPercent` | number | % | Used as percentage of (used + available) |
| `freePercent` | number | % | Available as percentage of (used + available) |

### Disks (`truenas.0.disks.<devname>.*`)

One channel per disk (eMMC/boot media excluded).

| State | Type | Unit | Description |
|---|---|---|---|
| `model` | string | — | Disk model |
| `serial` | string | — | Serial number |
| `type` | string | — | Disk type (HDD, SSD, …) |
| `pool` | string | — | Pool the disk is assigned to |
| `temperature` | number | °C | Current SMART temperature |
| `temperatureMax` | number | °C | Critical temperature threshold |

### Alerts (`truenas.0.alerts.*`)

TrueNAS's own alert system — hardware issues, pool problems, update/EOL notices, etc. Dismissed alerts are excluded.

| State | Type | Description |
|---|---|---|
| `count` | number | Number of active (non-dismissed) alerts |
| `highestLevel` | string | Highest severity among active alerts (`CRITICAL` > `ERROR` > `WARNING` > `NOTICE` > `INFO`), empty if none |
| `json` | string | Active alerts as a JSON array (`level`, `text`, `lastOccurrence`) |

### User logins (`truenas.0.users.*`)

Populated from the TrueNAS audit log (successful `AUTHENTICATION` events since 1 January of the current year), covering both WebUI/API logins **and SMB share logins** — so a user that only ever connects over SMB (e.g. an app mounting a share, never touching the TrueNAS WebUI) still shows up here.

Queried per real (non-builtin) local user rather than as one global "most recent N" query: TrueNAS doesn't allow combining the `MIDDLEWARE` (WebUI/API) and `SMB` audit databases in a single request, and a shared global limit would let a single high-frequency account (e.g. a sync client re-authenticating every few seconds over SMB) crowd out users who log in rarely. Per-user queries are batched at a concurrency of 10 to stay under TrueNAS's limit of 20 concurrent API calls per session.

#### Per user (`truenas.0.users.<username>.*`)

New users are added automatically on the next poll after their first login.

| State | Type | Description |
|---|---|---|
| `lastLogin` | string | ISO-8601 timestamp of the most recent successful login |
| `lastLoginAddress` | string | IP address of the most recent login |

#### Active user counts (`truenas.0.users.activeCount.*`)

Counts of **distinct users** who logged in at least once within the time window.

| State | Window |
|---|---|
| `last5min` | Last 5 minutes |
| `last1h` | Last 60 minutes |
| `last24h` | Last 24 hours |
| `thisMonth` | Since 1st of the current month |
| `last6months` | Since 6 months ago (1st of that month) |
| `thisYear` | Since 1 January of the current year |

---

## Connection indicator

`truenas.0.info.connection` — `true` while the adapter is connected to TrueNAS, `false` otherwise (also set to `false` on adapter stop or failed poll).

---

## Changelog

### 0.6.4 (2026-10-10)
* Fix crash on adapter shutdown while a poll cycle is still in flight: `onUnload()` nulls the client, and the still-running `_poll()`'s error handler then called `.disconnect()` on it, throwing an unhandled `TypeError` that crashed the process. Found while verifying the 0.6.3 fix on `iob-test`. See #4.

### 0.6.3 (2026-10-10)
* Fix poll loop hanging forever if a TrueNAS API call never responds: all WebSocket calls in `fetchAll()` now have a 20s timeout instead of blocking indefinitely. Also stopped awaiting the initial poll inside `_connect()`, so a hung first cycle can no longer prevent the recurring poll timer from ever being set up. Closes #4.

### 0.6.2 (2026-10-10)
* Add `enableUserLogins` setting (checkbox) to disable per-user SMB/WebUI login tracking, reducing API calls per poll cycle for users who don't need the `users.*` states

### 0.6.1 (2026-10-07)
* Fix periodic disconnects: `setInterval` fired the next poll cycle even while the previous one was still running, stacking concurrent TrueNAS calls past the middleware's 20-per-session limit and causing repeated "Maximum number of concurrent calls (20) has exceeded" reconnects. An in-flight guard now skips a cycle instead of overlapping it.

### 0.6.0 (2026-10-06)
* Add TrueNAS alert monitoring (`truenas.0.alerts.*`)

### 0.5.0 (2026-10-06)
* First tagged GitHub release — no functional changes since 0.0.1 below

### 0.0.1 (2026-10-05)
* Initial release: system info, pools, datasets, disks, CPU temp/load/usage, user login tracking
* User logins now also cover SMB share logins, not just WebUI/API (queried per user to avoid high-frequency accounts crowding out infrequent ones)

---

## License

MIT License

Copyright (c) 2026 U.R.D.L <claude@preindl.at>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
