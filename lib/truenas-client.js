'use strict';

const { createTrueNasClient } = require('@truenas/api-client');
const { firstValueFrom } = require('rxjs');

/** Thin wrapper around `@truenas/api-client` for the ioBroker adapter. */
class TrueNasClient {
	/**
	 * @param {object} opts options
	 * @param {string} opts.host TrueNAS hostname or IP
	 * @param {string} opts.username TrueNAS username the API key belongs to
	 * @param {string} opts.apiKey TrueNAS API key
	 * @param {boolean} opts.allowSelfSigned whether to accept self-signed certs
	 * @param {object} opts.log ioBroker logger
	 */
	constructor(opts) {
		this.opts = opts;
		this.log = opts.log;
		this._client = null;
		this._connected = false;
	}

	/** @returns {boolean} whether the client is currently logged in */
	get connected() {
		return this._connected;
	}

	/** Connect to TrueNAS and authenticate with the API key. */
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

	/** Close the connection. */
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
	 * @returns {Promise<object>} raw data from TrueNAS
	 */
	async fetchAll() {
		const c = this._client;

		const [systemInfo, pools, diskList, cpuTempResult, cpuUsageResult, alerts] = await Promise.all([
			firstValueFrom(c.api.call('system.info')),
			firstValueFrom(c.api.query('pool.query')),
			firstValueFrom(c.api.query('disk.query')),
			firstValueFrom(c.api.call('reporting.get_data', [[{ name: 'cputemp' }], { unit: 'HOUR', page: 1 }])).catch(
				() => null,
			),
			firstValueFrom(c.api.call('reporting.get_data', [[{ name: 'cpu' }], { unit: 'HOUR', page: 1 }])).catch(
				() => null,
			),
			firstValueFrom(c.api.call('alert.list')).catch(() => []),
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

		// Successful logins since start of current year, per real (non-builtin) user.
		// TrueNAS rejects querying more than one audit database in a single call
		// ("Querying more than one audit database in a single request is not
		// supported"), so MIDDLEWARE (WebUI/API) and SMB need separate requests.
		// A single global top-N query (sorted by recency) was tried first, but a
		// handful of accounts (e.g. a Nextcloud sync user re-authenticating every
		// few seconds) flood the result and push infrequent users out of the
		// window entirely - scoping each query to one username avoids that.
		const yearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
		const realUsers = await firstValueFrom(
			c.api.query(
				'user.query',
				[
					['local', '=', true],
					['builtin', '=', false],
				],
				{ select: ['username'] },
			),
		).catch(() => []);
		const queryLogins = (services, username) =>
			firstValueFrom(
				c.api.call('audit.query', [
					{
						services,
						'query-filters': [
							['event', '=', 'AUTHENTICATION'],
							['success', '=', true],
							['username', '=', username],
							['message_timestamp', '>=', yearStart],
						],
						'query-options': { limit: 500, order_by: ['-message_timestamp'] },
					},
				]),
			).catch(() => []);
		// TrueNAS caps concurrent calls per session at 20; stay well under that
		// instead of firing one request per user*service at once.
		const loginJobs = realUsers.flatMap(u => [
			() => queryLogins(['MIDDLEWARE'], u.username),
			() => queryLogins(['SMB'], u.username),
		]);
		const perUserLogins = [];
		const concurrency = 10;
		for (let i = 0; i < loginJobs.length; i += concurrency) {
			const batch = await Promise.all(loginJobs.slice(i, i + concurrency).map(job => job()));
			perUserLogins.push(...batch);
		}
		// main.js relies on newest-first order to find each user's most recent login.
		const userLogins = perUserLogins.flat().sort((a, b) => b.message_timestamp - a.message_timestamp);

		return {
			systemInfo,
			pools,
			diskList,
			diskNames,
			diskTemps,
			datasets,
			cpuTempResult,
			cpuUsageResult,
			userLogins,
			alerts,
		};
	}
}

module.exports = TrueNasClient;
