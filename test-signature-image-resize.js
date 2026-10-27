const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing Signature & Image Proportional Resizing');
  console.log('====================================================');

  const PORT = 29910 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-sig-test-');
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
        if (window.uiController && window.pdfEngine && window.canvasController) resolve(true);
        else setTimeout(check, 50);
      };
      check();
    })`);
    console.log('✅ Application loaded.');

    // Load sample PDF
    console.log('\n--- Step 1: Load PDF Document ---');
    await evaluate(`(async () => {
      const doc = await PDFLib.PDFDocument.create();
      const p = doc.addPage([600, 800]);
      p.drawText("Signature & Picture Resize Verification", { x: 50, y: 750, size: 20 });
      const bytes = await doc.save();
      await window.uiController.loadPdfBuffer(bytes, 'test.pdf');
    })()`);

    // Test 1: Insert Signature -> Verify Auto-Selection & Handles
    console.log('\n--- Test 1: Insert Signature Auto-Selection ---');
    const sigInsertRes = await evaluate(`(() => {
      // Mock generateSignaturePng on sigPadController
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 65;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e3a8a';
      ctx.font = '28px serif';
      ctx.fillText('John Doe', 20, 42);
      const pngData = canvas.toDataURL('image/png');

      window.sigPadController.generateSignaturePng = () => pngData;
      window.sigPadController.insertSignature();

      const selected = window.annotationManager.getSelectedAnnotation();
      const selBox = document.querySelector('.selection-box');
      const handles = selBox ? selBox.querySelectorAll('.selection-handle') : [];
      const selectBtn = document.querySelector('.tool-btn[data-tool="select"]');

      return {
        selectedType: selected ? selected.type : null,
        selectedId: selected ? selected.id : null,
        width: selected ? selected.width : 0,
        height: selected ? selected.height : 0,
        boxExists: !!selBox,
        handleCount: handles.length,
        isSelectBtnActive: selectBtn ? selectBtn.classList.contains('active') : false,
        activeTool: window.canvasController.activeTool
      };
    })()`);

    console.log('Signature Insert Result:', sigInsertRes);
    if (sigInsertRes.selectedType !== 'signature' || !sigInsertRes.boxExists || sigInsertRes.handleCount !== 8 || !sigInsertRes.isSelectBtnActive) {
      throw new Error('Test 1 failed: Signature was not automatically selected with 8 handles and active Select tool');
    }
    console.log('✅ Signature automatically selected upon insertion with 8 resize handles.');

    // Test 2: Proportional Corner Resize (SE handle) by default
    console.log('\n--- Test 2: Proportional Corner Resize (SE handle) ---');
    const seResizeRes = await evaluate(`(() => {
      const cc = window.canvasController;
      const selected = window.annotationManager.getSelectedAnnotation();
      const origW = selected.width;
      const origH = selected.height;
      const origRatio = origW / origH;
      const origX = selected.x;
      const origY = selected.y;

      const seHandle = document.querySelector('.selection-handle.handle-se');
      
      // Simulate pointerdown on SE handle
      cc.activeTool = 'select';
      cc.handlePointerDown({
        button: 0,
        target: seHandle,
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        stopPropagation: () => {},
        preventDefault: () => {}
      });

      // Simulate dragging SE corner mostly horizontally: dx = 80, dy = 10
      cc.handlePointerMove({
        clientX: 280,
        clientY: 210,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false
      });

      const newW = selected.width;
      const newH = selected.height;
      const newRatio = newW / newH;
      const newX = selected.x;
      const newY = selected.y;

      cc.handlePointerUp({});

      return {
        origW,
        origH,
        origRatio,
        newW,
        newH,
        newRatio,
        ratioDiff: Math.abs(origRatio - newRatio),
        anchorXMatches: origX === newX,
        anchorYMatches: origY === newY
      };
    })()`);

    console.log('SE Corner Resize Result:', seResizeRes);
    if (seResizeRes.ratioDiff > 0.05 || !seResizeRes.anchorXMatches || !seResizeRes.anchorYMatches || seResizeRes.newW <= seResizeRes.origW) {
      throw new Error('Test 2 failed: SE corner did not preserve proportional aspect ratio or anchor moved');
    }
    console.log('✅ SE corner resized proportionally, preserving exact aspect ratio and top-left anchor.');

    // Test 3: NW Corner Proportional Resize
    console.log('\n--- Test 3: Proportional NW Corner Resize ---');
    const nwResizeRes = await evaluate(`(() => {
      const cc = window.canvasController;
      const selected = window.annotationManager.getSelectedAnnotation();
      const origW = selected.width;
      const origH = selected.height;
      const origRatio = origW / origH;
      const origRight = selected.x + selected.width;
      const origBottom = selected.y + selected.height;

      const nwHandle = document.querySelector('.selection-handle.handle-nw');
      
      cc.handlePointerDown({
        button: 0,
        target: nwHandle,
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        stopPropagation: () => {},
        preventDefault: () => {}
      });

      // Drag up-left: dx = -40, dy = -40
      cc.handlePointerMove({
        clientX: 160,
        clientY: 160,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false
      });

      const newW = selected.width;
      const newH = selected.height;
      const newRatio = newW / newH;
      const newRight = selected.x + selected.width;
      const newBottom = selected.y + selected.height;

      cc.handlePointerUp({});

      return {
        origW,
        newW,
        origRatio,
        newRatio,
        ratioDiff: Math.abs(origRatio - newRatio),
        bottomRightAnchorFixed: Math.abs(origRight - newRight) < 2 && Math.abs(origBottom - newBottom) < 2
      };
    })()`);

    console.log('NW Corner Resize Result:', nwResizeRes);
    if (nwResizeRes.ratioDiff > 0.05 || !nwResizeRes.bottomRightAnchorFixed) {
      throw new Error('Test 3 failed: NW corner did not preserve proportional aspect ratio or anchor');
    }
    console.log('✅ NW corner resized proportionally with bottom-right anchor fixed.');

    // Test 4: Unproportional / Freeform Corner Resize with Shift / Ctrl
    console.log('\n--- Test 4: Freeform Corner Resize with Shift/Ctrl ---');
    const freeformRes = await evaluate(`(() => {
      const cc = window.canvasController;
      const selected = window.annotationManager.getSelectedAnnotation();
      const origW = selected.width;
      const origH = selected.height;
      const origRatio = origW / origH;

      const seHandle = document.querySelector('.selection-handle.handle-se');
      cc.handlePointerDown({
        button: 0,
        target: seHandle,
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        stopPropagation: () => {},
        preventDefault: () => {}
      });

      // Stretch width only with shiftKey = true: dx = 100, dy = 0
      cc.handlePointerMove({
        clientX: 300,
        clientY: 200,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false
      });

      const newW = selected.width;
      const newH = selected.height;
      const newRatio = newW / newH;

      cc.handlePointerUp({});

      return {
        origW,
        origH,
        newW,
        newH,
        origRatio,
        newRatio,
        ratioChanged: Math.abs(origRatio - newRatio) > 0.3
      };
    })()`);

    console.log('Shift-Freeform Result:', freeformRes);
    if (!freeformRes.ratioChanged || freeformRes.newH !== freeformRes.origH) {
      throw new Error('Test 4 failed: Holding Shift should allow unproportional freeform resizing');
    }
    console.log('✅ Holding Shift successfully allows unproportional / freeform stretching.');

    // Test 5: Edge Handle (E) Direct Single-Axis Stretch
    console.log('\n--- Test 5: Edge Handle (E) Single-Axis Stretch ---');
    const edgeRes = await evaluate(`(() => {
      const cc = window.canvasController;
      const selected = window.annotationManager.getSelectedAnnotation();
      const origW = selected.width;
      const origH = selected.height;

      const eHandle = document.querySelector('.selection-handle.handle-e');
      cc.handlePointerDown({
        button: 0,
        target: eHandle,
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        stopPropagation: () => {},
        preventDefault: () => {}
      });

      // Drag right: dx = 50, dy = 40 (dy should be ignored by E handle)
      cc.handlePointerMove({
        clientX: 250,
        clientY: 240,
        shiftKey: false
      });

      const newW = selected.width;
      const newH = selected.height;
      cc.handlePointerUp({});

      return {
        origW,
        origH,
        newW,
        newH,
        widthGrew: newW > origW,
        heightUnchanged: newH === origH
      };
    })()`);

    console.log('Edge Handle Result:', edgeRes);
    if (!edgeRes.widthGrew || !edgeRes.heightUnchanged) {
      throw new Error('Test 5 failed: Edge handle should adjust only width without affecting height');
    }
    console.log('✅ Edge handle adjusted width only, leaving height unchanged.');

    // Test 6: Image Insert Auto-Select & Proportional Resize
    console.log('\n--- Test 6: Image Insert Auto-Select & Proportional Resize ---');
    const imgTestRes = await evaluate(`(() => {
      // Create a test 200x100 dummy image DataURL
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(0, 0, 200, 100);
      const dataUrl = canvas.toDataURL('image/png');

      const pageSize = window.pdfEngine.getPageSize(0);
      const newAnn = window.annotationManager.addAnnotation({
        pageIndex: 0,
        type: 'image',
        x: 50,
        y: 50,
        width: 200,
        height: 100,
        imgDataUrl: dataUrl
      });
      window.uiController.selectTool('select');
      window.annotationManager.selectAnnotation(newAnn.id, false);

      const selected = window.annotationManager.getSelectedAnnotation();
      const origRatio = selected.width / selected.height;

      const cc = window.canvasController;
      const seHandle = document.querySelector('.selection-handle.handle-se');
      cc.handlePointerDown({
        button: 0,
        target: seHandle,
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        stopPropagation: () => {},
        preventDefault: () => {}
      });

      cc.handlePointerMove({
        clientX: 260,
        clientY: 230,
        shiftKey: false
      });

      const newW = selected.width;
      const newH = selected.height;
      const newRatio = newW / newH;
      cc.handlePointerUp({});

      return {
        isImageSelected: selected.type === 'image',
        origRatio,
        newRatio,
        ratioDiff: Math.abs(origRatio - newRatio),
        resized: newW > 200
      };
    })()`);

    console.log('Image Resize Result:', imgTestRes);
    if (!imgTestRes.isImageSelected || !imgTestRes.resized || imgTestRes.ratioDiff > 0.05) {
      throw new Error('Test 6 failed: Image was not selected or did not resize proportionally');
    }
    console.log('✅ Inserted image automatically selected and resizes proportionally on corner drag.');

    // Test 7: Click Signature / Image while in Edit Text mode switches to Select tool
    console.log('\n--- Test 7: Click Signature while in Edit Text mode switches to Select ---');
    const modeSwitchRes = await evaluate(`(() => {
      const cc = window.canvasController;
      // Switch to edit-pdf-text mode
      window.uiController.selectTool('edit-pdf-text');
      window.annotationManager.deselectAll();

      const anns = window.annotationManager.getAnnotationsForPage(0);
      const sig = anns.find(a => a.type === 'signature');
      if (!sig) return { error: 'No signature found' };

      const layer = cc.container.querySelector('.page-wrapper[data-page-index="' + cc.activePageIndex + '"] .annotation-layer');
      const rect = layer.getBoundingClientRect();

      // Simulate clicking on the signature
      cc.handlePointerDown({
        button: 0,
        target: layer,
        pointerId: 1,
        clientX: Math.round(rect.left + (sig.x + 10) * cc.zoom),
        clientY: Math.round(rect.top + (sig.y + 10) * cc.zoom),
        stopPropagation: () => {},
        preventDefault: () => {}
      });

      const selected = window.annotationManager.getSelectedAnnotation();
      const currentTool = cc.activeTool;
      const selectBtnActive = document.querySelector('.tool-btn[data-tool="select"]').classList.contains('active');

      cc.handlePointerUp({});

      return {
        selectedId: selected ? selected.id : null,
        sigId: sig.id,
        currentTool,
        selectBtnActive
      };
    })()`);

    console.log('Mode Switch Result:', modeSwitchRes);
    if (modeSwitchRes.selectedId !== modeSwitchRes.sigId || modeSwitchRes.currentTool !== 'select' || !modeSwitchRes.selectBtnActive) {
      throw new Error('Test 7 failed: Clicking signature in edit-pdf-text mode did not switch to select tool and select it');
    }
    console.log('✅ Clicking signature in edit-pdf-text mode automatically switches to Select tool and selects it.');

    console.log('\n====================================================');
    console.log('🎉 ALL SIGNATURE & IMAGE RESIZE TESTS PASSED!');
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
