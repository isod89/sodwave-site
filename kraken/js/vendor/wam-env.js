// SPDX-License-Identifier: MIT
// The Web Audio Modules 2.0 host environment, from @webaudiomodules/sdk 0.0.12 (src/initializeWamHost.js,
// src/addFunctionModule.js, src/WamEnv.js, src/WamGroup.js, src/apiVersion.js), joined in one file, code unchanged.
// https://github.com/webaudiomodules/sdk · https://www.npmjs.com/package/@webaudiomodules/sdk
//
// MIT License
//
// Copyright (c) WebAudioModules Working Group
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of
// the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

export const apiVersion = "2.0.0-alpha.6";

/**
 * Take a function, stringify it and inject to an AudioWorklet with parameters.
 *
 * @param {AudioWorklet} audioWorklet
 * @param {(...args: any[]) => any} processorFunction
 * @param {any[]} [injection]
 * @returns {Promise<void>}
 */
export const addFunctionModule = (audioWorklet, processorFunction, ...injection) => {
    const text = `(${processorFunction.toString()})(${injection.map((s) => JSON.stringify(s)).join(', ')});`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    return audioWorklet.addModule(url);
}

/**
 * @param {string} apiVersion
 */
const initializeWamEnv = (apiVersion) => {
	/** @type {AudioWorkletGlobalScope} */
	// @ts-ignore
	const audioWorkletGlobalScope = globalThis;
	if (audioWorkletGlobalScope.AudioWorkletProcessor
		&& audioWorkletGlobalScope.webAudioModules) return; // already initialized

	/** @type {Map<string, any>} */
	const moduleScopes = new Map();

	/** @type {Map<string, IWamGroup>} */
	const groups = new Map();

	/**
	 * @implements {IWamEnv}
	 */
	class WamEnv {
		constructor() {}

		get apiVersion() {
			return apiVersion;
		}

		/**
		 * @param {string} moduleId
		 * @returns {Record<string, any>}
		*/
		getModuleScope(moduleId) {
			if (!moduleScopes.has(moduleId)) moduleScopes.set(moduleId, {});
			return moduleScopes.get(moduleId);
		}

		/**
		 * @param {string} groupId
		 * @param {string} groupKey
		 */
		getGroup(groupId, groupKey) {
			const group = groups.get(groupId);
			if (group.validate(groupKey)) return group;
			else throw 'Invalid key';
		}

		/**
		 * @param {IWamGroup} group
		 */
		addGroup(group) {
			if (!groups.has(group.groupId)) groups.set(group.groupId, group);
		}

		/**
		 * @param {IWamGroup} group
		 */
		removeGroup(group) {
			groups.delete(group.groupId);
		}

		/**
		 * @param {IWamProcessor} wam
		 */
		addWam(wam) {
			/** @type {IWamGroup} */
			const group = groups.get(wam.groupId);
			group.addWam(wam);
		}

		/**
		 * @param {IWamProcessor} wam
		 */
		removeWam(wam) {
			/** @type {IWamGroup} */
			const group = groups.get(wam.groupId);
			group.removeWam(wam);
		}

		/**
		 * @param {string} groupId
		 * @param {string} fromId
		 * @param {string} toId
		 * @param {number} [output]
		 */
		connectEvents(groupId, fromId, toId, output = 0) {
			/** @type {IWamGroup} */
			const group = groups.get(groupId);
			group.connectEvents(fromId, toId, output);
		}

		/**
		 * @param {string} groupId
		 * @param {string} fromId
		 * @param {string} [toId]
		 * @param {number} [output]
		 */
		disconnectEvents(groupId, fromId, toId, output) {
			/** @type {IWamGroup} */
			const group = groups.get(groupId);
			group.disconnectEvents(fromId, toId, output);
		}

		/**
		 * @param {IWamProcessor} from
		 * @param {WamEvent[]} events
		 */
		emitEvents(from, ...events) {
			/** @type {IWamGroup} */
			const group = groups.get(from.groupId);
			group.emitEvents(from, ...events);
		}
	}

	if (audioWorkletGlobalScope.AudioWorkletProcessor) {
		if (!audioWorkletGlobalScope.webAudioModules) audioWorkletGlobalScope.webAudioModules = new WamEnv();
	}
};

