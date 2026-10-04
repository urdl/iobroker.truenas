/**
 * Recon-Testskript für @truenas/api-client
 * Liest Credentials aus /home/richie/credentials/truenas-iobroker-api.credentials
 * Format: TRUENAS_HOST="..." TRUENAS_USER="..." TRUENAS_API_KEY="..."
 *
 * Aufruf: node scripts/recon-api.mjs
 * Voraussetzung: npm install @truenas/api-client rxjs  (im Projektverzeichnis)
 */

// Self-signed cert on TrueNAS — nur für Recon/Entwicklung
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createTrueNasClient } from '@truenas/api-client';
import { firstValueFrom } from 'rxjs';

// --- Credentials laden ---
function loadCredentials(path) {
    const raw = readFileSync(path, 'utf8');
    const result = {};
    for (const line of raw.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim().replace(/\r$/, '');
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (key) result[key] = val;
    }
    return result;
}

const creds = loadCredentials('/home/richie/credentials/truenas-iobroker-api.credentials');
const host = creds.TRUENAS_HOST ?? '192.168.1.115';
const user = creds.USER ?? 'root';
const apiKey = creds['API-Key'];

if (!apiKey) {
    console.error('API-Key fehlt in credentials-Datei');
    process.exit(1);
}

// --- Client verbinden ---
console.log(`Verbinde mit ${host} ...`);
const client = await createTrueNasClient({
    uuid: 'iobroker-truenas-recon',
    hostnames: [host],
    enabled: true,
});

await firstValueFrom(client.authenticator.loginWithApiKey({ username: user, key: apiKey }));
console.log('Auth OK\n');

// --- Hilfsfunktion ---
async function probe(label, fn) {
    process.stdout.write(`[${label}] `);
    try {
        const result = await fn();
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.log(`ERROR: ${e.message}`);
    }
    console.log('---');
}

// --- System-Info ---
await probe('system.info', () =>
    firstValueFrom(client.api.call('system.info'))
);

// --- Pool-Status ---
await probe('pool.query', () =>
    firstValueFrom(client.api.query('pool.query'))
);

// --- Dataset-Nutzung (Top-Level) ---
await probe('pool.dataset.query (top-level)', () =>
    firstValueFrom(client.api.query('pool.dataset.query', [['id', '!^', '/']], { extra: { flat: false } }))
);

// --- Disk-Liste + Temps ---
await probe('disk.query', () =>
    firstValueFrom(client.api.query('disk.query'))
);

// --- SMART-Ergebnisse ---
await probe('smart.test.results (alle)', () =>
    firstValueFrom(client.api.query('smart.test.results'))
);

// --- System-Temperaturen ---
await probe('reporting.get_data (cpu temp)', () =>
    firstValueFrom(client.api.call('reporting.get_data', [{
        graphs: [{ name: 'cputemp' }],
        reporting_query: { unit: 'MINUTE', page: 1 }
    }]))
);

client.close();
console.log('\nFertig.');
