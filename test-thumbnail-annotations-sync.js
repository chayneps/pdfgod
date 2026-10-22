const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTestOnDpr(scaleFactor) {
  console.log(`\n========================================`);
  console.log(`🧪 Testing with deviceScaleFactor = ${scaleFactor}`);
  console.log(`========================================`);

  const PORT = 29505 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-thumb-test-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    `--force-device-scale-factor=${scaleFactor}`,
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--window-size=1440,900',
    HTML_FILE
  ]);

  try {
    let page = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json');
        const targets = await res.json();
        if (targets && targets.length > 0) {
          page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }

    if (!page) throw new Error('Could not connect to Chrome debugging port ' + PORT);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    await new Promise(r => setTimeout(r, 1000));

    const evalJs = async (expr) => {
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (res && res.exceptionDetails) {
        console.error('Exception in evalJs:', JSON.stringify(res.exceptionDetails));
      }
      return res.result ? res.result.value : null;
    };

    // 1. Load test_case100_pages_1_3.pdf (2 pages)
    const pdfPath = '/Users/pumisake/Downloads/test_case100_pages_1_3.pdf';
    const pdfBytes = fs.readFileSync(pdfPath);
    const b64 = pdfBytes.toString('base64');

    await evalJs(`
      (async () => {
        window.confirm = () => true;
        const bin = atob("${b64}");
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        await window.uiController.loadPdfBuffer(arr.buffer, 'test_case100_pages_1_3.pdf');
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));

    // 2. Select items on Page 0 with rectangle marquee
    await evalJs(`
      (async () => {
        const overlay = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
        const rect = overlay.getBoundingClientRect();
        overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 50, clientY: rect.top + 50, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 500, clientY: rect.top + 300, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 500, clientY: rect.top + 300, bubbles: true }));
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));

    // 3. Delete Page 2
    await evalJs(`
      (async () => {
        window.confirm = () => true;
        window.uiController.selectPage(1, false, false);
        const delBtn = document.querySelector('.page-wrapper[data-page-index="1"] [data-action="delete-page"]');
        if (delBtn) delBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));

    // 4. Verify thumbnail
    const checkResult = await evalJs(`
      (() => {
        const pageCount = window.pdfEngine.getPageCount();
        const thumbCanvas = document.querySelector('.thumbnail-card[data-page-index="0"] .thumbnail-canvas');
        if (!thumbCanvas) return { pageCount, hasThumb: false };

        const ctx = thumbCanvas.getContext('2d');
        const w = thumbCanvas.width;
        const h = thumbCanvas.height;
        
        // Sample right side of top header (x: 0.5*w .. 0.95*w, y: 0.05*h .. 0.2*h)
        // Main view has "GOODRICH TERMINAL 2012 LTD" / "Delivery Slip" across header
        const headerRight = ctx.getImageData(Math.floor(w * 0.4), Math.floor(h * 0.05), Math.floor(w * 0.5), Math.floor(h * 0.15));
        let headerDarkCount = 0;
        for (let i = 0; i < headerRight.data.length; i += 4) {
          if (headerRight.data[i] < 200 || headerRight.data[i+1] < 200 || headerRight.data[i+2] < 200) {
            headerDarkCount++;
          }
        }

        // Sample entire top half (y: 20 .. h/2)
        const imgData = ctx.getImageData(0, 20, w, Math.floor(h / 2));
        let totalDarkCount = 0;
        for (let i = 0; i < imgData.data.length; i += 4) {
          if (imgData.data[i] < 200 || imgData.data[i+1] < 200 || imgData.data[i+2] < 200) {
            totalDarkCount++;
          }
        }

        return {
          dpr: window.devicePixelRatio,
          pageCount,
          hasThumb: true,
          thumbWidth: w,
          thumbHeight: h,
          headerDarkCount,
          totalDarkCount
        };
      })()
    `);

    console.log('Result:', checkResult);
    if (checkResult.pageCount !== 1) throw new Error('Page count mismatch');
    if (!checkResult.hasThumb) throw new Error('Thumbnail missing');
    if (checkResult.totalDarkCount < 100) throw new Error('Text annotations not rendered on thumbnail');
    if (checkResult.headerDarkCount < 20) throw new Error('Text annotations not spanning correctly across width (scale mismatch)');

    console.log(`✅ ScaleFactor ${scaleFactor} PASSED: totalDark=${checkResult.totalDarkCount}, headerDark=${checkResult.headerDarkCount}`);
    return true;
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

(async () => {
  try {
    await runTestOnDpr(1);
    await runTestOnDpr(2);
    console.log('\n🎉 ALL DPR (1x & 2x Retina) Thumbnail Annotation Sync Tests PASSED!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  }
})();
