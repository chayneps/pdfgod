const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function measureDrift() {
  const PORT = 21000 + Math.floor(Math.random() * 8000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    HTML_FILE
  ]);

  try {
    let targets = null;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        targets = await res.json();
        if (targets && targets.length > 0 && targets.find(t => t.type === 'page')) break;
      } catch (e) {}
    }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 1;
    const send = (method, params) => new Promise(resolve => {
      const curId = id++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === curId) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Runtime.enable');
    const evaluate = async (code) => {
      const wrapped = `(async () => {\n${code}\n})()`;
      const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result ? r.result.value : undefined;
    };

    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');
    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    `);

    // Let's get the text items on page 0
    const textItems = await evaluate(`
      await window.canvasController.loadTextItemsForActivePage();
      return window.canvasController.cachedPageTextItems;
    `);
    console.log('Extracted text items (first 3):', textItems.slice(0, 3));

    // Measure the first item
    const firstItem = textItems[0];
    console.log('First item details:', {
      str: firstItem.str,
      x: firstItem.x,
      y: firstItem.y,
      baselineY: firstItem.baselineY,
      fontSize: firstItem.fontSize,
      fontFamily: firstItem.fontFamily
    });

    const layerRect = await evaluate(`
      const layer = document.querySelector('.annotation-layer');
      const rect = layer.getBoundingClientRect();
      return { left: rect.left, top: rect.top, zoom: window.canvasController.zoom };
    `);

    const clipX = layerRect.left + firstItem.x * layerRect.zoom - 10;
    const clipY = layerRect.top + firstItem.y * layerRect.zoom - 10;
    const clipW = firstItem.width * layerRect.zoom + 20;
    const clipH = 40 * layerRect.zoom;

    // Take screenshot BEFORE clicking
    const ssBefore = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 }
    });
    fs.writeFileSync(path.resolve(__dirname, 'drift-before.png'), Buffer.from(ssBefore.data, 'base64'));

    // Now click the text item to trigger replacement
    await evaluate(`
      const cc = window.canvasController;
      cc.setTool('text');
      const layer = document.querySelector('.annotation-layer');
      const rect = layer.getBoundingClientRect();
      await cc.handlePointerDown({
        button: 0,
        clientX: rect.left + (${firstItem.x} + 10) * cc.zoom,
        clientY: rect.top + (${firstItem.y} + 5) * cc.zoom,
        target: layer
      });
    `);

    // Wait for replacement element to render
    await new Promise(r => setTimeout(r, 200));

    // Get the spawned text element and its computed metrics
    const spawnedMetrics = await evaluate(`
      const el = document.querySelector('.pdf-text-element');
      const ta = el ? el.querySelector('.pdf-text-content') : null;
      if (!el || !ta) return null;

      const elRect = el.getBoundingClientRect();
      const taRect = ta.getBoundingClientRect();
      const ann = window.annotationManager.getAnnotation(el.dataset.id);

      // Measure font metrics inside textarea
      const computed = window.getComputedStyle(ta);

      return {
        annY: ann.y,
        annBaselineY: ann.baselineY,
        elTop: elRect.top,
        taTop: taRect.top,
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        paddingTop: computed.paddingTop,
        borderTopWidth: window.getComputedStyle(el).borderTopWidth,
        marginTop: computed.marginTop
      };
    `);

    console.log('Spawned element metrics:', spawnedMetrics);

    // Take screenshot AFTER clicking
    const ssAfter = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 }
    });
    fs.writeFileSync(path.resolve(__dirname, 'drift-after.png'), Buffer.from(ssAfter.data, 'base64'));

    const diff = await evaluate(`
      const loadImg = (b64) => new Promise(res => {
        const img = new Image();
        img.onload = () => res(img);
        img.src = 'data:image/png;base64,' + b64;
      });
      const img1 = await loadImg("${ssBefore.data}");
      const img2 = await loadImg("${ssAfter.data}");
      const cv1 = document.createElement('canvas');
      cv1.width = img1.width; cv1.height = img1.height;
      const ctx1 = cv1.getContext('2d');
      ctx1.drawImage(img1, 0, 0);

      const cv2 = document.createElement('canvas');
      cv2.width = img2.width; cv2.height = img2.height;
      const ctx2 = cv2.getContext('2d');
      ctx2.drawImage(img2, 0, 0);

      const d1 = ctx1.getImageData(0, 0, cv1.width, cv1.height).data;
      const d2 = ctx2.getImageData(0, 0, cv2.width, cv2.height).data;

      // Find top row of dark pixels (R < 100, G < 100, B < 100) around x: 15 to 80 (letters GOO)
      function findTextBounds(d, w, h) {
        let top = -1, bottom = -1;
        for (let y = 0; y < 30; y++) {
          let hasDark = false;
          for (let x = 20; x < 80; x++) {
            const idx = (y * w + x) * 4;
            // Check if dark pixel
            if (d[idx] < 100 && d[idx+1] < 100 && d[idx+2] < 100) {
              hasDark = true;
              break;
            }
          }
          if (hasDark) {
            if (top === -1) top = y;
            bottom = y;
          }
        }
        return { top, bottom };
      }

      const b1 = findTextBounds(d1, cv1.width, cv1.height);
      const b2 = findTextBounds(d2, cv2.width, cv2.height);
      return { before: b1, after: b2, driftY: b2.top - b1.top };
    `);

    console.log('Text pixel vertical bounds and drift:', diff);

    ws.close();
    chrome.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
  } catch (err) {
    chrome.kill('SIGKILL');
    throw err;
  }
}

measureDrift().catch(console.error);
