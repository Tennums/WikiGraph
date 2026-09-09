var VaultGraphEngine = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // web/vendor/engine/index.ts
  var index_exports = {};
  __export(index_exports, {
    GraphStore: () => GraphStore,
    Renderer: () => Renderer
  });

  // web/vendor/engine/store.ts
  var KEY_SEP = "";
  function isArrayIndex(key) {
    const n = Number(key);
    return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key;
  }
  function inPropertyOrder(keys) {
    const indexes = [];
    const rest = [];
    for (const k of keys) {
      if (isArrayIndex(k)) indexes.push(Number(k));
      else rest.push(k);
    }
    indexes.sort((a, b) => a - b);
    const out = indexes.map(String);
    for (const k of rest) out.push(k);
    return out;
  }
  var GraphStore = class {
    constructor() {
      __publicField(this, "nodeAttrs", /* @__PURE__ */ new Map());
      __publicField(this, "edgeRecords", /* @__PURE__ */ new Map());
      __publicField(this, "adjacency", /* @__PURE__ */ new Map());
    }
    get order() {
      return this.nodeAttrs.size;
    }
    get size() {
      return this.edgeRecords.size;
    }
    addNode(id, attrs) {
      if (this.nodeAttrs.has(id)) throw new Error(`GraphStore: node "${id}" already exists`);
      this.nodeAttrs.set(id, attrs);
      this.adjacency.set(id, /* @__PURE__ */ new Map());
      return id;
    }
    addUndirectedEdge(source, target, attrs) {
      const a = this.adjacency.get(source);
      const b = this.adjacency.get(target);
      if (!a) throw new Error(`GraphStore: node "${source}" not found`);
      if (!b) throw new Error(`GraphStore: node "${target}" not found`);
      if (a.has(target)) throw new Error(`GraphStore: edge ${source} -- ${target} already exists`);
      const key = source + KEY_SEP + target;
      const rec = { key, source, target, attrs };
      this.edgeRecords.set(key, rec);
      a.set(target, rec);
      b.set(source, rec);
      return key;
    }
    hasNode(id) {
      return this.nodeAttrs.has(id);
    }
    hasEdge(source, target) {
      const a = this.adjacency.get(source);
      return a !== void 0 && a.has(target);
    }
    dropEdge(source, target) {
      const a = this.adjacency.get(source);
      const rec = a?.get(target);
      if (!a || !rec) throw new Error(`GraphStore: no edge ${source} -- ${target}`);
      a.delete(target);
      this.neighboursOf(target).delete(source);
      this.edgeRecords.delete(rec.key);
    }
    extremities(edge) {
      const rec = this.edgeRecords.get(edge);
      if (!rec) throw new Error(`GraphStore: edge "${edge}" not found`);
      return [rec.source, rec.target];
    }
    degree(id) {
      const around = this.neighboursOf(id);
      return around.size + (around.has(id) ? 1 : 0);
    }
    neighbors(id) {
      return inPropertyOrder(this.neighboursOf(id).keys());
    }
    nodes() {
      return Array.from(this.nodeAttrs.keys());
    }
    forEachNode(fn) {
      for (const [id, attrs] of this.nodeAttrs) fn(id, attrs);
    }
    forEachEdge(nodeOrFn, maybeFn) {
      if (typeof nodeOrFn === "function") {
        for (const rec of this.edgeRecords.values()) nodeOrFn(rec.key, rec.attrs, rec.source, rec.target);
        return;
      }
      if (!maybeFn) throw new Error("GraphStore: forEachEdge(node) needs a callback");
      const around = this.neighboursOf(nodeOrFn);
      for (const neighbour of inPropertyOrder(around.keys())) {
        const rec = around.get(neighbour);
        if (rec) maybeFn(rec.key, rec.attrs, rec.source, rec.target);
      }
    }
    getNodeAttribute(id, name) {
      return this.attrsOf(id)[name];
    }
    getNodeAttributes(id) {
      return this.attrsOf(id);
    }
    setNodeAttribute(id, name, value) {
      this.attrsOf(id)[name] = value;
    }
    mergeNodeAttributes(id, attrs) {
      Object.assign(this.attrsOf(id), attrs);
    }
    edges() {
      return Array.from(this.edgeRecords.keys());
    }
    getEdgeAttributes(edge) {
      const rec = this.edgeRecords.get(edge);
      if (!rec) throw new Error(`GraphStore: edge "${edge}" not found`);
      return rec.attrs;
    }
    attrsOf(id) {
      const attrs = this.nodeAttrs.get(id);
      if (!attrs) throw new Error(`GraphStore: node "${id}" not found`);
      return attrs;
    }
    neighboursOf(id) {
      const around = this.adjacency.get(id);
      if (!around) throw new Error(`GraphStore: node "${id}" not found`);
      return around;
    }
  };

  // web/vendor/engine/emitter.ts
  var Emitter = class {
    constructor() {
      __publicField(this, "listeners", /* @__PURE__ */ new Map());
    }
    on(event, fn) {
      let set = this.listeners.get(event);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.listeners.set(event, set);
      }
      set.add(fn);
      return this;
    }
    emit(event, payload) {
      const set = this.listeners.get(event);
      if (!set) return;
      for (const fn of Array.from(set)) fn(payload);
    }
    removeAllListeners() {
      this.listeners.clear();
    }
  };

  // web/vendor/engine/viewport.ts
  function identity() {
    return Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  }
  function scale(m, x, y) {
    m[0] = x;
    m[4] = typeof y === "number" ? y : x;
    return m;
  }
  function rotate(m, r) {
    const s = Math.sin(r);
    const c = Math.cos(r);
    m[0] = c;
    m[1] = s;
    m[3] = -s;
    m[4] = c;
    return m;
  }
  function translate(m, x, y) {
    m[6] = x;
    m[7] = y;
    return m;
  }
  function multiply(a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2];
    const a10 = a[3], a11 = a[4], a12 = a[5];
    const a20 = a[6], a21 = a[7], a22 = a[8];
    const b00 = b[0], b01 = b[1], b02 = b[2];
    const b10 = b[3], b11 = b[4], b12 = b[5];
    const b20 = b[6], b21 = b[7], b22 = b[8];
    a[0] = b00 * a00 + b01 * a10 + b02 * a20;
    a[1] = b00 * a01 + b01 * a11 + b02 * a21;
    a[2] = b00 * a02 + b01 * a12 + b02 * a22;
    a[3] = b10 * a00 + b11 * a10 + b12 * a20;
    a[4] = b10 * a01 + b11 * a11 + b12 * a21;
    a[5] = b10 * a02 + b11 * a12 + b12 * a22;
    a[6] = b20 * a00 + b21 * a10 + b22 * a20;
    a[7] = b20 * a01 + b21 * a11 + b22 * a21;
    a[8] = b20 * a02 + b21 * a12 + b22 * a22;
    return a;
  }
  function multiplyVec2(a, b, z = 1) {
    const a00 = a[0], a01 = a[1], a10 = a[3], a11 = a[4], a20 = a[6], a21 = a[7];
    return {
      x: b.x * a00 + b.y * a10 + a20 * z,
      y: b.x * a01 + b.y * a11 + a21 * z
    };
  }
  function getCorrectionRatio(viewport, graph) {
    const viewportRatio = viewport.height / viewport.width;
    const graphRatio = graph.height / graph.width;
    if (viewportRatio < 1 && graphRatio > 1 || viewportRatio > 1 && graphRatio < 1) return 1;
    return Math.min(Math.max(graphRatio, 1 / graphRatio), Math.max(1 / viewportRatio, viewportRatio));
  }
  function matrixFromCamera(state, viewport, graph, padding, inverse = false) {
    const { angle, ratio, x, y } = state;
    const { width, height } = viewport;
    const matrix = identity();
    const smallestDimension = Math.min(width, height) - 2 * padding;
    const correctionRatio = getCorrectionRatio(viewport, graph);
    if (!inverse) {
      multiply(matrix, scale(
        identity(),
        2 * (smallestDimension / width) * correctionRatio,
        2 * (smallestDimension / height) * correctionRatio
      ));
      multiply(matrix, rotate(identity(), -angle));
      multiply(matrix, scale(identity(), 1 / ratio));
      multiply(matrix, translate(identity(), -x, -y));
    } else {
      multiply(matrix, translate(identity(), x, y));
      multiply(matrix, scale(identity(), ratio));
      multiply(matrix, rotate(identity(), angle));
      multiply(matrix, scale(
        identity(),
        width / smallestDimension / 2 / correctionRatio,
        height / smallestDimension / 2 / correctionRatio
      ));
    }
    return matrix;
  }
  function getMatrixImpact(matrix, state, viewport) {
    const { x, y } = multiplyVec2(matrix, { x: Math.cos(state.angle), y: Math.sin(state.angle) }, 0);
    return 1 / Math.sqrt(x * x + y * y) / viewport.width;
  }
  function createNormalization(extent) {
    const [minX, maxX] = extent.x;
    const [minY, maxY] = extent.y;
    let ratio = Math.max(maxX - minX, maxY - minY);
    let dX = (maxX + minX) / 2;
    let dY = (maxY + minY) / 2;
    if (ratio === 0 || Math.abs(ratio) === Infinity || Number.isNaN(ratio)) ratio = 1;
    if (Number.isNaN(dX)) dX = 0;
    if (Number.isNaN(dY)) dY = 0;
    return {
      apply: (p) => ({ x: 0.5 + (p.x - dX) / ratio, y: 0.5 + (p.y - dY) / ratio }),
      applyTo: (p) => {
        p.x = 0.5 + (p.x - dX) / ratio;
        p.y = 0.5 + (p.y - dY) / ratio;
      },
      inverse: (p) => ({ x: dX + ratio * (p.x - 0.5), y: dY + ratio * (p.y - 0.5) }),
      ratio
    };
  }
  function graphExtent(graph) {
    if (!graph.order) return { x: [0, 1], y: [0, 1] };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    graph.forEachNode((_id, attrs) => {
      const { x, y } = attrs;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    });
    return { x: [xMin, xMax], y: [yMin, yMax] };
  }
  var easings = {
    linear: (k) => k,
    quadraticIn: (k) => k * k,
    quadraticOut: (k) => k * (2 - k),
    quadraticInOut: (k) => {
      if ((k *= 2) < 1) return 0.5 * k * k;
      return -0.5 * (--k * (k - 2) - 1);
    }
  };

  // web/vendor/engine/camera.ts
  var ANIMATE_DEFAULTS = { easing: "quadraticInOut", duration: 150 };
  var Camera = class extends Emitter {
    constructor(win) {
      super();
      __publicField(this, "win", win);
      __publicField(this, "x", 0.5);
      __publicField(this, "y", 0.5);
      __publicField(this, "ratio", 1);
      __publicField(this, "angle", 0);
      __publicField(this, "minRatio", null);
      __publicField(this, "maxRatio", null);
      __publicField(this, "enabledZooming", true);
      __publicField(this, "enabledPanning", true);
      __publicField(this, "previousState");
      __publicField(this, "nextFrame", null);
      __publicField(this, "animationCallback");
      this.previousState = this.getState();
    }
    getState() {
      return { x: this.x, y: this.y, angle: this.angle, ratio: this.ratio };
    }
    hasState(state) {
      return this.x === state.x && this.y === state.y && this.ratio === state.ratio && this.angle === state.angle;
    }
    getPreviousState() {
      const s = this.previousState;
      return { x: s.x, y: s.y, angle: s.angle, ratio: s.ratio };
    }
    getBoundedRatio(ratio) {
      let r = ratio;
      if (typeof this.minRatio === "number") r = Math.max(r, this.minRatio);
      if (typeof this.maxRatio === "number") r = Math.min(r, this.maxRatio);
      return r;
    }
    validateState(state) {
      const valid = {};
      if (this.enabledPanning && typeof state.x === "number") valid.x = state.x;
      if (this.enabledPanning && typeof state.y === "number") valid.y = state.y;
      if (this.enabledZooming && typeof state.ratio === "number") valid.ratio = this.getBoundedRatio(state.ratio);
      return valid;
    }
    setState(state) {
      this.previousState = this.getState();
      const valid = this.validateState(state);
      if (typeof valid.x === "number") this.x = valid.x;
      if (typeof valid.y === "number") this.y = valid.y;
      if (typeof valid.ratio === "number") this.ratio = valid.ratio;
      if (!this.hasState(this.previousState)) this.emit("updated", this.getState());
      return this;
    }
    kill() {
      if (this.nextFrame !== null) this.win.cancelAnimationFrame(this.nextFrame);
      this.nextFrame = null;
      this.animationCallback = void 0;
      this.removeAllListeners();
    }
    // github#73, design/0013
    stopAnimation() {
      if (this.nextFrame === null) return;
      this.win.cancelAnimationFrame(this.nextFrame);
      this.nextFrame = null;
      if (this.animationCallback) {
        const cb = this.animationCallback;
        this.animationCallback = void 0;
        cb();
      }
    }
    animate(state, opts = {}, done) {
      const options = { ...ANIMATE_DEFAULTS, ...opts };
      const valid = this.validateState(state);
      const easing = easings[options.easing];
      const start = Date.now();
      const initial = this.getState();
      const step = () => {
        const t = (Date.now() - start) / options.duration;
        if (t >= 1) {
          this.nextFrame = null;
          this.setState(valid);
          if (this.animationCallback) {
            const cb = this.animationCallback;
            this.animationCallback = void 0;
            cb();
          }
          return;
        }
        const k = easing(t);
        const next = {};
        if (typeof valid.x === "number") next.x = initial.x + (valid.x - initial.x) * k;
        if (typeof valid.y === "number") next.y = initial.y + (valid.y - initial.y) * k;
        if (typeof valid.ratio === "number") next.ratio = initial.ratio + (valid.ratio - initial.ratio) * k;
        this.setState(next);
        this.nextFrame = this.win.requestAnimationFrame(step);
      };
      if (this.nextFrame !== null) {
        this.win.cancelAnimationFrame(this.nextFrame);
        if (this.animationCallback) this.animationCallback();
        this.nextFrame = this.win.requestAnimationFrame(step);
      } else {
        step();
      }
      this.animationCallback = done;
    }
  };

  // web/vendor/engine/captor.ts
  var DOUBLE_CLICK_TIMEOUT = 300;
  var DRAG_TIMEOUT = 100;
  var DRAGGED_EVENTS_TOLERANCE = 3;
  var INERTIA_DURATION = 200;
  var INERTIA_RATIO = 3;
  var TOUCH_TAP_SLOP_PX = 10;
  var TOUCH_DOUBLE_TAP_PX = 24;
  function getPosition(e, dom) {
    const bbox = dom.getBoundingClientRect();
    return { x: e.clientX - bbox.left, y: e.clientY - bbox.top };
  }
  function getMouseCoords(e, dom) {
    const res = {
      ...getPosition(e, dom),
      defaultPrevented: false,
      preventDefault: () => {
        res.defaultPrevented = true;
      },
      original: e
    };
    return res;
  }
  function getTouchCoords(e, at) {
    const res = {
      ...at,
      defaultPrevented: false,
      fat: true,
      preventDefault: () => {
        res.defaultPrevented = true;
      },
      original: e
    };
    return res;
  }
  function touchPoints(e, dom) {
    const out = [];
    for (let i = 0; i < e.touches.length && i < 2; i++) out.push(getPosition(e.touches[i], dom));
    return out;
  }
  var midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  var spread = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function getWheelDelta(e) {
    return e.deltaY * -3 / 360;
  }
  var MouseCaptor = class extends Emitter {
    constructor(container, host, win) {
      super();
      __publicField(this, "container", container);
      __publicField(this, "host", host);
      __publicField(this, "win", win);
      __publicField(this, "draggedEvents", 0);
      __publicField(this, "isMoving", false);
      __publicField(this, "currentWheelDirection", 0);
      __publicField(this, "lastMouseX", null);
      __publicField(this, "lastMouseY", null);
      __publicField(this, "isMouseDown", false);
      __publicField(this, "movingTimeout", null);
      __publicField(this, "clicks", 0);
      __publicField(this, "doubleClickTimeout", null);
      __publicField(this, "lastWheelTriggerTime", null);
      // github#73
      __publicField(this, "touchStart", null);
      __publicField(this, "lastTouch", null);
      __publicField(this, "touchMoved", false);
      __publicField(this, "pinchSpread", null);
      __publicField(this, "pinchRatio", 1);
      __publicField(this, "maxTouches", 0);
      __publicField(this, "lastTapAt", null);
      __publicField(this, "tapTimeout", null);
      __publicField(this, "doc");
      __publicField(this, "handleClick", (e) => {
        this.clicks++;
        if (this.clicks === 2) {
          this.clicks = 0;
          if (this.doubleClickTimeout !== null) {
            this.win.clearTimeout(this.doubleClickTimeout);
            this.doubleClickTimeout = null;
          }
          this.handleDoubleClick(e);
          return;
        }
        this.doubleClickTimeout = this.win.setTimeout(() => {
          this.clicks = 0;
          this.doubleClickTimeout = null;
        }, DOUBLE_CLICK_TIMEOUT);
        if (this.draggedEvents < DRAGGED_EVENTS_TOLERANCE) this.emit("click", getMouseCoords(e, this.container));
      });
      __publicField(this, "handleRightClick", (e) => {
        this.emit("rightClick", getMouseCoords(e, this.container));
      });
      __publicField(this, "handleDown", (e) => {
        if (e.button === 0) {
          const { x, y } = getPosition(e, this.container);
          this.lastMouseX = x;
          this.lastMouseY = y;
          this.draggedEvents = 0;
          this.isMouseDown = true;
        }
        this.emit("mousedown", getMouseCoords(e, this.container));
      });
      __publicField(this, "handleUp", (e) => {
        if (!this.isMouseDown) return;
        const camera = this.host.getCamera();
        this.isMouseDown = false;
        if (this.movingTimeout !== null) {
          this.win.clearTimeout(this.movingTimeout);
          this.movingTimeout = null;
        }
        const { x, y } = getPosition(e, this.container);
        const cameraState = camera.getState();
        if (this.isMoving) {
          this.glide();
        } else if (this.lastMouseX !== x || this.lastMouseY !== y) {
          camera.setState({ x: cameraState.x, y: cameraState.y });
        }
        this.isMoving = false;
        this.win.setTimeout(() => {
          this.draggedEvents = 0;
        }, 0);
        this.emit("mouseup", getMouseCoords(e, this.container));
      });
      __publicField(this, "handleMove", (e) => {
        const coords = getMouseCoords(e, this.container);
        this.emit("mousemovebody", coords);
        if (e.target === this.container || e.composedPath()[0] === this.container) this.emit("mousemove", coords);
        if (coords.defaultPrevented) return;
        if (this.isMouseDown) {
          this.isMoving = true;
          this.draggedEvents++;
          if (this.movingTimeout !== null) this.win.clearTimeout(this.movingTimeout);
          this.movingTimeout = this.win.setTimeout(() => {
            this.movingTimeout = null;
            this.isMoving = false;
          }, DRAG_TIMEOUT);
          const { x: eX, y: eY } = getPosition(e, this.container);
          this.panFrom({ x: this.lastMouseX ?? eX, y: this.lastMouseY ?? eY }, { x: eX, y: eY });
          this.lastMouseX = eX;
          this.lastMouseY = eY;
          e.preventDefault();
          e.stopPropagation();
        }
      });
      __publicField(this, "handleLeave", (e) => {
        this.emit("mouseleave", getMouseCoords(e, this.container));
      });
      __publicField(this, "handleEnter", (e) => {
        this.emit("mouseenter", getMouseCoords(e, this.container));
      });
      __publicField(this, "handleWheel", (e) => {
        const camera = this.host.getCamera();
        if (!camera.enabledZooming) return;
        const delta = getWheelDelta(e);
        if (!delta) return;
        const coords = { ...getMouseCoords(e, this.container), delta };
        this.emit("wheel", coords);
        if (coords.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const currentRatio = camera.getState().ratio;
        const ratioDiff = delta > 0 ? 1 / this.host.zoomingRatio : this.host.zoomingRatio;
        const newRatio = camera.getBoundedRatio(currentRatio * ratioDiff);
        const wheelDirection = delta > 0 ? 1 : -1;
        const now = Date.now();
        if (currentRatio === newRatio) return;
        e.preventDefault();
        e.stopPropagation();
        if (this.currentWheelDirection === wheelDirection && this.lastWheelTriggerTime !== null && now - this.lastWheelTriggerTime < this.host.zoomDuration / 5) {
          return;
        }
        camera.animate(
          this.host.getViewportZoomedState(getPosition(e, this.container), newRatio),
          { easing: "quadraticOut", duration: this.host.zoomDuration },
          () => {
            this.currentWheelDirection = 0;
          }
        );
        this.currentWheelDirection = wheelDirection;
        this.lastWheelTriggerTime = now;
      });
      /* ------------------------------------------------------------------ touch
       * github#73, design/0013
       */
      __publicField(this, "handleTouchStart", (e) => {
        e.preventDefault();
        const pts = touchPoints(e, this.container);
        if (!pts.length) return;
        this.host.getCamera().stopAnimation();
        if (this.lastTouch === null) {
          this.touchMoved = false;
          this.touchStart = pts[0];
          this.maxTouches = 0;
        }
        this.maxTouches = Math.max(this.maxTouches, e.touches.length);
        this.lastTouch = pts.length > 1 ? midpoint(pts[0], pts[1]) : pts[0];
        if (pts.length > 1) {
          this.pinchSpread = spread(pts[0], pts[1]);
          this.pinchRatio = this.host.getCamera().getState().ratio;
        } else {
          this.pinchSpread = null;
        }
      });
      __publicField(this, "handleTouchMove", (e) => {
        e.preventDefault();
        const pts = touchPoints(e, this.container);
        if (!pts.length) return;
        if (pts.length > 1) {
          const now = spread(pts[0], pts[1]);
          if (this.pinchSpread === null || this.pinchSpread <= 0) {
            this.pinchSpread = now;
            this.pinchRatio = this.host.getCamera().getState().ratio;
          } else if (now > 0) {
            this.touchMoved = true;
            this.zoomAbout(midpoint(pts[0], pts[1]), this.pinchRatio * (this.pinchSpread / now));
          }
          this.lastTouch = midpoint(pts[0], pts[1]);
          return;
        }
        if (this.touchStart && spread(this.touchStart, pts[0]) > TOUCH_TAP_SLOP_PX) this.touchMoved = true;
        if (!this.touchMoved) {
          this.lastTouch = pts[0];
          return;
        }
        this.panFrom(this.lastTouch ?? pts[0], pts[0]);
        this.lastTouch = pts[0];
        this.isMoving = true;
        if (this.movingTimeout !== null) this.win.clearTimeout(this.movingTimeout);
        this.movingTimeout = this.win.setTimeout(() => {
          this.movingTimeout = null;
          this.isMoving = false;
        }, DRAG_TIMEOUT);
      });
      __publicField(this, "handleTouchEnd", (e) => {
        e.preventDefault();
        if (e.touches.length) {
          const pts = touchPoints(e, this.container);
          this.lastTouch = pts.length > 1 ? midpoint(pts[0], pts[1]) : pts[0] ?? this.lastTouch;
          this.pinchSpread = pts.length > 1 ? spread(pts[0], pts[1]) : null;
          if (pts.length > 1) this.pinchRatio = this.host.getCamera().getState().ratio;
          return;
        }
        const at = this.lastTouch;
        const moved = this.touchMoved;
        const fingers = this.maxTouches;
        this.touchStart = null;
        this.lastTouch = null;
        this.pinchSpread = null;
        this.touchMoved = false;
        this.maxTouches = 0;
        if (this.movingTimeout !== null) {
          this.win.clearTimeout(this.movingTimeout);
          this.movingTimeout = null;
        }
        if (moved) {
          if (this.isMoving) this.glide();
          this.isMoving = false;
          return;
        }
        this.isMoving = false;
        if (!at || fingers !== 1) return;
        const near = this.lastTapAt !== null && spread(this.lastTapAt, at) <= TOUCH_DOUBLE_TAP_PX;
        if (this.tapTimeout !== null) {
          this.win.clearTimeout(this.tapTimeout);
          this.tapTimeout = null;
        }
        if (near) {
          this.lastTapAt = null;
          this.emit("doubleClick", getTouchCoords(e, at));
          return;
        }
        this.lastTapAt = at;
        this.tapTimeout = this.win.setTimeout(() => {
          this.lastTapAt = null;
          this.tapTimeout = null;
        }, DOUBLE_CLICK_TIMEOUT);
        this.emit("click", getTouchCoords(e, at));
      });
      __publicField(this, "handleTouchCancel", (e) => {
        if (e.touches.length) {
          const pts = touchPoints(e, this.container);
          this.lastTouch = pts.length > 1 ? midpoint(pts[0], pts[1]) : pts[0] ?? this.lastTouch;
          this.pinchSpread = pts.length > 1 ? spread(pts[0], pts[1]) : null;
          return;
        }
        this.touchStart = null;
        this.lastTouch = null;
        this.pinchSpread = null;
        this.touchMoved = false;
        this.maxTouches = 0;
        this.isMoving = false;
        if (this.movingTimeout !== null) {
          this.win.clearTimeout(this.movingTimeout);
          this.movingTimeout = null;
        }
      });
      this.doc = container.ownerDocument;
      container.addEventListener("click", this.handleClick);
      container.addEventListener("contextmenu", this.handleRightClick);
      container.addEventListener("mousedown", this.handleDown);
      container.addEventListener("wheel", this.handleWheel);
      container.addEventListener("mouseleave", this.handleLeave);
      container.addEventListener("mouseenter", this.handleEnter);
      this.doc.addEventListener("mousemove", this.handleMove);
      this.doc.addEventListener("mouseup", this.handleUp);
      container.addEventListener("touchstart", this.handleTouchStart, { passive: false });
      container.addEventListener("touchmove", this.handleTouchMove, { passive: false });
      container.addEventListener("touchend", this.handleTouchEnd, { passive: false });
      container.addEventListener("touchcancel", this.handleTouchCancel);
    }
    kill() {
      const c = this.container;
      c.removeEventListener("click", this.handleClick);
      c.removeEventListener("contextmenu", this.handleRightClick);
      c.removeEventListener("mousedown", this.handleDown);
      c.removeEventListener("wheel", this.handleWheel);
      c.removeEventListener("mouseleave", this.handleLeave);
      c.removeEventListener("mouseenter", this.handleEnter);
      this.doc.removeEventListener("mousemove", this.handleMove);
      this.doc.removeEventListener("mouseup", this.handleUp);
      c.removeEventListener("touchstart", this.handleTouchStart);
      c.removeEventListener("touchmove", this.handleTouchMove);
      c.removeEventListener("touchend", this.handleTouchEnd);
      c.removeEventListener("touchcancel", this.handleTouchCancel);
      if (this.movingTimeout !== null) this.win.clearTimeout(this.movingTimeout);
      if (this.doubleClickTimeout !== null) this.win.clearTimeout(this.doubleClickTimeout);
      if (this.tapTimeout !== null) this.win.clearTimeout(this.tapTimeout);
      this.removeAllListeners();
    }
    handleDoubleClick(e) {
      e.preventDefault();
      e.stopPropagation();
      this.emit("doubleClick", getMouseCoords(e, this.container));
    }
    /* -------------------------------------------------------- shared motion */
    panFrom(prev, next) {
      const camera = this.host.getCamera();
      const from = this.host.viewportToFramedGraph(prev);
      const to = this.host.viewportToFramedGraph(next);
      const state = camera.getState();
      camera.setState({ x: state.x + (from.x - to.x), y: state.y + (from.y - to.y) });
    }
    glide() {
      const camera = this.host.getCamera();
      const state = camera.getState();
      const previous = camera.getPreviousState();
      camera.animate({
        x: state.x + INERTIA_RATIO * (state.x - previous.x),
        y: state.y + INERTIA_RATIO * (state.y - previous.y)
      }, { duration: INERTIA_DURATION, easing: "quadraticOut" });
    }
    zoomAbout(target, ratio) {
      const camera = this.host.getCamera();
      if (!camera.enabledZooming) return;
      const bounded = camera.getBoundedRatio(ratio);
      if (bounded === camera.getState().ratio) return;
      camera.setState(this.host.getViewportZoomedState(target, bounded));
    }
  };

  // web/vendor/engine/colors.ts
  var INT8 = new Int8Array(4);
  var INT32 = new Int32Array(INT8.buffer, 0, 1);
  var FLOAT32 = new Float32Array(INT8.buffer, 0, 1);
  var RGBA_TEST = /^\s*rgba?\s*\(/;
  var RGBA_EXTRACT = /^\s*rgba?\s*\(\s*([0-9]*)\s*,\s*([0-9]*)\s*,\s*([0-9]*)(?:\s*,\s*(.*)?)?\)\s*$/;
  function parseColor(val) {
    let r = 0, g = 0, b = 0, a = 1;
    if (val[0] === "#") {
      if (val.length === 4) {
        r = parseInt(val.charAt(1) + val.charAt(1), 16);
        g = parseInt(val.charAt(2) + val.charAt(2), 16);
        b = parseInt(val.charAt(3) + val.charAt(3), 16);
      } else {
        r = parseInt(val.charAt(1) + val.charAt(2), 16);
        g = parseInt(val.charAt(3) + val.charAt(4), 16);
        b = parseInt(val.charAt(5) + val.charAt(6), 16);
      }
      if (val.length === 9) a = parseInt(val.charAt(7) + val.charAt(8), 16) / 255;
      return { r, g, b, a };
    }
    if (RGBA_TEST.test(val)) {
      const match = RGBA_EXTRACT.exec(val);
      if (match) {
        r = +match[1];
        g = +match[2];
        b = +match[3];
        if (match[4]) a = +match[4];
      }
      return { r, g, b, a };
    }
    return null;
  }
  function rgbaToFloat(r, g, b, a) {
    INT32[0] = (a << 24 | b << 16 | g << 8 | r) & 4278190079;
    return FLOAT32[0];
  }
  var CACHE_LIMIT = 2e5;
  var cache = /* @__PURE__ */ new Map();
  var scratch = null;
  function normalise(val) {
    if (!scratch) scratch = new OffscreenCanvas(1, 1).getContext("2d");
    if (!scratch) return "#000000";
    scratch.fillStyle = "#000000";
    scratch.fillStyle = val;
    return scratch.fillStyle;
  }
  function floatColor(val) {
    const direct = cache.get(val);
    if (direct !== void 0) return direct;
    const key = val.toLowerCase();
    let color = cache.get(key);
    if (color === void 0) {
      let parsed = parseColor(key);
      if (!parsed) parsed = parseColor(normalise(key).toLowerCase()) ?? { r: 0, g: 0, b: 0, a: 1 };
      color = rgbaToFloat(parsed.r, parsed.g, parsed.b, parsed.a * 255 | 0);
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, color);
    }
    if (val !== key) cache.set(val, color);
    return color;
  }

  // web/vendor/engine/programs.ts
  var BIAS = "const float bias = 255.0 / 254.0;";
  function slots(attr) {
    return attr.type === "ubyte" ? 1 : attr.size;
  }
  function bytes(attr) {
    return attr.type === "ubyte" ? attr.size : attr.size * 4;
  }
  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("vault-graph: could not create a shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "";
      gl.deleteShader(shader);
      throw new Error("vault-graph: shader failed to compile:\n" + log + "\n" + source);
    }
    return shader;
  }
  var Program = class {
    constructor(gl, doc, def) {
      __publicField(this, "gl", gl);
      __publicField(this, "doc", doc);
      __publicField(this, "def", def);
      __publicField(this, "array", new Float32Array(0));
      __publicField(this, "capacity", 0);
      __publicField(this, "stride");
      __publicField(this, "constantArray");
      __publicField(this, "constantSlots");
      __publicField(this, "program");
      __publicField(this, "vertexShader");
      __publicField(this, "fragmentShader");
      __publicField(this, "buffer");
      __publicField(this, "constantBuffer");
      __publicField(this, "uniforms", /* @__PURE__ */ new Map());
      __publicField(this, "locations", /* @__PURE__ */ new Map());
      this.stride = def.attributes.reduce((n, a) => n + slots(a), 0);
      this.constantSlots = def.constantAttributes.reduce((n, a) => n + slots(a), 0);
      if (def.constantData.length !== def.vertices) {
        throw new Error(`vault-graph: program wants ${def.vertices} constant rows, got ${def.constantData.length}`);
      }
      this.constantArray = new Float32Array(def.vertices * this.constantSlots);
      def.constantData.forEach((row, i) => {
        if (row.length !== this.constantSlots) throw new Error("vault-graph: constant row has the wrong width");
        row.forEach((v, j) => {
          this.constantArray[i * this.constantSlots + j] = v;
        });
      });
      const buffer = gl.createBuffer();
      const constantBuffer = gl.createBuffer();
      if (!buffer || !constantBuffer) throw new Error("vault-graph: could not create a WebGL buffer");
      this.buffer = buffer;
      this.constantBuffer = constantBuffer;
      this.vertexShader = compile(gl, gl.VERTEX_SHADER, def.vertexShader);
      this.fragmentShader = compile(gl, gl.FRAGMENT_SHADER, def.fragmentShader);
      const program = gl.createProgram();
      if (!program) throw new Error("vault-graph: could not create a WebGL program");
      gl.attachShader(program, this.vertexShader);
      gl.attachShader(program, this.fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        throw new Error("vault-graph: WebGL program failed to link");
      }
      this.program = program;
      for (const name of def.uniforms) {
        const loc = gl.getUniformLocation(program, name);
        if (loc) this.uniforms.set(name, loc);
      }
      for (const attr of [...def.attributes, ...def.constantAttributes]) {
        this.locations.set(attr.name, gl.getAttribLocation(program, attr.name));
      }
    }
    reallocate(capacity) {
      if (capacity === this.capacity) return;
      this.capacity = capacity;
      this.array = new Float32Array(capacity * this.stride);
    }
    render(params) {
      if (this.capacity === 0) return;
      const gl = this.gl;
      gl.viewport(0, 0, params.width * params.pixelRatio, params.height * params.pixelRatio);
      this.bind();
      gl.enable(gl.BLEND);
      gl.useProgram(this.program);
      this.setUniforms(params);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.def.vertices, this.capacity);
      this.unbind();
    }
    kill() {
      const gl = this.gl;
      gl.deleteShader(this.vertexShader);
      gl.deleteShader(this.fragmentShader);
      gl.deleteProgram(this.program);
      gl.deleteBuffer(this.buffer);
      gl.deleteBuffer(this.constantBuffer);
    }
    uniform(name) {
      return this.uniforms.get(name) ?? null;
    }
    zero(index) {
      this.array.fill(0, index, index + this.stride);
    }
    bind() {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.constantBuffer);
      let offset = 0;
      for (const attr of this.def.constantAttributes) offset += this.bindAttribute(attr, offset, this.constantSlots * 4, 0);
      gl.bufferData(gl.ARRAY_BUFFER, this.constantArray, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      offset = 0;
      for (const attr of this.def.attributes) offset += this.bindAttribute(attr, offset, this.stride * 4, 1);
      gl.bufferData(gl.ARRAY_BUFFER, this.array, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    bindAttribute(attr, offset, strideBytes, divisor) {
      const gl = this.gl;
      const location = this.locations.get(attr.name);
      if (location !== void 0 && location !== -1) {
        gl.enableVertexAttribArray(location);
        const glType = attr.type === "ubyte" ? gl.UNSIGNED_BYTE : gl.FLOAT;
        gl.vertexAttribPointer(location, attr.size, glType, attr.type === "ubyte", strideBytes, offset);
        gl.vertexAttribDivisor(location, divisor);
      }
      return bytes(attr);
    }
    unbind() {
      const gl = this.gl;
      for (const attr of [...this.def.constantAttributes, ...this.def.attributes]) {
        const location = this.locations.get(attr.name);
        if (location !== void 0 && location !== -1) {
          gl.disableVertexAttribArray(location);
          gl.vertexAttribDivisor(location, 0);
        }
      }
    }
  };
  var NodeProgram = class extends Program {
    process(offset, data) {
      const i = offset * this.stride;
      if (data.hidden) {
        this.zero(i);
        return;
      }
      this.processVisible(i, data);
    }
  };
  var THIRD = 2 * Math.PI / 3;
  var DISC_CONSTANTS = {
    constantAttributes: [{ name: "a_angle", size: 1, type: "float" }],
    constantData: [[0], [THIRD], [2 * THIRD]]
  };
  var CIRCLE_VERTEX = `
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;

${BIAS}

void main() {
  float size = a_size * u_correctionRatio / u_sizeRatio * 4.0;
  vec2 diffVector = size * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4(
    (u_matrix * vec3(position, 1)).xy,
    0,
    1
  );

  v_diffVector = diffVector;
  v_radius = size / 2.0;

  v_color = a_color;
  v_color.a *= bias;
}
`;
  var CIRCLE_FRAGMENT = `
precision highp float;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;

uniform float u_correctionRatio;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  float border = u_correctionRatio * 2.0;
  float dist = length(v_diffVector) - v_radius + border;

  float t = 0.0;
  if (dist > border)
    t = 1.0;
  else if (dist > 0.0)
    t = dist / border;

  gl_FragColor = mix(v_color, transparent, t);
}
`;
  var NodeCircleProgram = class extends NodeProgram {
    constructor(gl, doc) {
      super(gl, doc, {
        vertices: 3,
        vertexShader: CIRCLE_VERTEX,
        fragmentShader: CIRCLE_FRAGMENT,
        uniforms: ["u_sizeRatio", "u_correctionRatio", "u_matrix"],
        attributes: [
          { name: "a_position", size: 2, type: "float" },
          { name: "a_size", size: 1, type: "float" },
          { name: "a_color", size: 4, type: "ubyte" }
        ],
        ...DISC_CONSTANTS
      });
    }
    processVisible(i, data) {
      const a = this.array;
      a[i++] = data.x;
      a[i++] = data.y;
      a[i++] = data.size;
      a[i++] = floatColor(data.color);
    }
    setUniforms(p) {
      const gl = this.gl;
      gl.uniform1f(this.uniform("u_correctionRatio"), p.correctionRatio);
      gl.uniform1f(this.uniform("u_sizeRatio"), p.sizeRatio);
      gl.uniformMatrix3fv(this.uniform("u_matrix"), false, p.matrix);
    }
  };
  var HALO_VERTEX = `
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec2 v_diffVector;
varying float v_radius;

attribute vec4 a_borderColor_1;
varying vec4 v_borderColor_1;
attribute vec4 a_borderColor_2;
varying vec4 v_borderColor_2;

${BIAS}
const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main() {
  float size = a_size * u_correctionRatio / u_sizeRatio * 4.0;
  vec2 diffVector = size * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4(
    (u_matrix * vec3(position, 1)).xy,
    0,
    1
  );

  v_radius = size / 2.0;
  v_diffVector = diffVector;

  v_borderColor_1 = a_borderColor_1;
  v_borderColor_2 = a_borderColor_2;
}
`;
  var HALO_FRAGMENT = `
precision highp float;

varying vec2 v_diffVector;
varying float v_radius;

varying vec4 v_borderColor_1;
varying vec4 v_borderColor_2;

uniform float u_correctionRatio;

${BIAS}
const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  float dist = length(v_diffVector);
  float aaBorder = 2.0 * u_correctionRatio;
  float v_borderSize_0 = v_radius;
  vec4 v_borderColor_0 = transparent;

  // Sizes:
  float borderSize_1 = v_radius * 0.26;
  // Now, let's split the remaining space between "fill" borders:
  float fillBorderSize = (v_radius - (borderSize_1) ) / 1.0;
  float borderSize_2 = fillBorderSize;

  // Finally, normalize all border sizes, to start from the full size and to end with the smallest:
  float adjustedBorderSize_0 = v_radius;
  float adjustedBorderSize_1 = adjustedBorderSize_0 - borderSize_1;
  float adjustedBorderSize_2 = adjustedBorderSize_1 - borderSize_2;

  // Colors:
  vec4 borderColor_0 = transparent;
  vec4 borderColor_1 = v_borderColor_1;
  borderColor_1.a *= bias;
  if (borderSize_1 <= 1.0 * u_correctionRatio) { borderColor_1 = borderColor_0; }
  vec4 borderColor_2 = v_borderColor_2;
  borderColor_2.a *= bias;
  if (borderSize_2 <= 1.0 * u_correctionRatio) { borderColor_2 = borderColor_1; }

  if (dist > adjustedBorderSize_0) {
    gl_FragColor = borderColor_0;
  } else if (dist > adjustedBorderSize_0 - aaBorder) {
    gl_FragColor = mix(borderColor_1, borderColor_0, (dist - adjustedBorderSize_0 + aaBorder) / aaBorder);
  } else if (dist > adjustedBorderSize_1) {
    gl_FragColor = borderColor_1;
  } else if (dist > adjustedBorderSize_1 - aaBorder) {
    gl_FragColor = mix(borderColor_2, borderColor_1, (dist - adjustedBorderSize_1 + aaBorder) / aaBorder);
  } else if (dist > adjustedBorderSize_2) {
    gl_FragColor = borderColor_2;
  } else { /* Nothing to add here */ }
}
`;
  var DEFAULT_HALO_COLOR = "#000000";
  var NodeHaloProgram = class extends NodeProgram {
    constructor(gl, doc) {
      super(gl, doc, {
        vertices: 3,
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        uniforms: ["u_sizeRatio", "u_correctionRatio", "u_matrix"],
        attributes: [
          { name: "a_position", size: 2, type: "float" },
          { name: "a_size", size: 1, type: "float" },
          { name: "a_borderColor_1", size: 4, type: "ubyte" },
          { name: "a_borderColor_2", size: 4, type: "ubyte" }
        ],
        ...DISC_CONSTANTS
      });
    }
    processVisible(i, data) {
      const a = this.array;
      a[i++] = data.x;
      a[i++] = data.y;
      a[i++] = data.size;
      a[i++] = floatColor(data.haloColor || DEFAULT_HALO_COLOR);
      a[i++] = floatColor(data.color || DEFAULT_HALO_COLOR);
    }
    setUniforms(p) {
      const gl = this.gl;
      gl.uniform1f(this.uniform("u_correctionRatio"), p.correctionRatio);
      gl.uniform1f(this.uniform("u_sizeRatio"), p.sizeRatio);
      gl.uniformMatrix3fv(this.uniform("u_matrix"), false, p.matrix);
    }
  };
  var EdgeProgram = class extends Program {
    process(offset, source, target, data) {
      const i = offset * this.stride;
      if (data.hidden || source.hidden || target.hidden) {
        this.zero(i);
        return;
      }
      this.processVisible(i, source, target, data);
    }
  };
  var LINE_VERTEX = `
attribute vec4 a_color;
attribute vec2 a_normal;
attribute float a_normalCoef;
attribute vec2 a_positionStart;
attribute vec2 a_positionEnd;
attribute float a_positionCoef;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_zoomRatio;
uniform float u_pixelRatio;
uniform float u_correctionRatio;
uniform float u_minEdgeThickness;
uniform float u_feather;

varying vec4 v_color;
varying vec2 v_normal;
varying float v_thickness;
varying float v_feather;

${BIAS}

void main() {
  float minThickness = u_minEdgeThickness;

  vec2 normal = a_normal * a_normalCoef;
  vec2 position = a_positionStart * (1.0 - a_positionCoef) + a_positionEnd * a_positionCoef;

  float normalLength = length(normal);
  vec2 unitNormal = normal / normalLength;

  // We require edges to be at least "minThickness" pixels thick *on screen*
  // (so we need to compensate the size ratio):
  float pixelsThickness = max(normalLength, minThickness * u_sizeRatio);

  // Then, we need to retrieve the normalized thickness of the edge in the WebGL
  // referential (in a ([0, 1], [0, 1]) space), using our "magic" correction
  // ratio:
  float webGLThickness = pixelsThickness * u_correctionRatio / u_sizeRatio;

  // Here is the proper position of the vertex
  gl_Position = vec4((u_matrix * vec3(position + unitNormal * webGLThickness, 1)).xy, 0, 1);

  // For the fragment shader though, we need a thickness that takes the "magic"
  // correction ratio into account (as in webGLThickness), but so that the
  // antialiasing effect does not depend on the zoom level. So here's yet
  // another thickness version:
  v_thickness = webGLThickness / u_zoomRatio;

  v_normal = unitNormal;

  v_feather = u_feather * u_correctionRatio / u_zoomRatio / u_pixelRatio * 2.0;

  v_color = a_color;
  v_color.a *= bias;
}
`;
  var LINE_FRAGMENT = `
precision mediump float;

varying vec4 v_color;
varying vec2 v_normal;
varying float v_thickness;
varying float v_feather;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  float dist = length(v_normal) * v_thickness;

  float t = smoothstep(
    v_thickness - v_feather,
    v_thickness,
    dist
  );

  gl_FragColor = mix(v_color, transparent, t);
}
`;
  var EdgeLineProgram = class extends EdgeProgram {
    constructor(gl, doc) {
      super(gl, doc, {
        vertices: 6,
        vertexShader: LINE_VERTEX,
        fragmentShader: LINE_FRAGMENT,
        uniforms: ["u_matrix", "u_zoomRatio", "u_sizeRatio", "u_correctionRatio", "u_pixelRatio", "u_feather", "u_minEdgeThickness"],
        attributes: [
          { name: "a_positionStart", size: 2, type: "float" },
          { name: "a_positionEnd", size: 2, type: "float" },
          { name: "a_normal", size: 2, type: "float" },
          { name: "a_color", size: 4, type: "ubyte" }
        ],
        constantAttributes: [
          { name: "a_positionCoef", size: 1, type: "float" },
          { name: "a_normalCoef", size: 1, type: "float" }
        ],
        constantData: [[0, 1], [0, -1], [1, 1], [1, 1], [0, -1], [1, -1]]
      });
    }
    processVisible(i, source, target, data) {
      const thickness = data.size || 1;
      const x1 = source.x, y1 = source.y, x2 = target.x, y2 = target.y;
      const dx = x2 - x1, dy = y2 - y1;
      let len = dx * dx + dy * dy;
      let n1 = 0, n2 = 0;
      if (len) {
        len = 1 / Math.sqrt(len);
        n1 = -dy * len * thickness;
        n2 = dx * len * thickness;
      }
      const a = this.array;
      a[i++] = x1;
      a[i++] = y1;
      a[i++] = x2;
      a[i++] = y2;
      a[i++] = n1;
      a[i++] = n2;
      a[i++] = floatColor(data.color);
    }
    setUniforms(p) {
      const gl = this.gl;
      gl.uniformMatrix3fv(this.uniform("u_matrix"), false, p.matrix);
      gl.uniform1f(this.uniform("u_zoomRatio"), p.zoomRatio);
      gl.uniform1f(this.uniform("u_sizeRatio"), p.sizeRatio);
      gl.uniform1f(this.uniform("u_correctionRatio"), p.correctionRatio);
      gl.uniform1f(this.uniform("u_pixelRatio"), p.pixelRatio);
      gl.uniform1f(this.uniform("u_feather"), p.antiAliasingFeather);
      gl.uniform1f(this.uniform("u_minEdgeThickness"), p.minEdgeThickness);
    }
  };
  var CURVE_VERTEX = `
attribute vec4 a_color;
attribute float a_direction;
attribute float a_thickness;
attribute vec2 a_source;
attribute vec2 a_target;
attribute float a_current;
attribute float a_curvature;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_pixelRatio;
uniform vec2 u_dimensions;
uniform float u_minEdgeThickness;
uniform float u_feather;

varying vec4 v_color;
varying float v_thickness;
varying float v_feather;
varying vec2 v_cpA;
varying vec2 v_cpB;
varying vec2 v_cpC;

${BIAS}
const float epsilon = 0.7;

vec2 clipspaceToViewport(vec2 pos, vec2 dimensions) {
  return vec2(
    (pos.x + 1.0) * dimensions.x / 2.0,
    (pos.y + 1.0) * dimensions.y / 2.0
  );
}

vec2 viewportToClipspace(vec2 pos, vec2 dimensions) {
  return vec2(
    pos.x / dimensions.x * 2.0 - 1.0,
    pos.y / dimensions.y * 2.0 - 1.0
  );
}

void main() {
  float minThickness = u_minEdgeThickness;

  // Selecting the correct position
  // Branchless "position = a_source if a_current == 1.0 else a_target"
  vec2 position = a_source * max(0.0, a_current) + a_target * max(0.0, 1.0 - a_current);
  position = (u_matrix * vec3(position, 1)).xy;

  vec2 source = (u_matrix * vec3(a_source, 1)).xy;
  vec2 target = (u_matrix * vec3(a_target, 1)).xy;

  vec2 viewportPosition = clipspaceToViewport(position, u_dimensions);
  vec2 viewportSource = clipspaceToViewport(source, u_dimensions);
  vec2 viewportTarget = clipspaceToViewport(target, u_dimensions);

  vec2 delta = viewportTarget.xy - viewportSource.xy;
  float len = length(delta);
  vec2 normal = vec2(-delta.y, delta.x) * a_direction;
  vec2 unitNormal = normal / len;
  float boundingBoxThickness = len * a_curvature;

  float curveThickness = max(minThickness, a_thickness / u_sizeRatio);
  v_thickness = curveThickness * u_pixelRatio;
  v_feather = u_feather;

  v_cpA = viewportSource;
  v_cpB = 0.5 * (viewportSource + viewportTarget) + unitNormal * a_direction * boundingBoxThickness;
  v_cpC = viewportTarget;

  vec2 viewportOffsetPosition = (
    viewportPosition +
    unitNormal * (boundingBoxThickness / 2.0 + sign(boundingBoxThickness) * (curveThickness + epsilon)) *
    max(0.0, a_direction) // NOTE: cutting the bounding box in half to avoid overdraw
  );

  position = viewportToClipspace(viewportOffsetPosition, u_dimensions);
  gl_Position = vec4(position, 0, 1);

  v_color = a_color;
  v_color.a *= bias;
}
`;
  var CURVE_FRAGMENT = `
precision highp float;

varying vec4 v_color;
varying float v_thickness;
varying float v_feather;
varying vec2 v_cpA;
varying vec2 v_cpB;
varying vec2 v_cpC;

float det(vec2 a, vec2 b) {
  return a.x * b.y - b.x * a.y;
}

vec2 getDistanceVector(vec2 b0, vec2 b1, vec2 b2) {
  float a = det(b0, b2), b = 2.0 * det(b1, b0), d = 2.0 * det(b2, b1);
  float f = b * d - a * a;
  vec2 d21 = b2 - b1, d10 = b1 - b0, d20 = b2 - b0;
  vec2 gf = 2.0 * (b * d21 + d * d10 + a * d20);
  gf = vec2(gf.y, -gf.x);
  vec2 pp = -f * gf / dot(gf, gf);
  vec2 d0p = b0 - pp;
  float ap = det(d0p, d20), bp = 2.0 * det(d10, d0p);
  float t = clamp((ap + bp) / (2.0 * a + b + d), 0.0, 1.0);
  return mix(mix(b0, b1, t), mix(b1, b2, t), t);
}

float distToQuadraticBezierCurve(vec2 p, vec2 b0, vec2 b1, vec2 b2) {
  return length(getDistanceVector(b0 - p, b1 - p, b2 - p));
}

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  float dist = distToQuadraticBezierCurve(gl_FragCoord.xy, v_cpA, v_cpB, v_cpC);
  float thickness = v_thickness;

  float halfThickness = thickness / 2.0;
  if (dist < halfThickness) {
    float t = smoothstep(
      halfThickness - v_feather,
      halfThickness,
      dist
    );

    gl_FragColor = mix(v_color, transparent, t);
  } else {
    gl_FragColor = transparent;
  }
}
`;
  var DEFAULT_CURVATURE = 0.25;
  var EdgeCurveProgram = class extends EdgeProgram {
    constructor(gl, doc) {
      super(gl, doc, {
        vertices: 6,
        vertexShader: CURVE_VERTEX,
        fragmentShader: CURVE_FRAGMENT,
        uniforms: ["u_matrix", "u_sizeRatio", "u_dimensions", "u_pixelRatio", "u_feather", "u_minEdgeThickness"],
        attributes: [
          { name: "a_source", size: 2, type: "float" },
          { name: "a_target", size: 2, type: "float" },
          { name: "a_thickness", size: 1, type: "float" },
          { name: "a_curvature", size: 1, type: "float" },
          { name: "a_color", size: 4, type: "ubyte" }
        ],
        constantAttributes: [
          { name: "a_current", size: 1, type: "float" },
          { name: "a_direction", size: 1, type: "float" }
        ],
        constantData: [[0, 1], [0, -1], [1, 1], [0, -1], [1, 1], [1, -1]]
      });
    }
    processVisible(i, source, target, data) {
      const a = this.array;
      a[i++] = source.x;
      a[i++] = source.y;
      a[i++] = target.x;
      a[i++] = target.y;
      a[i++] = data.size || 1;
      a[i++] = data.curvature ?? DEFAULT_CURVATURE;
      a[i++] = floatColor(data.color);
    }
    setUniforms(p) {
      const gl = this.gl;
      gl.uniformMatrix3fv(this.uniform("u_matrix"), false, p.matrix);
      gl.uniform1f(this.uniform("u_pixelRatio"), p.pixelRatio);
      gl.uniform1f(this.uniform("u_sizeRatio"), p.sizeRatio);
      gl.uniform1f(this.uniform("u_feather"), p.antiAliasingFeather);
      gl.uniform2f(this.uniform("u_dimensions"), p.width * p.pixelRatio, p.height * p.pixelRatio);
      gl.uniform1f(this.uniform("u_minEdgeThickness"), p.minEdgeThickness);
    }
  };

  // web/vendor/engine/renderer.ts
  var PICK_FLOOR_PX = 1.5;
  var TOUCH_PICK_FLOOR_PX = 14;
  var X_LABEL_MARGIN = 150;
  var Y_LABEL_MARGIN = 50;
  var ANTI_ALIASING_FEATHER = 1;
  var STAGE_PADDING = 30;
  var DEFAULT_NODE_COLOR = "#999";
  var DEFAULT_EDGE_COLOR = "#ccc";
  function applyNodeDefaults(key, styled) {
    if (typeof styled.x !== "number" || typeof styled.y !== "number") {
      throw new Error(`vault-graph: node "${key}" has no position; the style function must keep x and y`);
    }
    if (!styled.color) styled.color = DEFAULT_NODE_COLOR;
    if (typeof styled.label !== "string") styled.label = null;
    if (!styled.size) styled.size = 2;
    if (styled.hidden === void 0) styled.hidden = false;
    if (styled.highlighted === void 0) styled.highlighted = false;
    if (styled.forceLabel === void 0) styled.forceLabel = false;
    if (!styled.type) styled.type = "circle";
    if (!styled.zIndex) styled.zIndex = 0;
    return styled;
  }
  function applyEdgeDefaults(styled) {
    if (!styled.color) styled.color = DEFAULT_EDGE_COLOR;
    if (!styled.label) styled.label = "";
    if (!styled.size) styled.size = 0.5;
    if (styled.hidden === void 0) styled.hidden = false;
    if (!styled.type) styled.type = "line";
    if (!styled.zIndex) styled.zIndex = 0;
    return styled;
  }
  function byZIndex(items, z) {
    return items.sort((a, b) => {
      const za = z(a) || 0, zb = z(b) || 0;
      return za < zb ? -1 : za > zb ? 1 : 0;
    });
  }
  var Renderer = class extends Emitter {
    constructor(graph, container, options) {
      super();
      __publicField(this, "graph", graph);
      __publicField(this, "container", container);
      __publicField(this, "settings");
      __publicField(this, "win");
      __publicField(this, "doc");
      __publicField(this, "nodeReducer");
      __publicField(this, "edgeReducer");
      __publicField(this, "drawHover");
      __publicField(this, "elements", /* @__PURE__ */ new Map());
      __publicField(this, "gl");
      __publicField(this, "ctx");
      __publicField(this, "nodePrograms");
      __publicField(this, "hoverPrograms");
      __publicField(this, "edgePrograms");
      __publicField(this, "camera");
      __publicField(this, "captor");
      __publicField(this, "nodeData", /* @__PURE__ */ new Map());
      __publicField(this, "edgeData", /* @__PURE__ */ new Map());
      __publicField(this, "forcedLabels", /* @__PURE__ */ new Set());
      __publicField(this, "highlighted", /* @__PURE__ */ new Set());
      __publicField(this, "hoveredNode", null);
      __publicField(this, "nodeOrder", []);
      __publicField(this, "nodeZExtent", [Infinity, -Infinity]);
      __publicField(this, "edgeZExtent", [Infinity, -Infinity]);
      __publicField(this, "nodeExtent", { x: [0, 1], y: [0, 1] });
      __publicField(this, "customBBox", null);
      __publicField(this, "normalization", createNormalization({ x: [0, 1], y: [0, 1] }));
      __publicField(this, "matrix", identity());
      __publicField(this, "invMatrix", identity());
      __publicField(this, "correctionRatio", 1);
      __publicField(this, "width", 0);
      __publicField(this, "height", 0);
      __publicField(this, "pixelRatio", 1);
      __publicField(this, "needToProcess", false);
      __publicField(this, "killed", false);
      __publicField(this, "renderFrame", null);
      __publicField(this, "hoverFrame", null);
      __publicField(this, "onWindowResize", () => {
        this.scheduleRefresh();
      });
      const { win, nodeReducer, edgeReducer, drawHover, ...settings } = options;
      this.settings = { ...settings };
      this.win = win;
      this.doc = container.ownerDocument;
      this.nodeReducer = nodeReducer;
      this.edgeReducer = edgeReducer;
      this.drawHover = drawHover;
      const edges = this.createWebGL("edges");
      const nodes = this.createWebGL("nodes");
      const labels = this.create2D("labels");
      const hovers = this.create2D("hovers");
      const hoverNodes = this.createWebGL("hoverNodes");
      const mouse = this.create2D("mouse");
      this.gl = { edges, nodes, hoverNodes };
      this.ctx = { labels, hovers, mouse };
      this.resize(true);
      this.nodePrograms = { circle: new NodeCircleProgram(this.gl.nodes, this.doc), halo: new NodeHaloProgram(this.gl.nodes, this.doc) };
      this.hoverPrograms = { circle: new NodeCircleProgram(this.gl.hoverNodes, this.doc), halo: new NodeHaloProgram(this.gl.hoverNodes, this.doc) };
      this.edgePrograms = { line: new EdgeLineProgram(this.gl.edges, this.doc), curve: new EdgeCurveProgram(this.gl.edges, this.doc) };
      this.camera = new Camera(win);
      this.applyCameraSettings();
      this.camera.on("updated", () => this.scheduleRender());
      const live = this.settings;
      const host = {
        getCamera: () => this.camera,
        viewportToFramedGraph: (p) => this.viewportToFramedGraph(p),
        getViewportZoomedState: (p, r) => this.getViewportZoomedState(p, r),
        get zoomingRatio() {
          return live.zoomingRatio;
        },
        get zoomDuration() {
          return live.zoomDuration;
        }
      };
      this.captor = new MouseCaptor(mouse.canvas, host, win);
      this.bindCaptor();
      win.addEventListener("resize", this.onWindowResize);
      this.refresh();
    }
    /* ------------------------------------------------------------ public API */
    refresh(opts) {
      if (this.killed) return;
      const partial = opts?.partialGraph;
      if (!partial) {
        this.clearIndices();
        this.graph.forEachNode((id) => this.addNode(id));
        this.graph.forEachEdge((e) => this.addEdge(e));
      } else {
        for (const id of partial.nodes ?? []) this.updateNode(id);
        for (const e of partial.edges ?? []) this.addEdge(e);
      }
      this.needToProcess = true;
      if (opts?.schedule) this.scheduleRender();
      else this.render();
    }
    render() {
      if (this.killed) return;
      if (this.renderFrame !== null) {
        this.win.cancelAnimationFrame(this.renderFrame);
        this.renderFrame = null;
      }
      this.resize();
      if (this.needToProcess) this.process();
      this.needToProcess = false;
      this.clear();
      if (!this.graph.order) {
        this.emit("afterRender", void 0);
        return;
      }
      const state = this.camera.getState();
      const dims = this.getDimensions();
      const graphDims = this.getGraphDimensions();
      this.matrix = matrixFromCamera(state, dims, graphDims, STAGE_PADDING);
      this.invMatrix = matrixFromCamera(state, dims, graphDims, STAGE_PADDING, true);
      this.correctionRatio = getMatrixImpact(this.matrix, state, dims);
      const params = this.renderParams();
      this.nodePrograms.circle.render(params);
      this.nodePrograms.halo.render(params);
      this.edgePrograms.line.render(params);
      this.edgePrograms.curve.render(params);
      this.renderLabels();
      this.renderHighlightedNodes();
      this.emit("afterRender", void 0);
    }
    kill() {
      this.killed = true;
      this.removeAllListeners();
      this.camera.kill();
      this.win.removeEventListener("resize", this.onWindowResize);
      this.captor.kill();
      if (this.renderFrame !== null) this.win.cancelAnimationFrame(this.renderFrame);
      if (this.hoverFrame !== null) this.win.cancelAnimationFrame(this.hoverFrame);
      this.renderFrame = null;
      this.hoverFrame = null;
      this.clearIndices();
      this.hoveredNode = null;
      for (const p of [
        this.nodePrograms.circle,
        this.nodePrograms.halo,
        this.hoverPrograms.circle,
        this.hoverPrograms.halo,
        this.edgePrograms.line,
        this.edgePrograms.curve
      ]) p.kill();
      for (const gl of [this.gl.edges, this.gl.nodes, this.gl.hoverNodes]) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      for (const el of this.elements.values()) el.remove();
      this.elements.clear();
    }
    graphToViewport(p) {
      return this.framedGraphToViewport(this.normalization.apply(p));
    }
    viewportToGraph(p) {
      return this.normalization.inverse(this.viewportToFramedGraph(p));
    }
    getCamera() {
      return this.camera;
    }
    scaleSize(size = 1, cameraRatio = this.camera.ratio) {
      return size / cameraRatio;
    }
    getNodeDisplayData(id) {
      const d = this.nodeData.get(id);
      return d ? { ...d } : void 0;
    }
    getEdgeDisplayData(edge) {
      const d = this.edgeData.get(edge);
      return d ? { ...d } : void 0;
    }
    getSetting(name) {
      return this.settings[name];
    }
    setSetting(name, value) {
      this.settings[name] = value;
      this.applyCameraSettings();
      this.scheduleRefresh();
    }
    getCanvases() {
      const out = {};
      for (const [id, el] of this.elements) out[id] = el;
      return out;
    }
    getDimensions() {
      return { width: this.width, height: this.height };
    }
    getMouseCaptor() {
      return this.captor;
    }
    setCustomBBox(bbox) {
      this.customBBox = bbox;
      this.scheduleRender();
    }
    /* ---------------------------------------------------------------- layers */
    createCanvas(id) {
      const host = this.container;
      const canvas = host.createEl ? host.createEl("canvas") : this.doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.className = "vg-layer vg-layer-" + id;
      this.container.appendChild(canvas);
      this.elements.set(id, canvas);
      return canvas;
    }
    createWebGL(id) {
      const canvas = this.createCanvas(id);
      const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: false, antialias: false });
      if (!gl) throw new Error("vault-graph: WebGL2 is not available in this window");
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return gl;
    }
    create2D(id) {
      const canvas = this.createCanvas(id);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("vault-graph: could not create a 2D context");
      return ctx;
    }
    resize(force = false) {
      const prevW = this.width, prevH = this.height, prevRatio = this.pixelRatio;
      this.width = this.container.offsetWidth || 1;
      this.height = this.container.offsetHeight || 1;
      this.pixelRatio = this.win.devicePixelRatio || 1;
      if (!force && prevW === this.width && prevH === this.height && prevRatio === this.pixelRatio) return;
      const w = this.width * this.pixelRatio, h = this.height * this.pixelRatio;
      for (const el of this.elements.values()) {
        el.style.width = this.width + "px";
        el.style.height = this.height + "px";
        el.width = w;
        el.height = h;
      }
      if (this.pixelRatio !== 1) for (const ctx of Object.values(this.ctx)) ctx.scale(this.pixelRatio, this.pixelRatio);
      for (const gl of Object.values(this.gl)) gl.viewport(0, 0, w, h);
    }
    clear() {
      for (const gl of [this.gl.nodes, this.gl.edges, this.gl.hoverNodes]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this.ctx.labels.clearRect(0, 0, this.width, this.height);
      this.ctx.hovers.clearRect(0, 0, this.width, this.height);
    }
    /* ------------------------------------------------------------- indexing */
    addNode(id) {
      const styled = this.nodeReducer(id, { ...this.graph.getNodeAttributes(id) });
      const data = applyNodeDefaults(id, styled);
      this.nodeData.set(id, data);
      this.forcedLabels.delete(id);
      if (data.forceLabel && !data.hidden) this.forcedLabels.add(id);
      this.highlighted.delete(id);
      if (data.highlighted && !data.hidden) this.highlighted.add(id);
      const z = data.zIndex ?? 0;
      if (z < this.nodeZExtent[0]) this.nodeZExtent[0] = z;
      if (z > this.nodeZExtent[1]) this.nodeZExtent[1] = z;
      this.normalization.applyTo(data);
    }
    updateNode(id) {
      this.addNode(id);
    }
    addEdge(edge) {
      const styled = this.edgeReducer(edge, { ...this.graph.getEdgeAttributes(edge) });
      const data = applyEdgeDefaults(styled);
      this.edgeData.set(edge, data);
      const z = data.zIndex ?? 0;
      if (z < this.edgeZExtent[0]) this.edgeZExtent[0] = z;
      if (z > this.edgeZExtent[1]) this.edgeZExtent[1] = z;
    }
    clearIndices() {
      this.nodeData.clear();
      this.edgeData.clear();
      this.forcedLabels.clear();
      this.highlighted.clear();
      this.nodeZExtent = [Infinity, -Infinity];
      this.edgeZExtent = [Infinity, -Infinity];
      this.nodeExtent = { x: [0, 1], y: [0, 1] };
    }
    process() {
      this.nodeExtent = graphExtent(this.graph);
      this.normalization = createNormalization(this.customBBox ?? this.nodeExtent);
      const ids = this.graph.nodes();
      const datas = [];
      const order = [];
      let circles = 0, halos = 0;
      for (const id of ids) {
        const data = this.nodeData.get(id);
        if (!data) continue;
        const attrs = this.graph.getNodeAttributes(id);
        data.x = attrs.x;
        data.y = attrs.y;
        this.normalization.applyTo(data);
        if (data.type === "halo") halos++;
        else circles++;
        order.push(id);
        datas.push(data);
      }
      this.nodePrograms.circle.reallocate(circles);
      this.nodePrograms.halo.reallocate(halos);
      if (this.nodeZExtent[0] !== this.nodeZExtent[1]) {
        const index = byZIndex(order.map((_, i) => i), (i) => datas[i].zIndex ?? 0);
        const sortedIds = [];
        const sortedDatas = [];
        for (const i of index) {
          sortedIds.push(order[i]);
          sortedDatas.push(datas[i]);
        }
        order.length = 0;
        datas.length = 0;
        for (let i = 0; i < sortedIds.length; i++) {
          order.push(sortedIds[i]);
          datas.push(sortedDatas[i]);
        }
      }
      circles = 0;
      halos = 0;
      for (const data of datas) {
        if (data.type === "halo") this.nodePrograms.halo.process(halos++, data);
        else this.nodePrograms.circle.process(circles++, data);
      }
      this.nodeOrder = order;
      let edges = this.graph.edges();
      let lines = 0, curves = 0;
      for (const e of edges) {
        const data = this.edgeData.get(e);
        if (!data) continue;
        if (data.type === "curve") curves++;
        else lines++;
      }
      this.edgePrograms.line.reallocate(lines);
      this.edgePrograms.curve.reallocate(curves);
      if (this.edgeZExtent[0] !== this.edgeZExtent[1]) {
        edges = byZIndex(edges, (e) => this.edgeData.get(e)?.zIndex ?? 0);
      }
      lines = 0;
      curves = 0;
      for (const e of edges) {
        const data = this.edgeData.get(e);
        if (!data) continue;
        const [s, t] = this.graph.extremities(e);
        const sd = this.nodeData.get(s), td = this.nodeData.get(t);
        if (!sd || !td) continue;
        if (data.type === "curve") this.edgePrograms.curve.process(curves++, sd, td, data);
        else this.edgePrograms.line.process(lines++, sd, td, data);
      }
    }
    /* -------------------------------------------------------------- drawing */
    renderParams() {
      return {
        matrix: this.matrix,
        width: this.width,
        height: this.height,
        pixelRatio: this.pixelRatio,
        zoomRatio: this.camera.ratio,
        sizeRatio: 1 / this.scaleSize(),
        correctionRatio: this.correctionRatio,
        minEdgeThickness: this.settings.minEdgeThickness,
        antiAliasingFeather: ANTI_ALIASING_FEATHER
      };
    }
    renderLabels() {
      const ctx = this.ctx.labels;
      const { labelSize, labelFont, labelWeight, labelColor } = this.settings;
      for (const id of this.forcedLabels) {
        const data = this.nodeData.get(id);
        if (!data || data.hidden || !data.label) continue;
        const { x, y } = this.framedGraphToViewport(data);
        const size = this.scaleSize(data.size);
        if (x < -X_LABEL_MARGIN || x > this.width + X_LABEL_MARGIN || y < -Y_LABEL_MARGIN || y > this.height + Y_LABEL_MARGIN) continue;
        ctx.fillStyle = labelColor;
        ctx.font = `${labelWeight} ${labelSize}px ${labelFont}`;
        ctx.fillText(data.label, x + size + 3, y + labelSize / 3);
      }
    }
    renderHighlightedNodes() {
      const ctx = this.ctx.hovers;
      ctx.clearRect(0, 0, this.width, this.height);
      const toRender = [];
      const hovered = this.hoveredNode;
      if (hovered !== null) {
        const d = this.nodeData.get(hovered);
        if (d && !d.hidden) toRender.push(hovered);
      }
      for (const id of this.highlighted) if (id !== hovered) toRender.push(id);
      for (const id of toRender) {
        const data = this.nodeData.get(id);
        if (!data) continue;
        const { x, y } = this.framedGraphToViewport(data);
        this.drawHover(ctx, { key: id, ...data, size: this.scaleSize(data.size), x, y }, this.settings);
      }
      let circles = 0, halos = 0;
      for (const id of toRender) {
        if (this.nodeData.get(id)?.type === "halo") halos++;
        else circles++;
      }
      this.hoverPrograms.circle.reallocate(circles);
      this.hoverPrograms.halo.reallocate(halos);
      circles = 0;
      halos = 0;
      for (const id of toRender) {
        const data = this.nodeData.get(id);
        if (!data) continue;
        if (data.type === "halo") this.hoverPrograms.halo.process(halos++, data);
        else this.hoverPrograms.circle.process(circles++, data);
      }
      const gl = this.gl.hoverNodes;
      gl.clear(gl.COLOR_BUFFER_BIT);
      const params = this.renderParams();
      this.hoverPrograms.circle.render(params);
      this.hoverPrograms.halo.render(params);
    }
    scheduleRender() {
      if (this.killed || this.renderFrame !== null) return;
      this.renderFrame = this.win.requestAnimationFrame(() => this.render());
    }
    scheduleRefresh() {
      this.refresh({ schedule: true });
    }
    scheduleHighlightedNodesRender() {
      if (this.killed || this.hoverFrame !== null || this.renderFrame !== null) return;
      this.hoverFrame = this.win.requestAnimationFrame(() => {
        this.hoverFrame = null;
        this.renderHighlightedNodes();
      });
    }
    /* --------------------------------------------------------------- camera */
    applyCameraSettings() {
      this.camera.minRatio = this.settings.minCameraRatio;
      this.camera.maxRatio = this.settings.maxCameraRatio;
      this.camera.enabledPanning = this.settings.enableCameraPanning;
      this.camera.setState(this.camera.validateState(this.camera.getState()));
    }
    getGraphDimensions() {
      const extent = this.customBBox ?? this.nodeExtent;
      return { width: extent.x[1] - extent.x[0] || 1, height: extent.y[1] - extent.y[0] || 1 };
    }
    framedGraphToViewport(p) {
      const v = multiplyVec2(this.matrix, p);
      return { x: (1 + v.x) * this.width / 2, y: (1 - v.y) * this.height / 2 };
    }
    viewportToFramedGraph(p) {
      const res = multiplyVec2(this.invMatrix, { x: p.x / this.width * 2 - 1, y: 1 - p.y / this.height * 2 });
      if (Number.isNaN(res.x)) res.x = 0;
      if (Number.isNaN(res.y)) res.y = 0;
      return res;
    }
    getViewportZoomedState(target, newRatio) {
      const { ratio, angle, x, y } = this.camera.getState();
      const { minCameraRatio, maxCameraRatio } = this.settings;
      if (typeof maxCameraRatio === "number") newRatio = Math.min(newRatio, maxCameraRatio);
      if (typeof minCameraRatio === "number") newRatio = Math.max(newRatio, minCameraRatio);
      const ratioDiff = newRatio / ratio;
      const mouse = this.viewportToFramedGraph(target);
      const centre = this.viewportToFramedGraph({ x: this.width / 2, y: this.height / 2 });
      return {
        angle,
        x: (mouse.x - centre.x) * (1 - ratioDiff) + x,
        y: (mouse.y - centre.y) * (1 - ratioDiff) + y,
        ratio: newRatio
      };
    }
    /* -------------------------------------------------------------- picking */
    // github#73, design/0013
    getNodeAtPosition(p, floorPx = PICK_FLOOR_PX) {
      let lastCircle = null;
      let lastHalo = null;
      let nearest = null;
      let nearestD2 = floorPx * floorPx;
      const inv = 1 / this.camera.ratio;
      for (const id of this.nodeOrder) {
        const data = this.nodeData.get(id);
        if (!data || data.hidden) continue;
        const v = this.framedGraphToViewport(data);
        const r = data.size * inv;
        const dx = v.x - p.x, dy = v.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) {
          if (d2 <= nearestD2) {
            nearestD2 = d2;
            nearest = id;
          }
          continue;
        }
        if (data.type === "halo") lastHalo = id;
        else lastCircle = id;
      }
      return lastHalo ?? lastCircle ?? nearest;
    }
    /* --------------------------------------------------------------- events */
    bindCaptor() {
      const base = (event) => ({ event, preventDefault: () => event.preventDefault() });
      this.captor.on("mousemove", (e) => {
        const ev = base(e);
        const at = this.getNodeAtPosition(e);
        if (at !== null && this.hoveredNode !== at) {
          if (this.hoveredNode !== null) this.emit("leaveNode", { ...ev, node: this.hoveredNode });
          this.hoveredNode = at;
          this.emit("enterNode", { ...ev, node: at });
          this.scheduleHighlightedNodesRender();
          return;
        }
        if (this.hoveredNode !== null && at !== this.hoveredNode) {
          const node = this.hoveredNode;
          this.hoveredNode = null;
          this.emit("leaveNode", { ...ev, node });
          this.scheduleHighlightedNodesRender();
        }
      });
      this.captor.on("mouseleave", (e) => {
        if (this.hoveredNode !== null) {
          const node = this.hoveredNode;
          this.hoveredNode = null;
          this.emit("leaveNode", { ...base(e), node });
          this.scheduleHighlightedNodesRender();
        }
      });
      const interaction = (kind) => (e) => {
        const ev = base(e);
        const at = this.getNodeAtPosition(e, e.fat ? TOUCH_PICK_FLOOR_PX : PICK_FLOOR_PX);
        if (at !== null) {
          const payload = { ...ev, node: at };
          if (kind === "click") this.emit("clickNode", payload);
          else if (kind === "doubleClick") this.emit("doubleClickNode", payload);
          else if (kind === "rightClick") this.emit("rightClickNode", payload);
          else if (kind === "down") this.emit("downNode", payload);
          else this.emit("upNode", payload);
          return;
        }
        if (kind === "click") this.emit("clickStage", ev);
        else if (kind === "doubleClick") this.emit("doubleClickStage", ev);
        else if (kind === "rightClick") this.emit("rightClickStage", ev);
        else if (kind === "down") this.emit("downStage", ev);
        else this.emit("upStage", ev);
      };
      this.captor.on("click", interaction("click"));
      this.captor.on("doubleClick", interaction("doubleClick"));
      this.captor.on("rightClick", interaction("rightClick"));
      this.captor.on("mousedown", interaction("down"));
      this.captor.on("mouseup", interaction("up"));
    }
  };
  return __toCommonJS(index_exports);
})();
