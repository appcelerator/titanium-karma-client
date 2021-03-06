/* global global */

import EventEmitter from 'eventemitter3';
import io from 'ti.socketio';

import http from './http';

/**
 * Client to connect to the Karma server.
 *
 * Based on https://github.com/karma-runner/karma/blob/master/client/karma.js
 */
export default class KarmaClient extends EventEmitter {
	constructor(options) {
		super();

		const url = this.parseUrlString(options.url);
		this.baseUrl = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
		this.id = url.queryParams.id || 'Titanium-' + Math.floor(Math.random() * 10000);
		this.displayName = url.queryParams.displayName;
		this.startEmitted = false;
		this.isSingleRun = options.singleRun || false;
		this.resetResultCounters();
		this.config = {};

		global.__karma__ = this;
	}

	connect() {
		Ti.API.debug(`Connecting to ${this.baseUrl}`);
		this.socket = io.connect(this.baseUrl);
		this.socket.on('connect', () => {
			const info = {
				id: this.id,
				name: `Titanium ${Ti.version} (${Ti.Platform.name} ${Ti.Platform.model})`
			};
			if (this.displayName) {
				info.displayName = this.displayName;
			}
			this.socket.emit('register', info);
		});
		this.socket.on('execute', this.executeTestRun.bind(this));
		this.socket.on('stop', this.complete.bind(this));
		this.socket.on('disconnect', reason => Ti.API.debug(`Socket disconnected with reason ${reason}`));
	}

	disconnect() {
		this.socket.disconnect();
		if (Ti.App.iOS) {
			// iOS will reconnect if the server will come available again and we
			// don't explcitly disconnect the manager too.
			// https://github.com/socketio/socket.io-client-swift/issues/1137
			this.socket.io.disconnect();
		}
	}

	executeTestRun(config) {
		Ti.API.debug('Karma requested test run execution.');
		Ti.API.debug(config);

		this.emit('execute');

		this.startEmitted = false;
		this.config = config;

		this.resetResultCounters();

		const karmaContextUrl = `${this.baseUrl}/context.json`;
		Ti.API.debug(`Downloading file list from ${karmaContextUrl}`);

		http.getJson(karmaContextUrl)
			.then(contextData => {
				return contextData.files;
			})
			.then(scriptUrls => {
				return Promise.all(scriptUrls.map(scriptUrl => {
					// eslint-disable-next-line promise/no-nesting
					return http.getString(`${this.baseUrl}${scriptUrl}`)
						.then(scriptContent => {
							return {
								url: scriptUrl,
								content: scriptContent
							};
						});
				}));
			})
			.then(scripts => {
				scripts.forEach(script => {
					Ti.API.debug(`Evaluating script ${script.url}`);

					this.applyShims(script.url);

					// eslint-disable-next-line no-eval
					var evalInGlobalContext = eval;
					evalInGlobalContext(script.content);

					this.removeShims(script.url);
				});

				this.emit('start');

				this.start();

				return;
			})
			.catch(e => {
				throw e;
			});
	}

	applyShims(scriptUrl) {
		if (scriptUrl.includes('mocha')) {
			global.window = global;
			global.location = {
				pathname: '/'
			};
		} else if (scriptUrl.includes('jasmine')) {
			global.window = global;
			global.location = {
				origin: 'null'
			};
		}
	}

	removeShims(scriptUrl) {
		if (scriptUrl.includes('mocha')) {
			delete global.window;
		}
	}

	start() {
		throw new Error('This should be overriden by the Karma adapter of your unit testing framework (e.g. karma-jasmine).');
	}

	error(messageOrEvent, source, lineno, colno, error) {
		let message = messageOrEvent;
		var location = this.getLocation(source, lineno, colno);

		if (location !== '') {
			message += '\nat ' + location;
		}

		if (error) {
			message += '\n\n' + error.stack;
		}

		message = {
			message: message,
			str: message.toString()
		};

		this.socket.emit('karma_error', message);
		this.complete();

		return false;
	}

	getLocation(url, lineno, colno) {
		var location = '';

		if (url !== undefined) {
			location += url;
		}

		if (lineno !== undefined) {
			location += ':' + lineno;
		}

		if (colno !== undefined) {
			location += ':' + colno;
		}

		return location;
	}

	result(originalResult) {
		var convertedResult = {};

		// Convert all array-like objects to real arrays.
		for (var propertyName in originalResult) {
			if (Object.prototype.hasOwnProperty.call(originalResult, propertyName)) {
				var propertyValue = originalResult[propertyName];

				if (Object.prototype.toString.call(propertyValue) === '[object Array]') {
					convertedResult[propertyName] = Array.prototype.slice.call(propertyValue);
				} else {
					convertedResult[propertyName] = propertyValue;
				}
			}
		}

		if (convertedResult.skipped) {
			this.skipped++;
		} else if (convertedResult.success) {
			this.success++;
		} else {
			this.failed++;
		}

		const completed = this.skipped + this.success + this.failed;
		this.emit('result', { completed, total: this.total });

		if (!this.startEmitted) {
			this.socket.emit('start', {
				total: null
			});
			this.startEmitted = true;
		}

		this.socket.emit('result', convertedResult);
	}

	complete(result) {
		this.emit('complete', {
			total: this.total,
			skipped: this.skipped,
			failed: this.failed
		});

		this.socket.emit('complete', result || {}, () => {
			Ti.API.trace('Test run complete');

			if (this.isSingleRun) {
				this.disconnect();
			}
		});
	}

	info(info) {
		if (!this.startEmitted && typeof info.total !== 'undefined') {
			this.socket.emit('start', info);
			this.startEmitted = true;
			this.total = info.total;
		} else {
			this.socket.emit('info', info);
		}
	}

	parseUrlString(urlString) {
		const urlPattern = /^(https?:)\/\/(([^:/?#]*)(?::([0-9]+))?)([/]{0,1}[^?#]*)\??([^#]*|)$/;
		const match = urlString.match(urlPattern);
		if (!match) {
			throw new Error(`Failed to parse URL ${urlString}`);
		}

		const protocol = match[1];
		let host = match[2];
		let hostname = match[3];
		const port = match[4];
		const pathname = match[5];
		const search = match[6];
		const queryParams = {};
		if (search) {
			const keyValuePairs = search.split('&');
			for (const keyValuePair of keyValuePairs) {
				const [ key, value ] = keyValuePair.split('=');
				queryParams[key] = value;
			}
		}

		if (/sdk|emulator/i.test(Ti.Platform.model)) {
			if ([ 'localhost', '127.0.0.1' ].indexOf(hostname) !== -1) {
				hostname = '10.0.2.2';
				host = port ? `${hostname}:${port}` : hostname;
			}
		}

		return {
			protocol,
			host,
			hostname,
			port,
			pathname,
			queryParams
		};
	}

	resetResultCounters() {
		this.total = this.skipped = this.failed = this.success = 0;
	}
}
