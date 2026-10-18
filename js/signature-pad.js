/**
 * Signature Pad Controller
 * Manages the Digital Signature Dialog (Draw, Type, Upload) and inserts signatures as annotations.
 */

class SignaturePadController {
  constructor(dialogElement, annotationManager, canvasController) {
    this.dialog = dialogElement;
    this.annotationManager = annotationManager;
    this.canvasController = canvasController;

    this.activeTab = 'draw'; // 'draw', 'type', 'upload'
    this.drawColor = '#0f172a';
    this.isDrawing = false;
    this.hasDrawn = false;
    this.points = [];

    this.typedFontIndex = 1;
    this.uploadedDataUrl = null;

    // Elements
    this.canvas = this.dialog.querySelector('.sig-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.typeInput = this.dialog.querySelector('.sig-type-input');

    this.init();
  }

  init() {
    if (!this.dialog) return;

    // Tabs
    const tabBtns = this.dialog.querySelectorAll('.sig-tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.switchTab(btn.dataset.tab);
      });
    });

    // Draw canvas events
    if (this.canvas) {
      this.resizeCanvas();
      this.canvas.addEventListener('pointerdown', (e) => this.startDrawing(e));
      this.canvas.addEventListener('pointermove', (e) => this.drawMove(e));
      this.canvas.addEventListener('pointerup', () => this.stopDrawing());
      this.canvas.addEventListener('pointercancel', () => this.stopDrawing());
    }

    // Color buttons
    const colorBtns = this.dialog.querySelectorAll('.sig-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.drawColor = btn.dataset.color || '#0f172a';
      });
    });

    // Clear button
    const clearBtn = this.dialog.querySelector('#btn-sig-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearDraw());
    }

    // Type input
    if (this.typeInput) {
      this.typeInput.addEventListener('input', () => this.updateTypePreviews());
    }

    // Type preview cards
    const previewCards = this.dialog.querySelectorAll('.sig-preview-card');
    previewCards.forEach(card => {
      card.addEventListener('click', () => {
        previewCards.forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        this.typedFontIndex = parseInt(card.dataset.fontIndex, 10) || 1;
      });
    });

    // Upload zone
    const uploadZone = this.dialog.querySelector('.sig-upload-container');
    const uploadInput = this.dialog.querySelector('#sig-file-input');
    if (uploadZone && uploadInput) {
      uploadZone.addEventListener('click', () => uploadInput.click());
      uploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this.handleUploadedFile(file);
      });

      uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
      });
      uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
      uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) this.handleUploadedFile(file);
      });
    }

    // Cancel / Close
    const closeBtns = this.dialog.querySelectorAll('[data-action="close-dialog"]');
    closeBtns.forEach(btn => {
      btn.addEventListener('click', () => this.dialog.close());
    });

    // Insert Signature button
    const insertBtn = this.dialog.querySelector('#btn-insert-signature');
    if (insertBtn) {
      insertBtn.addEventListener('click', () => this.insertSignature());
    }
  }

  // Open modal
  open() {
    this.dialog.showModal();
    this.resizeCanvas();
    if (this.activeTab === 'draw') {
      this.clearDraw();
    } else if (this.activeTab === 'type') {
      this.updateTypePreviews();
      if (this.typeInput) this.typeInput.focus();
    }
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    if (this.ctx) {
      this.ctx.scale(dpr, dpr);
    }
  }

  switchTab(tab) {
    this.activeTab = tab;
    this.dialog.querySelectorAll('.sig-tab-content').forEach(el => el.style.display = 'none');
    const target = this.dialog.querySelector(`.sig-tab-content[data-tab="${tab}"]`);
    if (target) target.style.display = 'block';

    if (tab === 'draw') {
      setTimeout(() => this.resizeCanvas(), 50);
    } else if (tab === 'type') {
      this.updateTypePreviews();
      if (this.typeInput) this.typeInput.focus();
    }
  }

  // Draw interactions
  startDrawing(e) {
    this.isDrawing = true;
    this.hasDrawn = true;
    this.points = [];
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.points.push(pt);
    this.canvas.setPointerCapture(e.pointerId);
  }

  drawMove(e) {
    if (!this.isDrawing) return;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.points.push(pt);

    const ctx = this.ctx;
    ctx.strokeStyle = this.drawColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.points.length > 2) {
      const p1 = this.points[this.points.length - 2];
      const p2 = this.points[this.points.length - 1];
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  stopDrawing() {
    this.isDrawing = false;
  }

  clearDraw() {
    if (!this.ctx || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.hasDrawn = false;
    this.points = [];
  }

  // Type Signature
  updateTypePreviews() {
    const text = (this.typeInput ? this.typeInput.value : '').trim() || 'Your Name';
    const previews = this.dialog.querySelectorAll('.sig-text-preview');
    previews.forEach(p => p.textContent = text);
  }

  // Handle uploaded file
  handleUploadedFile(file) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.uploadedDataUrl = e.target.result;
      const preview = this.dialog.querySelector('.sig-upload-preview');
      const placeholder = this.dialog.querySelector('.sig-upload-placeholder');
      if (preview && placeholder) {
        preview.src = this.uploadedDataUrl;
        preview.style.display = 'block';
        placeholder.style.display = 'none';
      }
    };
    reader.readAsDataURL(file);
  }

  // Generate PNG data URL for insertion
  generateSignaturePng() {
    if (this.activeTab === 'draw') {
      if (!this.hasDrawn) return null;
      // Trim transparent pixels
      return this.canvas.toDataURL('image/png');
    }

    if (this.activeTab === 'type') {
      const text = (this.typeInput ? this.typeInput.value : '').trim();
      if (!text) return null;

      const offscreen = document.createElement('canvas');
      offscreen.width = 400;
      offscreen.height = 120;
      const ctx = offscreen.getContext('2d');

      let fontFamily = 'Brush Script MT, cursive';
      if (this.typedFontIndex === 2) {
        fontFamily = 'Lucida Handwriting, Segoe Script, cursive';
      } else if (this.typedFontIndex === 3) {
        fontFamily = 'Apple Chancery, cursive';
      }

      ctx.font = `italic 42px ${fontFamily}`;
      ctx.fillStyle = this.drawColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 200, 60);

      return offscreen.toDataURL('image/png');
    }

    if (this.activeTab === 'upload') {
      return this.uploadedDataUrl;
    }

    return null;
  }

  // Insert signature onto current active page
  insertSignature() {
    const pngData = this.generateSignaturePng();
    if (!pngData) {
      alert('Please provide or draw a signature first.');
      return;
    }

    const pageIndex = this.canvasController.activePageIndex;
    const pageSize = this.canvasController.pdfEngine.getPageSize(pageIndex);

    // Initial signature dimensions
    const width = 160;
    const height = 65;

    // Center in visible page area
    const x = Math.round((pageSize.width - width) / 2);
    const y = Math.round((pageSize.height - height) / 2);

    this.annotationManager.addAnnotation({
      pageIndex,
      type: 'signature',
      x,
      y,
      width,
      height,
      imgDataUrl: pngData,
    });

    this.canvasController.setTool('select');
    this.dialog.close();
  }
}

window.SignaturePadController = SignaturePadController;
