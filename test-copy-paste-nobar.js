const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function testCopyPasteAndNoBar() {
  console.log('--- Starting Copy/Paste (Ctrl+C & Ctrl+V) & No Black Bar Test Suite ---');
  const PORT = 28000 + Math.floor(Math.random() * 4000);
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
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch('http://127.0.0.1:' + PORT + '/json');
    const targets = await res.json();
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

    // 2. Spawn 3 text boxes placed very close vertically (100, 100), (100, 118), (100, 136)
    console.log('2. Spawning 3 close text lines (100, 100), (100, 118), (100, 136)...');
    const spawned = await evaluate(`
      const cc = window.canvasController;
      const ann1 = cc.createTextAnnotationAt(100, 100, 'LINE 1: GLOBAL TRADING LTD', { fontSize: 12 });
      const ann2 = cc.createTextAnnotationAt(100, 118, 'LINE 2: P.O. BOX 12345', { fontSize: 12 });
      const ann3 = cc.createTextAnnotationAt(100, 136, 'LINE 3: TEL (604) 583-0006', { fontSize: 12 });
      return { id1: ann1.id, id2: ann2.id, id3: ann3.id };
    `);

    // 3. Verify NO .pdf-text-drag-bar exists in DOM anywhere
    console.log('3. Verifying that the big black drag bar is 100% removed...');
    const dragBarCount = await evaluate(`
      return document.querySelectorAll('.pdf-text-drag-bar').length;
    `);
    if (dragBarCount !== 0) {
      throw new Error(`Expected 0 .pdf-text-drag-bar elements, found ${dragBarCount}!`);
    }
    console.log('   ✅ Confirmed: 0 .pdf-text-drag-bar elements in DOM. The big black bar is completely gone!');

    // 4. Test Single-box Copy and Paste (Ctrl+C, Ctrl+V)
    console.log('4. Testing single-box Copy & Paste (Ctrl+C, Ctrl+V)...');
    await evaluate(`
      window.annotationManager.selectAnnotation("${spawned.id1}", false);
    `);

    // Dispatch Ctrl+C keydown event
    await evaluate(`
      const e = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true });
      window.dispatchEvent(e);
    `);

    // Dispatch Ctrl+V keydown event
    await evaluate(`
      const e = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true });
      window.dispatchEvent(e);
    `);

    const afterSinglePaste = await evaluate(`
      const sel = window.annotationManager.getSelectedAnnotation();
      const count = window.annotationManager.annotations.filter(a => a.type === 'text').length;
      return {
        totalTexts: count,
        pastedId: sel ? sel.id : null,
        pastedText: sel ? sel.text : null,
        pastedX: sel ? sel.x : null,
        pastedY: sel ? sel.y : null
      };
    `);
    console.log('   After single Paste:', afterSinglePaste);
    if (afterSinglePaste.totalTexts !== 4) {
      throw new Error(`Expected 4 text annotations after paste, found ${afterSinglePaste.totalTexts}`);
    }
    if (afterSinglePaste.pastedText !== 'LINE 1: GLOBAL TRADING LTD') {
      throw new Error(`Pasted text mismatch: got "${afterSinglePaste.pastedText}"`);
    }
    if (afterSinglePaste.pastedX !== 115 || afterSinglePaste.pastedY !== 115) {
      throw new Error(`Expected pasted coordinates (115, 115), got (${afterSinglePaste.pastedX}, ${afterSinglePaste.pastedY})`);
    }
    console.log('   ✅ Single-box Ctrl+C & Ctrl+V successfully cloned text box with +15px offset and selected it!');

    // Clean up the pasted item for clean multi-paste test
    await evaluate(`
      const sel = window.annotationManager.getSelectedAnnotation();
      if (sel) window.annotationManager.deleteAnnotation(sel.id);
      window.annotationManager.deselectAll();
    `);

    // 5. Test Multi-selection Copy & Paste (Ctrl+C, Ctrl+V with 3 text boxes)
    console.log('5. Selecting all 3 close text boxes with Shift-selection...');
    await evaluate(`
      window.annotationManager.selectAnnotation("${spawned.id1}", false);
      window.annotationManager.selectAnnotation("${spawned.id2}", true);
      window.annotationManager.selectAnnotation("${spawned.id3}", true);
    `);

    const selCountBeforeCopy = await evaluate(`
      return window.annotationManager.getSelectedAnnotations().length;
    `);
    if (selCountBeforeCopy !== 3) {
      throw new Error(`Expected 3 selected annotations, got ${selCountBeforeCopy}`);
    }
    console.log('   ✅ All 3 text boxes selected together.');

    console.log('   Pressing Ctrl+C to copy all 3 text boxes...');
    await evaluate(`
      const e = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true });
      window.dispatchEvent(e);
    `);

    console.log('   Pressing Ctrl+V to paste all 3 text boxes together...');
    await evaluate(`
      const e = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true });
      window.dispatchEvent(e);
    `);

    const multiPasteState = await evaluate(`
      const allTexts = window.annotationManager.annotations.filter(a => a.type === 'text');
      const selTexts = window.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
      return {
        totalTexts: allTexts.length,
        selectedCount: selTexts.length,
        selectedItems: selTexts.map(a => ({ id: a.id, text: a.text, x: a.x, y: a.y }))
      };
    `);
    console.log('   Multi-paste state:', multiPasteState);
    if (multiPasteState.totalTexts !== 6) {
      throw new Error(`Expected 6 text boxes total (3 original + 3 pasted), got ${multiPasteState.totalTexts}`);
    }
    if (multiPasteState.selectedCount !== 3) {
      throw new Error(`Expected all 3 pasted text boxes to be selected together, got ${multiPasteState.selectedCount}`);
    }

    // Verify relative positions are preserved
    const items = multiPasteState.selectedItems;
    const dy1 = items[1].y - items[0].y;
    const dy2 = items[2].y - items[1].y;
    console.log(`   Relative vertical gaps between pasted lines: dy1=${dy1}px, dy2=${dy2}px (originals were 18px and 18px)`);
    if (dy1 !== 18 || dy2 !== 18) {
      throw new Error(`Expected pasted lines to maintain exact 18px relative gaps, got ${dy1} and ${dy2}`);
    }
    console.log('   ✅ Multi-box Ctrl+C & Ctrl+V pasted all 3 boxes simultaneously, maintaining relative positions & selecting all 3!');

    // 6. Test Move Together on the pasted group using Keyboard Arrows
    console.log('6. Testing move together on the 3 pasted boxes using ArrowDown (+5px)...');
    await evaluate(`
      const e = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true });
      window.dispatchEvent(e);
    `);

    const movedPositions = await evaluate(`
      const sel = window.annotationManager.getSelectedAnnotations().filter(a => a.type === 'text');
      return sel.map(a => ({ text: a.text, y: a.y }));
    `);
    console.log('   Positions after ArrowDown:', movedPositions);
    if (movedPositions[0].y !== items[0].y + 5 || movedPositions[1].y !== items[1].y + 5 || movedPositions[2].y !== items[2].y + 5) {
      throw new Error('All 3 pasted items should have moved down by 5px');
    }
    console.log('   ✅ All 3 pasted text boxes moved together smoothly with keyboard arrow keys!');

    // 7. Test Atomic Undo of multi-paste
    console.log('7. Testing Undo (Ctrl+Z) of multi-paste...');
    await evaluate(`
      window.annotationManager.undo(); // Undo the arrow move
      window.annotationManager.undo(); // Undo the paste
    `);

    const afterUndoCount = await evaluate(`
      return window.annotationManager.annotations.filter(a => a.type === 'text').length;
    `);
    console.log(`   Text boxes count after Undo: ${afterUndoCount} (expected 3)`);
    if (afterUndoCount !== 3) {
      throw new Error(`Expected 3 text boxes after undoing paste, found ${afterUndoCount}`);
    }
    console.log('   ✅ Undo successfully removed all pasted text boxes in a single atomic undo step!');

    // 8. Test Atomic Redo of multi-paste
    console.log('8. Testing Redo (Ctrl+Y)...');
    await evaluate(`
      window.annotationManager.redo();
    `);

    const afterRedoCount = await evaluate(`
      return window.annotationManager.annotations.filter(a => a.type === 'text').length;
    `);
    console.log(`   Text boxes count after Redo: ${afterRedoCount} (expected 6)`);
    if (afterRedoCount !== 6) {
      throw new Error(`Expected 6 text boxes after redoing paste, found ${afterRedoCount}`);
    }
    console.log('   ✅ Redo successfully restored all 3 pasted text boxes!');

    // 9. Take visual screenshot of clean lines without black bars
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.resolve(__dirname, 'test-copy-paste-nobar-success.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log('   Saved visual proof screenshot to:', screenshotPath);

    ws.close();
    chrome.kill();
    await new Promise(r => setTimeout(r, 600));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    console.log('🎉 ALL COPY/PASTE & NO BLACK BAR TESTS PASSED 100%! 🎉');
  } catch (err) {
    chrome.kill();
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {}
    throw err;
  }
}

testCopyPasteAndNoBar().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
