// Adaptive Fullscreen
// Runs in every frame, in the page's own JS world ("world": "MAIN" in the manifest), before any
// page script. When the browser window is maximized, it preserves regular native fullscreen.
// Otherwise, it overrides the Fullscreen API so "fullscreen" fills the browser window.
(() => {
  const KEY = '__windowed_fullscreen__';
  const isTop = window.parent === window;
  let current = null; // the element that is currently "fullscreen"

  // Preserve native Fullscreen API methods and getters before overriding
  const nativeReq = Element.prototype.requestFullscreen;
  const nativeWebkitReq = Element.prototype.webkitRequestFullscreen || Element.prototype.webkitRequestFullScreen;
  const reqFn = nativeReq || nativeWebkitReq;

  const nativeExit = Document.prototype.exitFullscreen;
  const nativeWebkitExit = Document.prototype.webkitExitFullscreen || Document.prototype.webkitCancelFullScreen;
  const exitFn = nativeExit || nativeWebkitExit;

  const nativeFsElementDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement') ||
                              Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenElement');
  const nativeFsElement = nativeFsElementDesc && nativeFsElementDesc.get;

  const nativeFsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreen') ||
                       Object.getOwnPropertyDescriptor(Document.prototype, 'webkitIsFullScreen');
  const nativeFs = nativeFsDesc && nativeFsDesc.get;

  // Window maximization check: true when the browser window fills the available screen space.
  const isMaximized = () => {
    try {
      const win = window.top || window;
      const s = win.screen;
      if (!s || !win.outerWidth || !win.outerHeight) return false;
      return (s.availWidth - win.outerWidth <= 16) && (s.availHeight - win.outerHeight <= 16);
    } catch {
      try {
        const s = window.screen;
        if (!s || !window.outerWidth || !window.outerHeight) return false;
        return (s.availWidth - window.outerWidth <= 16) && (s.availHeight - window.outerHeight <= 16);
      } catch {
        return false;
      }
    }
  };

  // The fullscreen look. !important so site CSS can't undo it. Adopted as a constructed stylesheet
  // (instead of a <style> tag) so a strict page CSP can't block it.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    [data-wfs] {
      position: fixed !important; inset: 0 !important;
      width: 100% !important; height: 100% !important;
      min-width: 0 !important; min-height: 0 !important;
      max-width: none !important; max-height: none !important;
      margin: 0 !important; box-sizing: border-box !important; transform: none !important;
      padding: 0; border: 0; background: none; overflow: visible; color: inherit;
    }
    [data-wfs]::backdrop { background: #000; }
  `);

  const isRoot = (el) => el === document.documentElement || el === document.body;
  const post = (win, type) => win.postMessage({ [KEY]: type }, '*');
  const fire = (el) => {
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  };

  // Promoting the element to the top layer (as a manual popover) lets it escape ancestors that
  // would otherwise trap it: transforms, overflow clipping, stacking contexts, z-index wars.
  function setStyle(el, on) {
    if (on) {
      const root = el.getRootNode(); // Document, or a ShadowRoot
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      el.setAttribute('data-wfs', '');
      el.setAttribute('popover', 'manual');
      el.showPopover();
    } else {
      el.removeAttribute('popover');
      el.removeAttribute('data-wfs');
    }
  }

  function enter(el) {
    if (current === el) return Promise.resolve();
    try {
      if (!el.isConnected) throw new TypeError('Element is not in the document');
      leave();
      if (!isRoot(el)) setStyle(el, true); // <html>/<body> already fill the window
    } catch (err) {
      setStyle(el, false);
      return Promise.reject(err);
    }
    current = el;
    if (!isTop) post(parent, 'enter'); // an embedded player: ask the parent page to expand our <iframe>
    return Promise.resolve().then(() => fire(el));
  }

  function leave() {
    const el = current;
    if (!el) return null;
    current = null;
    if (!isRoot(el)) setStyle(el, false);
    if (el.contentWindow) post(el.contentWindow, 'exit'); // el is an <iframe>: tell the page inside
    if (!isTop) post(parent, 'exit');
    return Promise.resolve().then(() => fire(el.isConnected ? el : document));
  }

  const requestFullscreen = function requestFullscreen(...args) {
    if (isMaximized() && reqFn) {
      if (current) leave();
      return reqFn.apply(this, args);
    }
    return enter(this);
  };

  const exitFullscreen = function exitFullscreen(...args) {
    if (current) return leave();
    if (exitFn) return exitFn.apply(this, args);
    return Promise.reject(new TypeError('Document not in fullscreen mode'));
  };

  const define = (target, names, descriptor) => {
    for (const name of names) {
      Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor });
    }
  };
  define(Element.prototype, ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'],
    { writable: true, value: requestFullscreen });
  define(Document.prototype, ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen'],
    { writable: true, value: exitFullscreen });
  define(Document.prototype, ['fullscreenElement', 'webkitFullscreenElement', 'webkitCurrentFullScreenElement'],
    { get: function() { return current || (nativeFsElement ? nativeFsElement.call(this) : null); } });
  define(Document.prototype, ['fullscreen', 'webkitIsFullScreen'],
    { get: function() { return !!(current || (nativeFs ? nativeFs.call(this) : (nativeFsElement ? nativeFsElement.call(this) : false))); } });

  // Escape leaves fullscreen, as it does natively.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) {
      e.preventDefault();
      e.stopImmediatePropagation();
      leave();
    }
  }, true);

  // Frame <-> parent coordination, so embedded players (YouTube embeds etc.) fill the whole window
  // and not just their <iframe>. Our messages are swallowed so the page never sees them.
  window.addEventListener('message', (e) => {
    const type = e.data && e.data[KEY];
    if (!type) return;
    e.stopImmediatePropagation();

    if (!isTop && e.source === parent) { // parent -> child
      if (type === 'exit') leave();
      return;
    }
    const frame = [...document.querySelectorAll('iframe, frame')].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    if (type === 'exit') {
      if (current === frame) leave();
      return;
    }
    // child -> parent 'enter': same rules as native fullscreen (user gesture + allowfullscreen or same-origin)
    const allowed = frame.allowFullscreen || /fullscreen/.test(frame.allow) || frame.contentDocument;
    if (!isMaximized() && allowed && navigator.userActivation.isActive) enter(frame).catch(() => {});
    else post(e.source, 'exit');
  }, true);
})();
