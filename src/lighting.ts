import FOV from "fov/fov.js";
import * as Color from "./color.js";

type LightColor = [number, number, number];

interface ReflectivityCallback { (x:number, y:number ): number };
interface LightingCallback { (x:number, y:number, color: LightColor ): void };
interface LightingMap { [key:string]: LightColor };
interface NumberMap { [key:string]: number };

interface Options {
	passes: number,
	emissionThreshold: number,
	range: 10
}

export default class Lighting {
	_reflectivityCallback: ReflectivityCallback;
	_options!: Options;
	_fov!: FOV;
	_lights: LightingMap;
	_reflectivityCache: NumberMap;
	_fovCache: { [key:string]: NumberMap };

	/**
	 * @class Lighting computation, based on a traditional FOV for multiple light sources and multiple passes.
	 * @param {function} reflectivityCallback Callback to retrieve cell reflectivity (0..1)
	 * @param {object} [options]
	 * @param {int} [options.passes=1] Number of passes. 1 equals to simple FOV of all light sources, >1 means a *highly simplified* radiosity-like algorithm.
	 * @param {int} [options.emissionThreshold=100] Cells with emissivity > threshold will be treated as light source in the next pass.
	 * @param {int} [options.range=10] Max light range
	 */
	constructor(reflectivityCallback: ReflectivityCallback, options: Partial<Options> = {}) {
		this._reflectivityCallback = reflectivityCallback;
		this._options = {} as Options;
		options = Object.assign({
			passes: 1,
			emissionThreshold: 100,
			range: 10
		}, options);

		this._lights = {};
		this._reflectivityCache = {};
		this._fovCache = {};

		this.setOptions(options);
	}

	/**
	 * Adjust options at runtime
	 * @see ROT.Lighting
	 * @param {object} [options]
	 */
	setOptions(options: Partial<Options>) {
		Object.assign(this._options, options);
		if (options && options.range) { this.reset(); }
		return this;
	}

	/**
	 * Set the used Field-Of-View algo
	 * @param {ROT.FOV} fov
	 */
	setFOV(fov: FOV) {
		this._fov = fov;
		this._fovCache = {};
		return this;
	}

	/**
	 * Set (or remove) a light source
	 * @param {int} x
	 * @param {int} y
	 * @param {null || string || number[3]} color
	 */
	setLight(x: number, y: number, color: null | string | LightColor) {
		let key = x + "," + y;

		if (color) {
			this._lights[key] = (typeof(color) == "string" ? Color.fromString(color) as LightColor : color);
		} else {
			delete this._lights[key];
		}
		return this;
	}

	/**
	 * Remove all light sources
	 */
	clearLights() { this._lights = {}; }

	/**
	 * Reset the pre-computed topology values. Call whenever the underlying map changes its light-passability.
	 */
	reset() {
		this._reflectivityCache = {};
		this._fovCache = {};

		return this;
	}

	/**
	 * Compute the lighting
	 * @param {function} lightingCallback Will be called with (x, y, color) for every lit cell
	 */
	compute(lightingCallback: LightingCallback) {
		let doneCells: {[key:string]:number} = {};
		let emittingCells: LightingMap = {};
		let litCells: LightingMap = {};

		for (let key in this._lights) { /* prepare emitters for first pass */
			let light = this._lights[key];
			emittingCells[key] = [0, 0, 0];
			Color.add_(emittingCells[key], light);
		}

		for (let i=0;i<this._options.passes;i++) { /* main loop */
			this._emitLight(emittingCells, litCells, doneCells);
			if (i+1 == this._options.passes) { continue; } /* not for the last pass */
			emittingCells = this._computeEmitters(litCells, doneCells);
		}

		for (let litKey in litCells) { /* let the user know what and how is lit */
			var parts = litKey.split(",");
			var x = parseInt(parts[0]);
			var y = parseInt(parts[1]);
			lightingCallback(x, y, litCells[litKey]);
		}

		return this;
	}

	/**
	 * Compute one iteration from all emitting cells
	 * @param {object} emittingCells These emit light
	 * @param {object} litCells Add projected light to these
	 * @param {object} doneCells These already emitted, forbid them from further calculations
	 */
	_emitLight(emittingCells: LightingMap, litCells: LightingMap, doneCells: {[key:string]:number}) {
		for (let key in emittingCells) {
			let parts = key.split(",");
			let x = parseInt(parts[0]);
			let y = parseInt(parts[1]);
			this._emitLightFromCell(x, y, emittingCells[key], litCells);
			doneCells[key] = 1;
		}
		return this;
	}

	/**
	 * Prepare a list of emitters for next pass
	 * @param {object} litCells
	 * @param {object} doneCells
	 * @returns {object}
	 */
	_computeEmitters(litCells: LightingMap, doneCells: {[key:string]:number}) {
		let result: LightingMap = {};

		for (let key in litCells) {
			if (key in doneCells) { continue; } /* already emitted */

			let color = litCells[key];

			let reflectivity;
			if (key in this._reflectivityCache) {
				reflectivity = this._reflectivityCache[key];
			} else {
				let parts = key.split(",");
				let x = parseInt(parts[0]);
				let y = parseInt(parts[1]);
				reflectivity = this._reflectivityCallback(x, y);
				this._reflectivityCache[key] = reflectivity;
			}

			if (reflectivity == 0) { continue; } /* will not reflect at all */

			/* compute emission color */
			let emission: LightColor = [0, 0, 0];
			let intensity = 0;
			for (let i=0;i<3;i++) {
				let part = Math.round(color[i]*reflectivity);
				emission[i] = part;
				intensity += part;
			}
			if (intensity > this._options.emissionThreshold) { result[key] = emission; }
		}

		return result;
	}

	/**
	 * Compute one iteration from one cell
	 * @param {int} x
	 * @param {int} y
	 * @param {number[]} color
	 * @param {object} litCells Cell data to by updated
	 */
	_emitLightFromCell(x: number, y: number, color: LightColor, litCells: LightingMap) {
		let key = x+","+y;
		let fov : NumberMap;
		if (key in this._fovCache) {
			fov = this._fovCache[key];
		} else {
			fov = this._updateFOV(x, y);
		}

		for (let fovKey in fov) {
			let formFactor = fov[fovKey];

			let result : LightColor;
			if (fovKey in litCells) { /* already lit */
				result = litCells[fovKey];
			} else { /* newly lit */
				result = [0, 0, 0];
				litCells[fovKey] = result;
			}

			for (let i=0;i<3;i++) { result[i] += Math.round(color[i]*formFactor); } /* add light color */
		}

		return this;
	}

	/**
	 * Compute FOV ("form factor") for a potential light source at [x,y]
	 * @param {int} x
	 * @param {int} y
	 * @returns {object}
	 */
	_updateFOV(x: number, y: number) {
		let key1 = x+","+y;
		let cache: NumberMap = {};
		this._fovCache[key1] = cache;
		let range = this._options.range;
		function cb(x: number, y: number, r: number, vis: number) {
			let key2 = x+","+y;
			let formFactor = vis * (1-r/range);
			if (formFactor == 0) { return; }
			cache[key2] = formFactor;
		};
		this._fov.compute(x, y, range, cb.bind(this));

		return cache;
	}
}
