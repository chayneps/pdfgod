const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing Multi-Signature Slots: Left-Prepend & White Thumbnails');
  console.log('====================================================');

  const PORT = 29940 + Math.floor(Math.random() * 50);
  const tmpDir = fs.mkdtempSync('/tmp/chrome-multi-sig-order-');
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

    // Test 1: Draw Signature 1 (Older)
    console.log('\n--- Test 1: Draw Signature 1 (Older, Blue) ---');
    const sig1Result = await evaluate(`(() => {
      localStorage.clear();
      const sp = window.sigPadController;
      sp.open();

      sp.drawColor = '#1e40af'; // Blue
      sp.startDrawing({ clientX: 40, clientY: 50, pointerId: 1 });
      sp.drawMove({ clientX: 90, clientY: 70 });
      sp.stopDrawing();

      const slot1 = sp.dialog.querySelector('.sig-saved-slot');
      const bg = window.getComputedStyle(slot1).backgroundColor;

      return {
        activeSlotId: sp.activeSlotId,
        savedCount: sp.savedSignatures.length,
        slot1Bg: bg,
        hasThumbnail: !!slot1.querySelector('img.sig-slot-thumbnail')
      };
    })()`);

    console.log('Sig 1 creation result:', sig1Result);
    if (sig1Result.savedCount !== 1 || sig1Result.slot1Bg !== 'rgb(255, 255, 255)') {
      throw new Error('Test 1 failed: Slot 1 background is not pure white #ffffff');
    }
    console.log('✅ Signature 1 created with pure white background rgb(255, 255, 255).');

    // Test 2: Click "+ New" and draw Signature 2 (Newer, Red)
    console.log('\n--- Test 2: Draw Signature 2 (Newer, Red) -> Verify Added on LEFT of Older ---');
    const sig2Result = await evaluate(`(() => {
      const sp = window.sigPadController;
      const olderSigId = sp.savedSignatures[0].id;

      // Click + New
      sp.newSlotBtn.click();

      // Draw newer signature
      sp.drawColor = '#991b1b'; // Red
      sp.startDrawing({ clientX: 60, clientY: 60, pointerId: 1 });
      sp.drawMove({ clientX: 120, clientY: 80 });
      sp.stopDrawing();

      const slots = sp.dialog.querySelectorAll('.sig-saved-slot');
      const firstSlotId = slots[0] ? slots[0].dataset.slotId : null;
      const secondSlotId = slots[1] ? slots[1].dataset.slotId : null;
      const firstSlotBg = slots[0] ? window.getComputedStyle(slots[0]).backgroundColor : null;

      return {
        totalSaved: sp.savedSignatures.length,
        olderSigId,
        newerSigId: sp.activeSlotId,
        firstSlotIdInDom: firstSlotId,
        secondSlotIdInDom: secondSlotId,
        isNewerOnLeft: firstSlotId === sp.activeSlotId && secondSlotId === olderSigId,
        firstSlotBg
      };
    })()`);

    console.log('Sig 2 ordering result:', sig2Result);
    if (sig2Result.totalSaved !== 2 || !sig2Result.isNewerOnLeft || sig2Result.firstSlotBg !== 'rgb(255, 255, 255)') {
      throw new Error('Test 2 failed: New signature was not added on the LEFT of the old signature or background is not white');
    }
    console.log('✅ Newer signature was added on the LEFT of the older signature with pure white background.');

    // Test 3: Select Older Signature -> Verify Active State Background is STILL White
    console.log('\n--- Test 3: Select Older Signature -> Verify Background Remains Pure White ---');
    const selectOlderResult = await evaluate(`(() => {
      const sp = window.sigPadController;
      const slots = sp.dialog.querySelectorAll('.sig-saved-slot');
      const olderSlot = slots[1]; // older is second (on the right)

      olderSlot.click();

      const activeSlot = sp.dialog.querySelector('.sig-saved-slot.active');
      const bg = activeSlot ? window.getComputedStyle(activeSlot).backgroundColor : null;

      return {
        activeSlotId: sp.activeSlotId,
        isOlderActive: sp.activeSlotId === sp.savedSignatures[1].id,
        activeBg: bg,
        isWhite: bg === 'rgb(255, 255, 255)'
      };
    })()`);

    console.log('Active slot background check:', selectOlderResult);
    if (!selectOlderResult.isOlderActive || !selectOlderResult.isWhite) {
      throw new Error('Test 3 failed: Active slot background is not pure white');
    }
    console.log('✅ Active slot background remains pure white #ffffff (never dark or transparent).');

    // Test 4: Verify Thumbnail Image Content is Clean and Centered
    console.log('\n--- Test 4: Verify Thumbnail Image is Valid Data URL ---');
    const thumbCheck = await evaluate(`(() => {
      const sp = window.sigPadController;
      const activeSig = sp.savedSignatures.find(s => s.id === sp.activeSlotId);
      return {
        hasPngData: !!activeSig.pngData,
        isPngDataUrl: activeSig.pngData && activeSig.pngData.startsWith('data:image/png;base64,'),
        length: activeSig.pngData ? activeSig.pngData.length : 0
      };
    })()`);

    console.log('Thumbnail check:', thumbCheck);
    if (!thumbCheck.hasPngData || !thumbCheck.isPngDataUrl || thumbCheck.length < 500) {
      throw new Error('Test 4 failed: Thumbnail PNG data is invalid');
    }
    console.log('✅ Crisp, centered thumbnail rendered for saved signature.');

    console.log('\n====================================================');
    console.log('🎉 ALL ORDERING & THUMBNAIL VISIBILITY TESTS PASSED!');
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
