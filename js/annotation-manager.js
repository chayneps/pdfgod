/**
 * Annotation Manager
 * Manages document annotations, selection, history (undo/redo), and state changes.
 */

class AnnotationManager {
  constructor() {
    // Array of annotations
    this.annotations = [];
    this.selectedAnnotationId = null;
    this.selectedAnnotationIds = new Set();

    // Undo / Redo history stacks
    this.historyStack = [];
    this.redoStack = [];
    this.maxHistory = 50;

    // Listeners for state change
    this.changeListeners = [];
    this.selectionListeners = [];
  }

  // Generate unique ID
  generateId() {
    return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  }

  // Subscribe to changes
  onChange(callback) {
    this.changeListeners.push(callback);
  }

  onSelectionChange(callback) {
    this.selectionListeners.push(callback);
  }

  notifyChange(actionType = 'update') {
    this.changeListeners.forEach(fn => fn(this.annotations, actionType));
  }

  notifySelection() {
    const selected = this.getSelectedAnnotation();
    const allSelected = this.getSelectedAnnotations();
    this.selectionListeners.forEach(fn => fn(selected, allSelected));
  }

  // Record history snapshot for undo
  pushHistory(description = 'action') {
    // Deep clone annotations
    const snapshot = JSON.parse(JSON.stringify(this.annotations));
    this.historyStack.push({
      description,
      snapshot,
      selectedId: this.selectedAnnotationId,
      selectedIds: Array.from(this.selectedAnnotationIds)
    });

    if (this.historyStack.length > this.maxHistory) {
      this.historyStack.shift();
    }

    // Clear redo on new action
    this.redoStack = [];
  }

  canUndo() {
    return this.historyStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return;

    // Push current state to redo
    const currentSnapshot = JSON.parse(JSON.stringify(this.annotations));
    this.redoStack.push({
      snapshot: currentSnapshot,
      selectedId: this.selectedAnnotationId,
      selectedIds: Array.from(this.selectedAnnotationIds)
    });

    const previous = this.historyStack.pop();
    this.annotations = previous.snapshot;
    this.selectedAnnotationId = previous.selectedId;
    this.selectedAnnotationIds = new Set(previous.selectedIds || (previous.selectedId ? [previous.selectedId] : []));

    this.notifyChange('undo');
    this.notifySelection();
  }

  redo() {
    if (!this.canRedo()) return;

    const currentSnapshot = JSON.parse(JSON.stringify(this.annotations));
    this.historyStack.push({
      snapshot: currentSnapshot,
      selectedId: this.selectedAnnotationId,
      selectedIds: Array.from(this.selectedAnnotationIds)
    });

    const next = this.redoStack.pop();
    this.annotations = next.snapshot;
    this.selectedAnnotationId = next.selectedId;
    this.selectedAnnotationIds = new Set(next.selectedIds || (next.selectedId ? [next.selectedId] : []));

    this.notifyChange('redo');
    this.notifySelection();
  }

  // Add Annotation
  addAnnotation(annotation) {
    this.pushHistory(`Add ${annotation.type}`);
    if (!annotation.id) {
      annotation.id = this.generateId();
    }
    this.annotations.push(annotation);
    this.selectedAnnotationId = annotation.id;
    this.selectedAnnotationIds = new Set([annotation.id]);

    this.notifyChange('add');
    this.notifySelection();
    return annotation;
  }

  // Add multiple annotations atomically (e.g. for Paste)
  addAnnotations(annotationList, description = null) {
    if (!annotationList || annotationList.length === 0) return [];

    annotationList.forEach(a => {
      if (!a.id) a.id = this.generateId();
      this.annotations.push(a);
    });

    this.selectedAnnotationIds = new Set(annotationList.map(a => a.id));
    this.selectedAnnotationId = annotationList[0].id;

    const desc = description || `Add ${annotationList.length} element${annotationList.length > 1 ? 's' : ''}`;
    this.pushHistory(desc);

    this.notifyChange('add');
    this.notifySelection();
    return annotationList;
  }

  // Update Annotation
  updateAnnotation(id, updates, recordHistory = true) {
    const item = this.getAnnotation(id);
    if (!item) return;

    if (recordHistory) {
      this.pushHistory(`Update ${item.type}`);
    }

    Object.assign(item, updates);
    this.notifyChange('update');
  }

  // Delete Annotation
  deleteAnnotation(id) {
    const item = this.getAnnotation(id);
    if (!item) return;

    this.pushHistory(`Delete ${item.type}`);
    this.annotations = this.annotations.filter(a => a.id !== id);
    this.selectedAnnotationIds.delete(id);

    if (this.selectedAnnotationId === id) {
      this.selectedAnnotationId = this.selectedAnnotationIds.size > 0
        ? Array.from(this.selectedAnnotationIds)[0]
        : null;
      this.notifySelection();
    }

    this.notifyChange('delete');
  }

  // Get by ID
  getAnnotation(id) {
    return this.annotations.find(a => a.id === id);
  }

  // Get Primary Selected
  getSelectedAnnotation() {
    if (!this.selectedAnnotationId) return null;
    return this.getAnnotation(this.selectedAnnotationId) || null;
  }

