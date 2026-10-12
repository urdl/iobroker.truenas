'use strict';

const { createTrueNasClient } = require('@truenas/api-client');
const { firstValueFrom } = require('rxjs');

// A hung RPC (server never replies) would otherwise block fetchAll() forever -
// a .catch() only handles rejection, not a promise that never settles. See
// Forgejo issue #4.
const CALL_TIMEOUT_MS = 20000;

// Per-user audit.query calls (2 per real user) are expensive enough that
// running them every poll cycle can push TrueNAS past its 20-concurrent-calls
// session limit on its own, causing periodic disconnects - see issue #5
// (regression of #3). Login timestamps don't need poll-cycle granularity
// anyway, so only re-query every Nth cycle and serve the cached result the
// rest of the time.
const LOGIN_QUERY_EVERY_N_CYCLES = 5;

/**
 * @param {Promise<*>} promise promise to bound
 * @param {string} label used in the timeout error message
 * @returns {Promise<*>} the original promise, or a rejection if it doesn't settle within CALL_TIMEOUT_MS
 */
function withTimeout(promise, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${CALL_TIMEOUT_MS}ms: ${label}`)), CALL_TIMEOUT_MS);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Thin wrapper around `@truenas/api-client` for the ioBroker adapter. */
class TrueNasClient {
	/**
	 * @param {object} opts options
	 * @param {string} opts.host TrueNAS hostname or IP
	 * @param {string} opts.username TrueNAS username the API key belongs to
	 * @param {string} opts.apiKey TrueNAS API key
	 * @param {boolean} opts.allowSelfSigned whether to accept self-signed certs
	 * @param {boolean} opts.enableUserLogins whether to query per-user login history (every LOGIN_QUERY_EVERY_N_CYCLES polls)
	 * @param {object} opts.log ioBroker logger
	 */
	constructor(opts) {
		this.opts = opts;
		this.log = opts.log;
		this._client = null;
		this._connected = false;
		this._pollCycle = 0;
		this._cachedUserLogins = [];
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

		await withTimeout(
			firstValueFrom(
				this._client.authenticator.loginWithApiKey({
					username: this.opts.username,
					key: this.opts.apiKey,
				}),
			),
			'authenticator.loginWithApiKey',
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
			withTimeout(firstValueFrom(c.api.call('system.info')), 'system.info'),
			withTimeout(firstValueFrom(c.api.query('pool.query')), 'pool.query'),
			withTimeout(firstValueFrom(c.api.query('disk.query')), 'disk.query'),
			withTimeout(
				firstValueFrom(c.api.call('reporting.get_data', [[{ name: 'cputemp' }], { unit: 'HOUR', page: 1 }])),
				'reporting.get_data(cputemp)',
			).catch(() => null),
			withTimeout(
				firstValueFrom(c.api.call('reporting.get_data', [[{ name: 'cpu' }], { unit: 'HOUR', page: 1 }])),
				'reporting.get_data(cpu)',
			).catch(() => null),
			withTimeout(firstValueFrom(c.api.call('alert.list')), 'alert.list').catch(() => []),
		]);

		// Disk temperatures for all non-boot disks
		const diskNames = diskList.filter(d => !d.devname.startsWith('mmcblk')).map(d => d.devname);

		const diskTemps = diskNames.length
			? await withTimeout(
					firstValueFrom(c.api.call('disk.temperatures', [diskNames, true])),
					'disk.temperatures',
				).catch(() => ({}))
			: {};

		// Top-level datasets (flat list)
		const datasets = await withTimeout(
			firstValueFrom(c.api.query('pool.dataset.query', [], { extra: { flat: true } })),
			'pool.dataset.query',
		).catch(() => []);

		// Successful logins since start of current year, per real (non-builtin) user.
		// TrueNAS rejects querying more than one audit database in a single call
		// ("Querying more than one audit database in a single request is not
		// supported"), so MIDDLEWARE (WebUI/API) and SMB need separate requests.
		// A single global top-N query (sorted by recency) was tried first, but a
		// handful of accounts (e.g. a Nextcloud sync user re-authenticating every
		// few seconds) flood the result and push infrequent users out of the
		// window entirely - scoping each query to one username avoids that.
		let userLogins = this._cachedUserLogins;
		if (this.opts.enableUserLogins !== false && this._pollCycle % LOGIN_QUERY_EVERY_N_CYCLES === 0) {
			const yearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
			const realUsers = await withTimeout(
				firstValueFrom(
					c.api.query(
						'user.query',
						[
							['local', '=', true],
							['builtin', '=', false],
						],
						{ select: ['username'] },
					),
				),
				'user.query',
			).catch(() => []);
			const queryLogins = (services, username) =>
				withTimeout(
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
					),
					`audit.query(${services.join(',')},${username})`,
				).catch(() => []);
			// Run strictly one at a time, not in concurrent batches: our client
			// timeout only makes *us* stop waiting, it doesn't cancel the RPC on
			// the TrueNAS side, so a slow audit.query keeps occupying one of the
			// 20 concurrent-calls slots until the server itself finishes it.
			// Batching several of these in parallel let already-abandoned (but
			// still server-side in-flight) calls from one batch stack on top of
			// the next batch's calls, exceeding the limit on their own even
			// without any other session's traffic (see issue #5). This block
			// only runs every LOGIN_QUERY_EVERY_N_CYCLES-th cycle, so the extra
			// time cost of serializing it doesn't matter.
			const loginJobs = realUsers.flatMap(u => [
				() => queryLogins(['MIDDLEWARE'], u.username),
				() => queryLogins(['SMB'], u.username),
			]);
			const perUserLogins = [];
			for (const job of loginJobs) {
				perUserLogins.push(await job());
			}
			// main.js relies on newest-first order to find each user's most recent login.
			userLogins = perUserLogins.flat().sort((a, b) => b.message_timestamp - a.message_timestamp);
			this._cachedUserLogins = userLogins;
		}
		this._pollCycle++;

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
