const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing Draw & Type Signature LocalStorage Persistence');
  console.log('====================================================');

  const PORT = 29920 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-sig-storage-');
  const HTML_FILE = 'file://' + path.resolve(__dirname, 'pdfgod.html');

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
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
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else resolve(data.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error('Evaluation failed: ' + (res.exceptionDetails.exception ? res.exceptionDetails.exception.description : JSON.stringify(res.exceptionDetails)));
      }
      return res.result ? res.result.value : undefined;
    };

    console.log('Waiting for application initialization...');
    await evaluate(`new Promise((resolve) => {
      const check = () => {
        if (window.uiController && window.sigPadController) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Application loaded.');

    // Test 1: Draw Signature -> Save in LocalStorage
    console.log('\n--- Test 1: Draw Signature & Check LocalStorage ---');
    const drawSaveResult = await evaluate(`(() => {
      localStorage.clear();
      const sp = window.sigPadController;
      sp.open();
      sp.drawColor = '#1e40af';

      // Simulate a stroke
      sp.startDrawing({ clientX: 50, clientY: 50, pointerId: 1 });
      sp.drawMove({ clientX: 100, clientY: 70 });
      sp.drawMove({ clientX: 150, clientY: 90 });
      sp.stopDrawing();

      const storedRaw = localStorage.getItem('pdfgod_saved_signature_draw_v1');
      const stored = storedRaw ? JSON.parse(storedRaw) : null;

      return {
        hasDrawn: sp.hasDrawn,
        strokeCount: sp.strokes.length,
        pointsInStroke: sp.strokes[0] ? sp.strokes[0].points.length : 0,
        storedExists: !!stored,
        storedColor: stored ? stored.color : null,
        storedStrokesCount: stored && stored.strokes ? stored.strokes.length : 0,
        hasPngData: stored ? !!stored.pngData : false
      };
    })()`);

    console.log('Draw save result:', drawSaveResult);
    if (!drawSaveResult.storedExists || drawSaveResult.storedColor !== '#1e40af' || drawSaveResult.storedStrokesCount !== 1 || !drawSaveResult.hasPngData) {
      throw new Error('Test 1 failed: Draw signature was not properly saved to localStorage');
    }
    console.log('✅ Drawn signature saved to localStorage with color, strokes, and PNG data.');

    // Test 2: Close and Reopen Dialog -> Restore Drawn Signature
    console.log('\n--- Test 2: Close & Reopen Dialog -> Restore Drawn Signature ---');
    const drawRestoreResult = await evaluate(`(() => {
      const sp = window.sigPadController;
      sp.dialog.close();

      // Reset in-memory state to simulate fresh session
      sp.hasDrawn = false;
      sp.strokes = [];

      // Reopen
      sp.open();

      return {
        hasDrawnRestored: sp.hasDrawn,
        strokesRestored: sp.strokes.length,
        colorRestored: sp.drawColor
      };
    })()`);

    console.log('Draw restore result:', drawRestoreResult);
    if (!drawRestoreResult.hasDrawnRestored || drawRestoreResult.strokesRestored !== 1 || drawRestoreResult.colorRestored !== '#1e40af') {
      throw new Error('Test 2 failed: Draw signature was not restored on modal reopen');
    }
    console.log('✅ Drawn signature restored into canvas on modal open.');

    // Test 3: Clear Button removes from LocalStorage
    console.log('\n--- Test 3: Clear Button Removes Draw Signature from LocalStorage ---');
    const clearResult = await evaluate(`(() => {
      const sp = window.sigPadController;
      sp.clearDraw();
      const storedAfterClear = localStorage.getItem('pdfgod_saved_signature_draw_v1');
      return {
        hasDrawn: sp.hasDrawn,
        strokesCount: sp.strokes.length,
        storedAfterClear: storedAfterClear
      };
    })()`);

    console.log('Clear result:', clearResult);
    if (clearResult.hasDrawn || clearResult.strokesCount !== 0 || clearResult.storedAfterClear !== null) {
      throw new Error('Test 3 failed: Clear button did not remove drawn signature from localStorage');
    }
    console.log('✅ Clearing signature removes drawing from canvas and localStorage.');

    // Test 4: Type Signature -> Save in LocalStorage
    console.log('\n--- Test 4: Type Signature & Check LocalStorage ---');
    const typeSaveResult = await evaluate(`(() => {
      const sp = window.sigPadController;
      sp.switchTab('type');
      sp.typeInput.value = 'Jane Doe';
      sp.typedFontIndex = 3;
      sp.drawColor = '#991b1b';
      sp.typeInput.dispatchEvent(new Event('input'));
      sp.saveTypeToStorage();

      const storedRaw = localStorage.getItem('pdfgod_saved_signature_type_v1');
      const stored = storedRaw ? JSON.parse(storedRaw) : null;

      return {
        storedExists: !!stored,
        storedText: stored ? stored.text : null,
        storedFontIndex: stored ? stored.fontIndex : null,
        storedColor: stored ? stored.color : null
      };
    })()`);

    console.log('Type save result:', typeSaveResult);
    if (!typeSaveResult.storedExists || typeSaveResult.storedText !== 'Jane Doe' || typeSaveResult.storedFontIndex !== 3 || typeSaveResult.storedColor !== '#991b1b') {
      throw new Error('Test 4 failed: Type signature was not properly saved to localStorage');
    }
    console.log('✅ Typed signature (name, fontIndex, color) saved to localStorage.');

    // Test 5: Close and Reopen Dialog -> Restore Typed Signature
    console.log('\n--- Test 5: Reopen Dialog -> Restore Typed Signature ---');
    const typeRestoreResult = await evaluate(`(() => {
      const sp = window.sigPadController;
      sp.dialog.close();
      sp.typeInput.value = '';
      sp.typedFontIndex = 1;

      sp.open();
      sp.switchTab('type');

      return {
        restoredText: sp.typeInput.value,
        restoredFontIndex: sp.typedFontIndex,
        restoredColor: sp.drawColor
      };
    })()`);

    console.log('Type restore result:', typeRestoreResult);
    if (typeRestoreResult.restoredText !== 'Jane Doe' || typeRestoreResult.restoredFontIndex !== 3 || typeRestoreResult.restoredColor !== '#991b1b') {
      throw new Error('Test 5 failed: Typed signature was not restored on modal reopen');
    }
    console.log('✅ Typed signature restored into input and font selector on reopen.');

    // Test 6: Image Upload Signature is NOT Saved to LocalStorage
    console.log('\n--- Test 6: Verify Image Upload Signature is NOT Saved to LocalStorage ---');
    const uploadNoSaveResult = await evaluate(`(() => {
      const sp = window.sigPadController;
      sp.switchTab('upload');

      // Create a dummy uploaded image
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 50;
      const dummyPng = canvas.toDataURL('image/png');
      sp.uploadedDataUrl = dummyPng;

      // Call generateSignaturePng
      const generated = sp.generateSignaturePng();

      // Check all localStorage keys
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        keys.push(localStorage.key(i));
      }

      return {
        generatedEquals: generated === dummyPng,
        keysInLocalStorage: keys,
        hasUploadKey: keys.some(k => k.toLowerCase().includes('upload') || k.toLowerCase().includes('img'))
      };
    })()`);

    console.log('Upload check result:', uploadNoSaveResult);
    if (uploadNoSaveResult.hasUploadKey) {
      throw new Error('Test 6 failed: Image upload signature must NOT be saved to localStorage');
    }
    console.log('✅ Verified: Image upload signature is strictly NOT saved to localStorage.');

    console.log('\n====================================================');
    console.log('🎉 ALL SIGNATURE LOCALSTORAGE PERSISTENCE TESTS PASSED!');
    console.log('====================================================');

    ws.close();
    chrome.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    chrome.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(1);
  }
}

runTests();
