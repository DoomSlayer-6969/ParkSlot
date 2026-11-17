// The driver app's single dialog: each step of a flow replaces its contents.
import { $ } from '../common.js';

const dialog = $('#modal');
let onCloseHandler = null;
let timer = null;

/** Shows `html` in the dialog. `onClose` runs once when the dialog is closed (not when it is replaced). */
export function openModal(html, onClose = null) {
  clearInterval(timer);
  $('#modal-body').innerHTML = html;
  onCloseHandler = onClose;
  if (!dialog.open) dialog.showModal();
}

export function closeModal() {
  dialog.close();
}

/** Replaces what happens when the current dialog is closed (e.g. after an error changed availability). */
export function setModalOnClose(fn) {
  onCloseHandler = fn;
}

/** Runs `fn` every `ms` until the dialog's contents change or it closes. Returns a function that stops it. */
export function repeatWhileOpen(fn, ms) {
  clearInterval(timer);
  timer = setInterval(fn, ms);
  const id = timer;
  return () => clearInterval(id);
}

dialog.addEventListener('close', () => {
  clearInterval(timer);
  const onClose = onCloseHandler;
  onCloseHandler = null;
  onClose?.();
});
dialog.addEventListener('click', (e) => { if (e.target === dialog) closeModal(); });
$('#modal-close').addEventListener('click', closeModal);