/**
 * @param {string} groupId
 * @param {string} groupKey
 */
const initializeWamGroup = (groupId, groupKey) => {
	/** @type {AudioWorkletGlobalScope} */
	// @ts-ignore
	const audioWorkletGlobalScope = globalThis;

	/** @implements IWamGroup */
	class WamGroup {
		/**
		 * @param {string} groupId
		 * @param {string} groupKey
		 */
		constructor(groupId, groupKey) {
			/** @type {string} */
			this._groupId = groupId;

			/** @type {(key: string) => boolean} */
			this._validate = (key) => {
				return key == groupKey;
			}

			/** @type {Map<string, IWamProcessor>} */
			this._processors = new Map();

			/** @type {Map<IWamProcessor, Set<IWamProcessor>[]>} */
			this._eventGraph = new Map();
		}

		get groupId() {
			return this._groupId;
		}

		get processors() {
			return this._processors;
		}

		get eventGraph() {
			return this._eventGraph;
		}

		validate(groupKey) {
			return this._validate(groupKey);
		}

		addWam(wam) {
			this._processors.set(wam.instanceId, wam);
		}

		removeWam(wam) {
			if (this._eventGraph.has(wam)) this._eventGraph.delete(wam);
			this._eventGraph.forEach((outputMap) => {
				outputMap.forEach((set) => {
					if (set && set.has(wam)) set.delete(wam);
				});
			});
			this._processors.delete(wam.instanceId);
		}

		/**
		 * @param {string} fromId
		 * @param {string} toId
		 * @param {number} [output]
		 */
		connectEvents(fromId, toId, output) {
			/** @type {IWamProcessor} */
			const from = this._processors.get(fromId);
			/** @type {IWamProcessor} */
			const to = this._processors.get(toId);

			/** @type {Set<IWamProcessor>[]} */
			let outputMap;
			if (this._eventGraph.has(from)) {
				outputMap = this._eventGraph.get(from);
			} else {
				outputMap = [];
				this._eventGraph.set(from, outputMap);
			}
			if (outputMap[output]) {
				outputMap[output].add(to);
			} else {
				const set = new Set();
				set.add(to);
				outputMap[output] = set;
			}
		}

		/**
		 * @param {string} fromId
		 * @param {string} [toId]
		 * @param {number} [output]
		 */
		disconnectEvents(fromId, toId, output) {
			/** @type {IWamProcessor} */
			const from = this._processors.get(fromId);

			if (!this._eventGraph.has(from)) return;
			const outputMap = this._eventGraph.get(from);
			if (typeof toId === 'undefined') {
				outputMap.forEach((set) => {
					if (set) set.clear();
				});
				return;
			}

			/** @type {IWamProcessor} */
			const to = this._processors.get(toId);

			if (typeof output === 'undefined') {
				outputMap.forEach((set) => {
					if (set) set.delete(to);
				});
				return;
			}
			if (!outputMap[output]) return;
			outputMap[output].delete(to);
		}

		/**
		 * @param {IWamProcessor} from
		 * @param {WamEvent[]} events
		 */
		emitEvents(from, ...events) {
			if (!this._eventGraph.has(from)) return;
			const downstream = this._eventGraph.get(from);
			downstream.forEach((set) => {
				if (set) set.forEach((wam) => wam.scheduleEvents(...events));
			});
		}
	}

	if (audioWorkletGlobalScope.AudioWorkletProcessor) {
		audioWorkletGlobalScope.webAudioModules.addGroup(new WamGroup(groupId, groupKey));
	}
};

/**
 * @param {BaseAudioContext} audioContext
 * @param {string} [hostGroupId]
 * @param {string} [hostGroupKey]
 * @returns {Promise<[string, string]>} [hostGroupId, hostGroupKey]
 */
export const initializeWamHost = async (audioContext, hostGroupId = `wam-host-${performance.now().toString()}`, hostGroupKey = performance.now().toString()) => {
    await addFunctionModule(audioContext.audioWorklet, initializeWamEnv, apiVersion);
    await addFunctionModule(audioContext.audioWorklet, initializeWamGroup, hostGroupId, hostGroupKey);
    return [hostGroupId, hostGroupKey];
};

export default initializeWamHost;
