/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	'use strict';

	// @ts-ignore
	const ipcRenderer = require('electron').ipcRenderer;

	const registerVscodeResourceScheme = (function () {
		let hasRegistered = false;
		return () => {
			if (hasRegistered) {
				return;
			}

			hasRegistered = true;

			// @ts-ignore
			require('electron').webFrame.registerURLSchemeAsPrivileged('vscode-resource', {
				secure: true,
				bypassCSP: false,
				allowServiceWorkers: false,
				supportFetchAPI: true,
				corsEnabled: true
			});
		};
	}());

	// state
	var firstLoad = true;
	var loadTimeout;
	var pendingMessages = [];
	var enableWrappedPostMessage = false;
	let isInDevelopmentMode = false;

	const initData = {
		initialScrollProgress: undefined
	};

	/**
	 * @param {HTMLElement} body
	 */
	const styleBody = (body) => {
		if (!body) {
			return;
		}
		body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
		body.classList.add(initData.activeTheme);
	};

	const getActiveFrame = () => {
		return /** @type {HTMLIFrameElement} */ (document.getElementById('active-frame'));
	};

	const getPendingFrame = () => {
		return /** @type {HTMLIFrameElement} */ (document.getElementById('pending-frame'));
	};

	/**
	 * @param {MouseEvent} event
	 */
	const handleInnerClick = (event) => {
		if (!event || !event.view || !event.view.document) {
			return;
		}

		var baseElement = event.view.document.getElementsByTagName('base')[0];
		/** @type {any} */
		var node = event.target;
		while (node) {
			if (node.tagName && node.tagName.toLowerCase() === 'a' && node.href) {
				if (node.getAttribute('href') === '#') {
					event.view.scrollTo(0, 0);
				} else if (node.hash && (node.getAttribute('href') === node.hash || (baseElement && node.href.indexOf(baseElement.href) >= 0))) {
					var scrollTarget = event.view.document.getElementById(node.hash.substr(1, node.hash.length - 1));
					if (scrollTarget) {
						scrollTarget.scrollIntoView();
					}
				} else {
					ipcRenderer.sendToHost('did-click-link', node.href);
				}
				event.preventDefault();
				break;
			}
			node = node.parentNode;
		}
	};

	const onMessage = (message) => {
		ipcRenderer.sendToHost(message.data.command, message.data.data);
	};

	var isHandlingScroll = false;
	const handleInnerScroll = (event) => {
		if (isHandlingScroll) {
			return;
		}

		const progress = event.target.body.scrollTop / event.target.body.clientHeight;
		if (isNaN(progress)) {
			return;
		}

		isHandlingScroll = true;
		window.requestAnimationFrame(() => {
			try {
				ipcRenderer.sendToHost('did-scroll', progress);
			} catch (e) {
				// noop
			}
			isHandlingScroll = false;
		});
	};

	document.addEventListener('DOMContentLoaded', () => {
		ipcRenderer.on('baseUrl', (event, value) => {
			initData.baseUrl = value;
		});

		ipcRenderer.on('styles', (event, variables, activeTheme) => {
			initData.styles = variables;
			initData.activeTheme = activeTheme;

			// webview
			var target = getActiveFrame();
			if (!target) {
				return;
			}
			var body = target.contentDocument.getElementsByTagName('body');
			styleBody(body[0]);

			// iframe
			Object.keys(variables).forEach((variable) => {
				target.contentDocument.documentElement.style.setProperty(`--${variable}`, variables[variable]);
			});
		});

		// propagate focus
		ipcRenderer.on('focus', () => {
			const target = getActiveFrame();
			if (target) {
				target.contentWindow.focus();
			}
		});

		// update iframe-contents
		ipcRenderer.on('content', (_event, data) => {
			const options = data.options;
			enableWrappedPostMessage = options && options.enableWrappedPostMessage;

			if (enableWrappedPostMessage) {
				registerVscodeResourceScheme();
			}

			const text = data.contents;
			const newDocument = new DOMParser().parseFromString(text, 'text/html');

			newDocument.querySelectorAll('a').forEach(a => {
				if (!a.title) {
					a.title = a.href;
				}
			});

			// set base-url if applicable
			if (initData.baseUrl && newDocument.head.getElementsByTagName('base').length === 0) {
				const baseElement = newDocument.createElement('base');
				baseElement.href = initData.baseUrl;
				newDocument.head.appendChild(baseElement);
			}

			// apply default script
			if (enableWrappedPostMessage) {
				const defaultScript = newDocument.createElement('script');
				defaultScript.textContent = `
					const acquireVsCodeApi = (function() {
						const originalPostMessage = window.parent.postMessage.bind(window.parent);
						let acquired = false;

						let state = ${data.state ? `JSON.parse(${JSON.stringify(data.state)})` : undefined};

						return () => {
							if (acquired) {
								throw new Error('An instance of the VS Code API has already been acquired');
							}
							acquired = true;
							return Object.freeze({
								postMessage: function(msg) {
									return originalPostMessage({ command: 'onmessage', data: msg }, '*');
								},
								setState: function(state) {
									return originalPostMessage({ command: 'do-update-state', data: JSON.stringify(state) }, '*');
								},
								getState: function() {
									return state;
								}
							});
						};
					})();
					delete window.parent;
					delete window.top;
					delete window.frameElement;
				`;

				if (newDocument.head.hasChildNodes()) {
					newDocument.head.insertBefore(defaultScript, newDocument.head.firstChild);
				} else {
					newDocument.head.appendChild(defaultScript);
				}
			}

			// apply default styles
			const defaultStyles = newDocument.createElement('style');
			defaultStyles.id = '_defaultStyles';

			const vars = Object.keys(initData.styles || {}).map(variable => {
				return `--${variable}: ${initData.styles[variable]};`;
			});
			defaultStyles.innerHTML = `
			:root { ${vars.join(' ')} }

			body {
				background-color: var(--background-color);
				color: var(--color);
				font-family: var(--font-family);
				font-weight: var(--font-weight);
				font-size: var(--font-size);
				margin: 0;
				padding: 0 20px;
			}

			img {
				max-width: 100%;
				max-height: 100%;
			}

			body a {
				color: var(--link-color);
			}

			a:focus,
			input:focus,
			select:focus,
			textarea:focus {
				outline: 1px solid -webkit-focus-ring-color;
				outline-offset: -1px;
			}
			::-webkit-scrollbar {
				width: 10px;
				height: 10px;
			}

			::-webkit-scrollbar-thumb {
				background-color: rgba(121, 121, 121, 0.4);
			}
			body.vscode-light::-webkit-scrollbar-thumb {
				background-color: rgba(100, 100, 100, 0.4);
			}
			body.vscode-high-contrast::-webkit-scrollbar-thumb {
				background-color: rgba(111, 195, 223, 0.3);
			}

			::-webkit-scrollbar-thumb:hover {
				background-color: rgba(100, 100, 100, 0.7);
			}
			body.vscode-light::-webkit-scrollbar-thumb:hover {
				background-color: rgba(100, 100, 100, 0.7);
			}
			body.vscode-high-contrast::-webkit-scrollbar-thumb:hover {
				background-color: rgba(111, 195, 223, 0.8);
			}

			::-webkit-scrollbar-thumb:active {
				background-color: rgba(85, 85, 85, 0.8);
			}
			body.vscode-light::-webkit-scrollbar-thumb:active {
				background-color: rgba(0, 0, 0, 0.6);
			}
			body.vscode-high-contrast::-webkit-scrollbar-thumb:active {
				background-color: rgba(111, 195, 223, 0.8);
			}
			`;
			if (newDocument.head.hasChildNodes()) {
				newDocument.head.insertBefore(defaultStyles, newDocument.head.firstChild);
			} else {
				newDocument.head.appendChild(defaultStyles);
			}

			styleBody(newDocument.body);

			const frame = getActiveFrame();

			// keep current scrollTop around and use later
			var setInitialScrollPosition;
			if (firstLoad) {
				firstLoad = false;
				setInitialScrollPosition = (body) => {
					if (!isNaN(initData.initialScrollProgress)) {
						if (body.scrollTop === 0) {
							body.scrollTop = body.clientHeight * initData.initialScrollProgress;
						}
					}
				};
			} else {
				const scrollY = frame && frame.contentDocument && frame.contentDocument.body ? frame.contentDocument.body.scrollTop : 0;
				setInitialScrollPosition = (body) => {
					if (body.scrollTop === 0) {
						body.scrollTop = scrollY;
					}
				};
			}

			// Clean up old pending frames and set current one as new one
			const previousPendingFrame = getPendingFrame();
			if (previousPendingFrame) {
				previousPendingFrame.setAttribute('id', '');
				document.body.removeChild(previousPendingFrame);
			}
			pendingMessages = [];

			const newFrame = document.createElement('iframe');
			newFrame.setAttribute('id', 'pending-frame');
			newFrame.setAttribute('frameborder', '0');
			newFrame.setAttribute('sandbox', options.allowScripts ? 'allow-scripts allow-forms allow-same-origin' : 'allow-same-origin');
			newFrame.style.cssText = 'display: block; margin: 0; overflow: hidden; position: absolute; width: 100%; height: 100%; visibility: hidden';
			document.body.appendChild(newFrame);

			// write new content onto iframe
			newFrame.contentDocument.open('text/html', 'replace');
			newFrame.contentWindow.onbeforeunload = () => {
				if (isInDevelopmentMode) { // Allow reloads while developing a webview
					ipcRenderer.sendToHost('do-reload');
					return false;
				}

				// Block navigation when not in development mode
				console.log('prevented webview navigation');
				return false;
			};

			var onLoad = (contentDocument, contentWindow) => {
				if (contentDocument.body) {
					// Workaround for https://github.com/Microsoft/vscode/issues/12865
					// check new scrollTop and reset if neccessary
					setInitialScrollPosition(contentDocument.body);

					// Bubble out link clicks
					contentDocument.body.addEventListener('click', handleInnerClick);
				}

				const newFrame = getPendingFrame();
				if (newFrame && newFrame.contentDocument === contentDocument) {
					const oldActiveFrame = getActiveFrame();
					if (oldActiveFrame) {
						document.body.removeChild(oldActiveFrame);
					}
					newFrame.setAttribute('id', 'active-frame');
					newFrame.style.visibility = 'visible';
					contentWindow.addEventListener('scroll', handleInnerScroll);

					pendingMessages.forEach((data) => {
						contentWindow.postMessage(data, '*');
					});
					pendingMessages = [];
				}
			};

			clearTimeout(loadTimeout);
			loadTimeout = undefined;
			loadTimeout = setTimeout(() => {
				clearTimeout(loadTimeout);
				loadTimeout = undefined;
				onLoad(newFrame.contentDocument, newFrame.contentWindow);
			}, 200);

			newFrame.contentWindow.addEventListener('load', function (e) {
				if (loadTimeout) {
					clearTimeout(loadTimeout);
					loadTimeout = undefined;
					onLoad(e.target, this);
				}
			});

			// set DOCTYPE for newDocument explicitly as DOMParser.parseFromString strips it off
			// and DOCTYPE is needed in the iframe to ensure that the user agent stylesheet is correctly overridden
			newFrame.contentDocument.write('<!DOCTYPE html>');
			newFrame.contentDocument.write(newDocument.documentElement.innerHTML);
			newFrame.contentDocument.close();

			ipcRenderer.sendToHost('did-set-content');
		});

		// Forward message to the embedded iframe
		ipcRenderer.on('message', (event, data) => {
			const pending = getPendingFrame();
			if (pending) {
				pendingMessages.push(data);
			} else {
				const target = getActiveFrame();
				if (target) {
					target.contentWindow.postMessage(data, '*');
				}
			}
		});

		ipcRenderer.on('initial-scroll-position', (event, progress) => {
			initData.initialScrollProgress = progress;
		});

		ipcRenderer.on('devtools-opened', () => {
			isInDevelopmentMode = true;
		});

		// Forward messages from the embedded iframe
		window.onmessage = onMessage;

		// signal ready
		ipcRenderer.sendToHost('webview-ready', process.pid);
	});
}());