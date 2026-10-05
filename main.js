'use strict';

const utils = require('@iobroker/adapter-core');
const TrueNasClient = require('./lib/truenas-client');

class Truenas extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	constructor(options) {
		super({ ...options, name: 'truenas' });
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this._client = null;
		this._pollTimer = null;
	}

	async onReady() {
		this.setState('info.connection', false, true);

		const { host, username, apiKey, pollInterval, allowSelfSigned } = this.config;

		if (!host || !apiKey) {
			this.log.error('Configuration incomplete: host and API key are required');
			this.terminate('INVALID_ADAPTER_CONFIG', utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		this._client = new TrueNasClient({
			host,
			username: username || 'root',
			apiKey,
			allowSelfSigned: allowSelfSigned !== false,
			log: this.log,
		});

		await this._connect();

		const interval = Math.max(10, Number(pollInterval) || 60) * 1000;
		this._pollTimer = this.setInterval(() => this._poll(), interval);
	}

	async _connect() {
		try {
			await this._client.connect();
			this.setState('info.connection', true, true);
			await this._poll();
		} catch (err) {
			this.setState('info.connection', false, true);
			this.log.error(`Connection failed: ${err.message}`);
		}
	}

	async _poll() {
		if (!this._client || !this._client.connected) {
			this.setState('info.connection', false, true);
			this.log.warn('Not connected, attempting reconnect...');
			try {
				await this._client.connect();
				this.setState('info.connection', true, true);
			} catch (err) {
				this.log.error(`Reconnect failed: ${err.message}`);
				return;
			}
		}

		try {
			const data = await this._client.fetchAll();
			await this._updateStates(data);
		} catch (err) {
			this.setState('info.connection', false, true);
			this.log.error(`Poll failed: ${err.message}`);
			this._client.disconnect();
		}
	}

	/**
	 * @param {import('./lib/truenas-client').TrueNasData} data
	 */
	async _updateStates(data) {
		const { systemInfo, pools, diskList, diskTemps, datasets, cpuTempResult } = data;

		// --- system ---
		await this._ensureChannel('system', 'System');
		await this._setStateObj('system.hostname', 'Hostname', 'string', 'info.ip', systemInfo.hostname);
		await this._setStateObj('system.version', 'TrueNAS version', 'string', 'text', systemInfo.version);
		await this._setStateObj(
			'system.uptime',
			'Uptime (seconds)',
			'number',
			'value',
			Math.round(systemInfo.uptime_seconds),
		);

		if (cpuTempResult && Array.isArray(cpuTempResult) && cpuTempResult[0]?.aggregations) {
			const agg = cpuTempResult[0].aggregations;
			if (agg.mean?.cpu != null) {
				await this._setStateObj(
					'system.cpuTemp',
					'CPU temperature (°C)',
					'number',
					'value.temperature',
					Math.round(agg.mean.cpu),
				);
			}
			for (const [key, val] of Object.entries(agg.mean || {})) {
				if (key.startsWith('cpu') && key !== 'cpu' && val != null) {
					await this._setStateObj(
						`system.cpuTemp_${key}`,
						`CPU ${key} temperature (°C)`,
						'number',
						'value.temperature',
						Math.round(val),
					);
				}
			}
		}

		// --- pools ---
		await this._ensureChannel('pools', 'Pools');
		for (const pool of pools) {
			const safeId = this._safeId(pool.name);
			await this._ensureChannel(`pools.${safeId}`, pool.name);
			await this._setStateObj(`pools.${safeId}.name`, 'Pool name', 'string', 'text', pool.name);
			await this._setStateObj(`pools.${safeId}.healthy`, 'Pool healthy', 'boolean', 'indicator', pool.healthy);
			await this._setStateObj(`pools.${safeId}.status`, 'Pool status', 'string', 'text', pool.status);
			await this._setStateObj(
				`pools.${safeId}.statusCode`,
				'Pool status code',
				'string',
				'text',
				pool.status_code || '',
			);
			await this._setStateObj(`pools.${safeId}.size`, 'Pool size (bytes)', 'number', 'value.capacity', pool.size);
			await this._setStateObj(
				`pools.${safeId}.allocated`,
				'Allocated (bytes)',
				'number',
				'value.capacity',
				pool.allocated,
			);
			await this._setStateObj(`pools.${safeId}.free`, 'Free (bytes)', 'number', 'value.capacity', pool.free);
		}

		// --- datasets (top-level per pool only) ---
		await this._ensureChannel('datasets', 'Datasets');
		for (const ds of datasets) {
			const safeId = this._safeId(ds.id || ds.name);
			await this._ensureChannel(`datasets.${safeId}`, ds.id || ds.name);
			const used = ds.used?.parsed ?? ds.used?.value ?? null;
			const avail = ds.available?.parsed ?? ds.available?.value ?? null;
			if (used != null) {
				await this._setStateObj(`datasets.${safeId}.used`, 'Used (bytes)', 'number', 'value.capacity', used);
			}
			if (avail != null) {
				await this._setStateObj(
					`datasets.${safeId}.available`,
					'Available (bytes)',
					'number',
					'value.capacity',
					avail,
				);
			}
		}

		// --- disks ---
		await this._ensureChannel('disks', 'Disks');
		for (const disk of diskList) {
			if (disk.devname.startsWith('mmcblk')) {
				continue;
			}
			const safeId = this._safeId(disk.devname);
			await this._ensureChannel(`disks.${safeId}`, disk.devname);
			await this._setStateObj(`disks.${safeId}.model`, 'Model', 'string', 'text', disk.model || '');
			await this._setStateObj(`disks.${safeId}.serial`, 'Serial', 'string', 'text', disk.serial || '');
			await this._setStateObj(`disks.${safeId}.type`, 'Type', 'string', 'text', disk.type || '');
			await this._setStateObj(`disks.${safeId}.pool`, 'Pool assignment', 'string', 'text', disk.pool || '');

			const tempEntry = diskTemps[disk.devname];
			if (Array.isArray(tempEntry)) {
				const [temp, threshold] = tempEntry;
				if (temp != null) {
					await this._setStateObj(
						`disks.${safeId}.temperature`,
						'Temperature (°C)',
						'number',
						'value.temperature',
						temp,
					);
				}
				if (threshold != null) {
					await this._setStateObj(
						`disks.${safeId}.temperatureMax`,
						'Critical temperature (°C)',
						'number',
						'value.temperature',
						threshold,
					);
				}
			} else if (tempEntry != null) {
				await this._setStateObj(
					`disks.${safeId}.temperature`,
					'Temperature (°C)',
					'number',
					'value.temperature',
					tempEntry,
				);
			}
		}
	}

	/**
	 * Ensure a channel object exists.
	 *
	 * @param {string} id
	 * @param {string} name
	 */
	async _ensureChannel(id, name) {
		await this.extendObjectAsync(id, {
			type: 'channel',
			common: { name },
			native: {},
		});
	}

	/**
	 * Ensure state object exists (extendObject) and set its value.
	 *
	 * @param {string} id
	 * @param {string} name
	 * @param {'string'|'number'|'boolean'} type
	 * @param {string} role
	 * @param {*} val
	 */
	async _setStateObj(id, name, type, role, val) {
		await this.extendObjectAsync(id, {
			type: 'state',
			common: { name, type, role, read: true, write: false },
			native: {},
		});
		await this.setStateAsync(id, { val, ack: true });
	}

	/**
	 * Convert a raw name to a safe ioBroker state ID segment.
	 *
	 * @param {string} name
	 * @returns {string}
	 */
	_safeId(name) {
		return name.replace(/[^a-zA-Z0-9_-]/g, '_');
	}

	onUnload(callback) {
		try {
			if (this._pollTimer) {
				this.clearInterval(this._pollTimer);
				this._pollTimer = null;
			}
			if (this._client) {
				this._client.disconnect();
				this._client = null;
			}
			this.setState('info.connection', false, true);
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = options => new Truenas(options);
} else {
	new Truenas();
}
