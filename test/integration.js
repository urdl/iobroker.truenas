const path = require('path');
const fs = require('fs');
const { tests } = require('@iobroker/testing');

const PR4100_CREDENTIALS_FILE = '/home/richie/credentials/truenas-iobroker-api.credentials';

function readCredentials(filePath) {
	if (!fs.existsSync(filePath)) {
		return null;
	}
	const creds = {};
	for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes('=')) {
			continue;
		}
		const [key, value] = trimmed.split('=');
		creds[key.trim()] = value.trim().replace(/^"|"$/g, '');
	}
	return creds;
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
	// The built-in "adapter starts" test always runs, on the empty native
	// config from io-package.json. host/apiKey are required, so with nothing
	// set the adapter correctly terminates right away with
	// INVALID_ADAPTER_CONFIG (exit code 2) -- exactly what it should do, but
	// the generic test otherwise reads that exit as a failure.
	// allowedExitCodes tells it this one is expected.
	allowedExitCodes: [2],

	defineAdditionalTests({ suite }) {
		suite('Starts with a placeholder configuration', (getHarness) => {
			it('does not terminate over the required fields', () => {
				return new Promise(async (resolve, reject) => {
					try {
						const harness = getHarness();
						await harness.changeAdapterConfig('truenas', {
							native: {
								host: 'truenas.example.invalid',
								username: 'placeholder',
								apiKey: 'placeholder',
								pollInterval: 60,
								allowSelfSigned: true,
							},
						});
						await harness.startAdapterAndWait();
						resolve();
					} catch (error) {
						reject(error);
					}
				});
			}).timeout(60000);
		});

		// Exercises the adapter's real logic against the actual PR4100 test
		// device. Skipped when the local credentials file is not present, e.g. in CI.
		suite('Live test against PR4100', (getHarness) => {
			const creds = readCredentials(PR4100_CREDENTIALS_FILE);

			it('polls the real device and populates states', function () {
				if (!creds) {
					this.skip();
					return;
				}
				return new Promise(async (resolve, reject) => {
					try {
						const harness = getHarness();
						await harness.changeAdapterConfig('truenas', {
							native: {
								host: 'truenas.preindl.local',
								username: creds.USER,
								apiKey: creds['API-Key'],
								pollInterval: 10,
								allowSelfSigned: true,
							},
						});
						await harness.startAdapterAndWait(true);

						const getState = id =>
							new Promise((res, rej) => {
								harness.states.getState(`truenas.0.${id}`, (err, state) => (err ? rej(err) : res(state)));
							});

						const hostname = await getState('system.hostname');
						if (!hostname || typeof hostname.val !== 'string' || !hostname.val) {
							throw new Error(`Expected system.hostname to be a non-empty string, got ${JSON.stringify(hostname)}`);
						}

						const connection = await getState('info.connection');
						if (!connection || connection.val !== true) {
							throw new Error(`Expected info.connection to be true, got ${JSON.stringify(connection)}`);
						}

						resolve();
					} catch (error) {
						reject(error);
					}
				});
			}).timeout(60000);
		});
	},
});