  // Get All Selected Annotations
  getSelectedAnnotations() {
    if (this.selectedAnnotationIds.size === 0) {
      if (this.selectedAnnotationId) {
        const item = this.getAnnotation(this.selectedAnnotationId);
        return item ? [item] : [];
      }
      return [];
    }
    return Array.from(this.selectedAnnotationIds)
      .map(id => this.getAnnotation(id))
      .filter(Boolean);
  }

  // Check if an annotation is selected
  isSelected(id) {
    if (!id) return false;
    return this.selectedAnnotationIds.has(id) || this.selectedAnnotationId === id;
  }

  // Select Annotation (supports multi-selection with isMulti)
  selectAnnotation(id, isMulti = false) {
    if (!id) return;
    if (isMulti) {
      if (this.selectedAnnotationIds.has(id)) {
        this.selectedAnnotationIds.delete(id);
        if (this.selectedAnnotationId === id) {
          this.selectedAnnotationId = this.selectedAnnotationIds.size > 0
            ? Array.from(this.selectedAnnotationIds)[0]
            : null;
        }
      } else {
        this.selectedAnnotationIds.add(id);
        this.selectedAnnotationId = id;
      }
    } else {
      this.selectedAnnotationIds = new Set([id]);
      this.selectedAnnotationId = id;
    }
    this.notifySelection();
  }

  deselectAll() {
    if (this.selectedAnnotationId === null && this.selectedAnnotationIds.size === 0) return;
    this.selectedAnnotationId = null;
    this.selectedAnnotationIds.clear();
    this.notifySelection();
  }

  // Get Annotations for a Page
  getAnnotationsForPage(pageIndex) {
    return this.annotations.filter(a => a.pageIndex === pageIndex);
  }

  getPageAnnotations(pageIndex) {
    return this.getAnnotationsForPage(pageIndex);
  }

  // Duplicate annotation
  duplicateAnnotation(id) {
    const item = this.getAnnotation(id);
    if (!item) return;

    const clone = JSON.parse(JSON.stringify(item));
    clone.id = this.generateId();
    clone.x += 15;
    clone.y += 15;

    this.addAnnotation(clone);
    return clone;
  }

  // Bring to front
  bringToFront(id) {
    const index = this.annotations.findIndex(a => a.id === id);
    if (index === -1 || index === this.annotations.length - 1) return;

    this.pushHistory('Bring to front');
    const [item] = this.annotations.splice(index, 1);
    this.annotations.push(item);
    this.notifyChange('reorder');
  }

  // Send to back
  sendToBack(id) {
    const index = this.annotations.findIndex(a => a.id === id);
    if (index <= 0) return;

    this.pushHistory('Send to back');
    const [item] = this.annotations.splice(index, 1);
    this.annotations.unshift(item);
    this.notifyChange('reorder');
  }

  // Update page index after page deletions or insertions
  handlePageRemoved(removedPageIndex) {
    this.pushHistory('Page removed');
    // Remove annotations on the deleted page
    this.annotations = this.annotations.filter(a => a.pageIndex !== removedPageIndex);
    // Decrement pageIndex for subsequent pages
    this.annotations.forEach(a => {
      if (a.pageIndex > removedPageIndex) {
        a.pageIndex -= 1;
      }
    });
    this.selectedAnnotationId = null;
    this.notifyChange('page-modified');
    this.notifySelection();
  }

  handlePageInserted(insertedAtIndex) {
    this.handlePagesInserted(insertedAtIndex, 1);
  }

  handlePagesInserted(insertedAtIndex, count = 1) {
    if (count <= 0) return;
    this.pushHistory(`${count} page(s) inserted`);
    this.annotations.forEach(a => {
      if (a.pageIndex >= insertedAtIndex) {
        a.pageIndex += count;
      }
    });
    this.notifyChange('page-modified');
  }

  // Handle page reordering
  handlePageMoved(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    this.pushHistory(`Page ${fromIndex + 1} moved to ${toIndex + 1}`);

    this.annotations.forEach(a => {
      if (a.pageIndex === fromIndex) {
        a.pageIndex = toIndex;
      } else if (fromIndex < toIndex) {
        if (a.pageIndex > fromIndex && a.pageIndex <= toIndex) {
          a.pageIndex -= 1;
        }
      } else if (fromIndex > toIndex) {
        if (a.pageIndex >= toIndex && a.pageIndex < fromIndex) {
          a.pageIndex += 1;
        }
      }
    });

    this.notifyChange('page-modified');
  }

  // Handle multi-page reordering with index map
  handlePagesReordered(oldIndexToNewIndex) {
    if (!oldIndexToNewIndex || !(oldIndexToNewIndex instanceof Map)) return;
    this.pushHistory(`Pages reordered`);

    this.annotations.forEach(a => {
      if (oldIndexToNewIndex.has(a.pageIndex)) {
        a.pageIndex = oldIndexToNewIndex.get(a.pageIndex);
      }
    });

    this.notifyChange('page-modified');
  }

  // Clear all
  clear() {
    this.annotations = [];
    this.selectedAnnotationId = null;
    this.selectedAnnotationIds.clear();
    this.historyStack = [];
    this.redoStack = [];
    this.notifyChange('clear');
    this.notifySelection();
  }
}

window.AnnotationManager = AnnotationManager;
