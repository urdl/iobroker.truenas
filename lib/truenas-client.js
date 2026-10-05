'use strict';

const { createTrueNasClient } = require('@truenas/api-client');
const { firstValueFrom } = require('rxjs');

class TrueNasClient {
	/**
	 * @param {object} opts
	 * @param {string} opts.host
	 * @param {string} opts.username
	 * @param {string} opts.apiKey
	 * @param {boolean} opts.allowSelfSigned
	 * @param {object} opts.log  ioBroker logger
	 */
	constructor(opts) {
		this.opts = opts;
		this.log = opts.log;
		this._client = null;
		this._connected = false;
	}

	get connected() {
		return this._connected;
	}

	async connect() {
		if (this.opts.allowSelfSigned) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		} else {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		}
		this._client = await createTrueNasClient({
			uuid: 'iobroker-truenas',
			hostnames: [this.opts.host],
			enabled: true,
		});

		await firstValueFrom(
			this._client.authenticator.loginWithApiKey({
				username: this.opts.username,
				key: this.opts.apiKey,
			}),
		);

		this._connected = true;
		this.log.info(`Connected to TrueNAS at ${this.opts.host}`);
	}

	disconnect() {
		if (this._client) {
			try {
				this._client.close();
			} catch {
				// ignore
			}
			this._client = null;
		}
		this._connected = false;
	}

	/**
	 * Fetch all monitored data in one pass.
	 *
	 * @returns {Promise<object>}
	 */
	async fetchAll() {
		const c = this._client;

		const [systemInfo, pools, diskList, cpuTempResult] = await Promise.all([
			firstValueFrom(c.api.call('system.info')),
			firstValueFrom(c.api.query('pool.query')),
			firstValueFrom(c.api.query('disk.query')),
			firstValueFrom(c.api.call('reporting.get_data', [[{ name: 'cputemp' }], { unit: 'HOUR', page: 1 }])).catch(
				() => null,
			),
		]);

		// Disk temperatures for all non-boot disks
		const diskNames = diskList.filter(d => !d.devname.startsWith('mmcblk')).map(d => d.devname);

		const diskTemps = diskNames.length
			? await firstValueFrom(c.api.call('disk.temperatures', [diskNames, true])).catch(() => ({}))
			: {};

		// Top-level datasets (flat list)
		const datasets = await firstValueFrom(c.api.query('pool.dataset.query', [], { extra: { flat: true } })).catch(
			() => [],
		);

		return { systemInfo, pools, diskList, diskNames, diskTemps, datasets, cpuTempResult };
	}
}

module.exports = TrueNasClient;
