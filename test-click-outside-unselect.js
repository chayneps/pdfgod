const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const net = require('net');

const getFreePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

async function testClickOutsideUnselect() {
  console.log('--- Starting Click Outside to Unselect Test Suite ---');
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

    console.log('1. Loading test_case1.pdf into the editor...');
    await evaluate(`while (!window.uiController) await new Promise(r => setTimeout(r, 50));`);
    const testCase1Bytes = fs.readFileSync('/Users/pumisake/Downloads/test_case1.pdf');
    const base64 = testCase1Bytes.toString('base64');
    await evaluate(`
      const bin = atob("${base64}");
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await window.uiController.loadPdfBuffer(u8.buffer, "test_case1.pdf");
    `);

    // 2. Spawn 3 text boxes
    console.log('2. Spawning test text boxes: Box A, Box B, Box C...');
    const spawned = await evaluate(`
      const cc = window.canvasController;
      const ann1 = cc.createTextAnnotationAt(100, 100, 'Header Line 1', { fontSize: 14 });
      const ann2 = cc.createTextAnnotationAt(100, 140, 'Header Line 2', { fontSize: 14 });
      const ann3 = cc.createTextAnnotationAt(100, 180, 'Header Line 3', { fontSize: 14 });
      return { id1: ann1.id, id2: ann2.id, id3: ann3.id };
    `);

    // 3. Test clicking outside a single selected text box on the canvas in SELECT mode
    console.log('3. Selecting Box A and clicking outside on the empty page canvas (Select Mode)...');
    await evaluate(`
      window.canvasController.setTool('select');
      window.annotationManager.selectAnnotation("${spawned.id1}", false);
    `);

    const isASelectedBefore = await evaluate(`
      const el = document.querySelector('.pdf-text-element[data-id="${spawned.id1}"]');
      return el ? el.classList.contains('selected') : false;
    `);
    if (!isASelectedBefore) throw new Error('Box A should be selected initially');
    console.log('   Box A is currently selected.');

    // Click outside on the empty canvas layer at (300, 300)
    await evaluate(`
      const layer = document.querySelector('.annotation-layer');
      layer.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 300, bubbles: true }));
    `);

    const afterCanvasClick = await evaluate(`
      const el = document.querySelector('.pdf-text-element[data-id="${spawned.id1}"]');
      return {
        isDomSelected: el ? el.classList.contains('selected') : false,
        selectedCount: window.annotationManager.getSelectedAnnotations().length,
        totalTextCount: window.annotationManager.annotations.filter(a => a.type === 'text').length
      };
    `);
    console.log('   After clicking outside on empty canvas:', afterCanvasClick);
    if (afterCanvasClick.isDomSelected || afterCanvasClick.selectedCount !== 0) {
      throw new Error('Clicking outside on the canvas should have unselected Box A!');
    }
    if (afterCanvasClick.totalTextCount !== 3) {
      throw new Error(`Expected text count to remain 3, got ${afterCanvasClick.totalTextCount}`);
    }
    console.log('   ✅ Clicking outside on the canvas cleanly unselected Box A without creating any new boxes!');

    // 4. Test clicking outside in TEXT mode while a box is selected
    console.log('4. Selecting Box A in TEXT mode and clicking outside on empty canvas...');
    await evaluate(`
      window.canvasController.setTool('text');
      window.annotationManager.selectAnnotation("${spawned.id1}", false);
    `);

    // Click outside on empty canvas
    await evaluate(`
      const layer = document.querySelector('.annotation-layer');
      layer.dispatchEvent(new PointerEvent('pointerdown', { clientX: 350, clientY: 350, bubbles: true }));
    `);

    const afterTextModeClick = await evaluate(`
      const el = document.querySelector('.pdf-text-element[data-id="${spawned.id1}"]');
      return {
        isDomSelected: el ? el.classList.contains('selected') : false,
        selectedCount: window.annotationManager.getSelectedAnnotations().length,
        totalTextCount: window.annotationManager.annotations.filter(a => a.type === 'text').length
      };
    `);
    console.log('   After clicking outside in Text mode:', afterTextModeClick);
    if (afterTextModeClick.isDomSelected || afterTextModeClick.selectedCount !== 0) {
      throw new Error('Clicking outside in Text mode should have unselected Box A!');
    }
    if (afterTextModeClick.totalTextCount !== 3) {
      throw new Error(`Clicking outside to unselect in Text mode should NOT create a new text box! Total is: ${afterTextModeClick.totalTextCount}`);
    }
    console.log('   ✅ In Text mode: clicking outside unselected the box without creating an unwanted box!');

    // 5. Test clicking outside in the gray VIEWPORT workspace background
    console.log('5. Selecting Box B and clicking outside on the gray VIEWPORT workspace background...');
    await evaluate(`
      window.annotationManager.selectAnnotation("${spawned.id2}", false);
    `);

    // Click on .app-viewport (outside the page)
    await evaluate(`
      const vp = document.querySelector('.app-viewport');
      vp.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
    `);

    const afterViewportClick = await evaluate(`
      const el = document.querySelector('.pdf-text-element[data-id="${spawned.id2}"]');
      return {
        isDomSelected: el ? el.classList.contains('selected') : false,
        selectedCount: window.annotationManager.getSelectedAnnotations().length
      };
    `);
    console.log('   After clicking viewport background:', afterViewportClick);
    if (afterViewportClick.isDomSelected || afterViewportClick.selectedCount !== 0) {
      throw new Error('Clicking viewport background should have unselected Box B!');
    }
    console.log('   ✅ Clicking the gray viewport background cleanly unselected Box B!');

    // 6. Test Multi-selection: Shift-select 3 boxes, then click outside
    console.log('6. Shift-selecting all 3 boxes and clicking outside to unselect ALL together...');
    await evaluate(`
      window.annotationManager.selectAnnotation("${spawned.id1}", false);
      window.annotationManager.selectAnnotation("${spawned.id2}", true);
      window.annotationManager.selectAnnotation("${spawned.id3}", true);
    `);

    const threeSelBefore = await evaluate(`
      return {
        selectedCount: window.annotationManager.getSelectedAnnotations().length,
        domCount: document.querySelectorAll('.pdf-text-element.selected').length
      };
    `);
    if (threeSelBefore.selectedCount !== 3 || threeSelBefore.domCount !== 3) {
      throw new Error('All 3 boxes should be selected before click outside');
    }
    console.log('   All 3 boxes selected simultaneously.');

    // Click outside on empty canvas
    await evaluate(`
      const layer = document.querySelector('.annotation-layer');
      layer.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, clientY: 400, bubbles: true }));
    `);

    const afterMultiClickOutside = await evaluate(`
      return {
        selectedCount: window.annotationManager.getSelectedAnnotations().length,
        domCount: document.querySelectorAll('.pdf-text-element.selected').length
      };
    `);
    console.log('   After clicking outside multi-selection:', afterMultiClickOutside);
    if (afterMultiClickOutside.selectedCount !== 0 || afterMultiClickOutside.domCount !== 0) {
      throw new Error('Clicking outside should have unselected all 3 boxes simultaneously!');
    }
    console.log('   ✅ Clicking outside unselected all 3 selected text boxes simultaneously!');

    // 7. Test when typing / focused inside a text box
    console.log('7. Focusing inside Box C textarea and clicking outside to commit & unselect...');
    await evaluate(`
      const ta = document.querySelector('.pdf-text-element[data-id="${spawned.id3}"] .pdf-text-content');
      ta.focus();
      window.annotationManager.selectAnnotation("${spawned.id3}", false);
    `);

    const isFocusedBefore = await evaluate(`
      const ta = document.querySelector('.pdf-text-element[data-id="${spawned.id3}"] .pdf-text-content');
      return document.activeElement === ta;
    `);
    console.log('   Box C textarea actively focused:', isFocusedBefore);

    // Click outside
    await evaluate(`
      const layer = document.querySelector('.annotation-layer');
      layer.dispatchEvent(new PointerEvent('pointerdown', { clientX: 450, clientY: 450, bubbles: true }));
    `);

    const afterTypingClickOutside = await evaluate(`
      const ta = document.querySelector('.pdf-text-element[data-id="${spawned.id3}"] .pdf-text-content');
      const el = document.querySelector('.pdf-text-element[data-id="${spawned.id3}"]');
      return {
        isFocused: document.activeElement === ta,
        isDomSelected: el ? el.classList.contains('selected') : false,
        selectedCount: window.annotationManager.getSelectedAnnotations().length
      };
    `);
    console.log('   After clicking outside active typing box:', afterTypingClickOutside);
    if (afterTypingClickOutside.isFocused || afterTypingClickOutside.isDomSelected || afterTypingClickOutside.selectedCount !== 0) {
      throw new Error('Clicking outside should have blurred and unselected Box C!');
    }
    console.log('   ✅ Clicking outside properly blurred and unselected the actively typed text box!');

    ws.close();
    chrome.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
    console.log('🎉 ALL CLICK OUTSIDE TO UNSELECT TESTS PASSED 100%! 🎉');
  } catch (err) {
    chrome.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
    throw err;
  }
}

testClickOutsideUnselect().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
