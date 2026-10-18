const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testTextAlignmentAndShiftSelect() {
  const PORT = 24000 + Math.floor(Math.random() * 5000);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-align-shift-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + tmpDir,
    '--no-first-run',
    '--window-size=1400,1000',
    HTML_FILE
  ]);

  try {
    await new Promise(r => setTimeout(r, 1500));
    const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let msgId = 1;
    const send = (method, params = {}) => new Promise(resolve => {
      const id = msgId++;
      const handler = (evt) => {
        const data = JSON.parse(evt.data);
        if (data.id === id) {
          ws.removeEventListener('message', handler);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await send('Page.enable');
    const base64 = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf').toString('base64');

    // Load test_case1.pdf and switch to edit-pdf-text mode
    const loadRes = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        while (!window.uiController || !window.pdfEngine) await sleep(50);
        const bin = atob("${base64}");
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
        await sleep(300);
        document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
        await sleep(200);
        return (await window.pdfEngine.getTextItems(0)).map(i => i.str);
      })()`
    });
    if (loadRes.exceptionDetails) {
      throw new Error(JSON.stringify(loadRes.exceptionDetails));
    }

    // Helper to get screen clip for a PDF text item
    const getScreenClip = async (str) => {
      const res = await send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const items = await window.pdfEngine.getTextItems(0);
          const item = items.find(it => it.str === ${JSON.stringify(str)});
          if (!item) throw new Error("Item not found: " + ${JSON.stringify(str)} + " in " + JSON.stringify(items.map(i => i.str)));
          const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
          const rect = layer.getBoundingClientRect();
          const zoom = window.uiController.zoom || 1;
          return {
            item,
            clip: {
              x: Math.floor(rect.left + item.x * zoom - 2),
              y: Math.floor(rect.top + item.y * zoom),
              width: Math.ceil(item.width * zoom + 8),
              height: Math.ceil(item.height * zoom),
              scale: 1
            }
          };
        })()`
      });
      if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
      return res.result.value;
    };

    // Helper to compute dark ink bounding box from a base64 PNG screenshot in the page context
    const getInkBounds = async (pngBase64) => {
      const res = await send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const img = new Image();
          img.src = "data:image/png;base64," + ${JSON.stringify(pngBase64)};
          await new Promise(r => img.onload = r);
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const idx = (y * c.width + x) * 4;
              const r = data[idx], g = data[idx + 1], b = data[idx + 2];
              if (r < 170 && g < 170 && b < 170) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
              }
            }
          }
          return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
        })()`
      });
      return res.result.value;
    };

    // Test 1: Check first-click pixel alignment for multiple text items of different font sizes
    const itemsToCheck = ['CENTURION', 'CENTURION LUMBER LTD', '3070 HENRY ROAD', 'Customer'];
    const alignmentResults = [];

    for (const label of itemsToCheck) {
      const { item, clip } = await getScreenClip(label);
      const beforeShot = await send('Page.captureScreenshot', { format: 'png', clip });
      const beforeBounds = await getInkBounds(beforeShot.data);

      // Click the item and temporarily hide border/caret/handles to measure pure text ink position
      await send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
          const rect = layer.getBoundingClientRect();
          const zoom = window.uiController.zoom || 1;
          await window.canvasController.handlePointerDown({
            button: 0,
            clientX: rect.left + (${item.x} + 10) * zoom,
            clientY: rect.top + (${item.y} + 4) * zoom,
            target: layer
          });
          await sleep(250);
          document.querySelectorAll('.pdf-text-content').forEach(ta => {
            ta.setSelectionRange(0, 0);
            ta.scrollLeft = 0;
            ta.scrollTop = 0;
            ta.blur();
          });
          document.querySelectorAll('.pdf-text-element').forEach(el => {
            el.style.borderColor = 'transparent';
            el.style.background = 'transparent';
            el.querySelectorAll('.pdf-text-handle').forEach(h => h.style.display = 'none');
          });
          await sleep(50);
        })()`
      });

      const afterShot = await send('Page.captureScreenshot', { format: 'png', clip });
      const afterBounds = await getInkBounds(afterShot.data);

      const dxMin = afterBounds.minX - beforeBounds.minX;
      const dyMin = afterBounds.minY - beforeBounds.minY;
      const dyMax = afterBounds.maxY - beforeBounds.maxY;

      alignmentResults.push({
        label,
        fontSize: item.fontSize,
        beforeBounds,
        afterBounds,
        dxMin,
        dyMin,
        dyMax
      });
    }

    // Test 2: Reload PDF, click first text item, then Shift-click a second (never-clicked) text item
    const shiftSelectRes = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const bin = atob("${base64}");
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        await window.uiController.loadPdfBuffer(u8.buffer.slice(0), "test_case1.pdf");
        await sleep(300);
        document.querySelector('.tool-btn[data-tool="edit-pdf-text"]').click();
        await sleep(200);

        const items = await window.pdfEngine.getTextItems(0);
        const firstItem = items.find(it => it.str === 'CENTURION');
        const secondItem = items.find(it => it.str === 'CENTURION LUMBER LTD');
        const thirdItem = items.find(it => it.str === '3070 HENRY ROAD');

        const layer = document.querySelector('.page-wrapper[data-page-index="0"] .annotation-layer');
        const rect = layer.getBoundingClientRect();
        const zoom = window.uiController.zoom || 1;

        // 1. Click first text item ("CENTURION")
        const x1 = rect.left + (firstItem.x + 15) * zoom;
        const y1 = rect.top + (firstItem.y + 5) * zoom;
        const target1 = document.elementFromPoint(x1, y1) || layer;
        target1.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, clientX: x1, clientY: y1, shiftKey: false
        }));
        await sleep(300);

        const selectedAfterFirst = window.annotationManager.getSelectedAnnotations().map(a => a.text);

        // 2. Shift-click second text item ("CENTURION LUMBER LTD", never clicked before, right below firstItem!)
        const x2 = rect.left + (secondItem.x + 20) * zoom;
        const y2 = rect.top + (secondItem.y + 5) * zoom;
        const target2 = document.elementFromPoint(x2, y2) || layer;
        target2.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, clientX: x2, clientY: y2, shiftKey: true
        }));
        await sleep(300);

        const selectedAfterSecond = window.annotationManager.getSelectedAnnotations().map(a => a.text);
        const domSelectedCountAfterSecond = document.querySelectorAll('.pdf-text-element.selected').length;

        // 3. Shift-click third text item ("3070 HENRY ROAD", never clicked before)
        const x3 = rect.left + (thirdItem.x + 20) * zoom;
        const y3 = rect.top + (thirdItem.y + 5) * zoom;
        const target3 = document.elementFromPoint(x3, y3) || layer;
        target3.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, clientX: x3, clientY: y3, shiftKey: true
        }));
        await sleep(300);

        const selectedAfterThird = window.annotationManager.getSelectedAnnotations().map(a => a.text);
        const domSelectedCountAfterThird = document.querySelectorAll('.pdf-text-element.selected').length;

        // 4. Test moving all 3 selected text boxes together via ArrowRight key
        const positionsBeforeMove = window.annotationManager.getSelectedAnnotations().map(a => ({ id: a.id, x: a.x, y: a.y }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await sleep(100);
        const positionsAfterMove = window.annotationManager.getSelectedAnnotations().map(a => ({ id: a.id, x: a.x, y: a.y }));

        return {
          selectedAfterFirst,
          selectedAfterSecond,
          domSelectedCountAfterSecond,
          selectedAfterThird,
          domSelectedCountAfterThird,
          positionsBeforeMove,
          positionsAfterMove
        };
      })()`
    });

    if (shiftSelectRes.exceptionDetails) {
      throw new Error(JSON.stringify(shiftSelectRes.exceptionDetails));
    }

    console.log('Alignment Results:', JSON.stringify(alignmentResults, null, 2));
    console.log('Shift-Select Results:', JSON.stringify(shiftSelectRes.result.value, null, 2));

      // Verify Alignment (0px vertical shift, <= 1px subpixel antialiasing difference on curved glyphs)
    for (const item of alignmentResults) {
      if (item.dyMin !== 0 || item.dyMax !== 0 || Math.abs(item.dxMin) > 1) {
        throw new Error(`Text "${item.label}" moved on first click! dxMin=${item.dxMin}, dyMin=${item.dyMin}, dyMax=${item.dyMax}`);
      }
    }

    // Verify Shift-Select
    const sr = shiftSelectRes.result.value;
    if (JSON.stringify(sr.selectedAfterFirst) !== JSON.stringify(['CENTURION'])) {
      throw new Error('Expected ["CENTURION"] after first click, got ' + JSON.stringify(sr.selectedAfterFirst));
    }
    if (JSON.stringify(sr.selectedAfterSecond) !== JSON.stringify(['CENTURION', 'CENTURION LUMBER LTD']) ||
        sr.domSelectedCountAfterSecond !== 2) {
      throw new Error('Expected both CENTURION and CENTURION LUMBER LTD selected after Shift-click, got ' + JSON.stringify(sr));
    }
    if (JSON.stringify(sr.selectedAfterThird) !== JSON.stringify(['CENTURION', 'CENTURION LUMBER LTD', '3070 HENRY ROAD']) ||
        sr.domSelectedCountAfterThird !== 3) {
      throw new Error('Expected all 3 items selected after second Shift-click, got ' + JSON.stringify(sr));
    }
    for (let i = 0; i < sr.positionsBeforeMove.length; i++) {
      if (sr.positionsAfterMove[i].x <= sr.positionsBeforeMove[i].x) {
        throw new Error('Expected ArrowRight to move all selected items together');
      }
    }

    console.log('✅ ALL TEXT ALIGNMENT AND SHIFT-CLICK MULTI-SELECT TESTS PASSED!');
    ws.close();
  } finally {
    chrome.kill();
  }
}

testTextAlignmentAndShiftSelect().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
