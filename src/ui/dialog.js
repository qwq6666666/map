/* ---------------------------------------------------------
   ui/dialog.js — 站內對話框，取代瀏覽器原生 alert()／confirm()／prompt()
   ---------------------------------------------------------
   原生對話框在手機瀏覽器（尤其 iOS 的 PWA／全螢幕模式）表現不穩定，
   視覺也跟站內其他視窗不一致。這裡提供同語意、但回傳 Promise 的版本：
     showAlert(message, opts)   -> Promise<void>
     showConfirm(message, opts) -> Promise<boolean>
     showPrompt(message, opts)  -> Promise<string|null>（取消回傳 null）
   opts：title、confirmText、cancelText、danger（確認鈕改紅色、預設
   聚焦在取消鈕）、defaultValue／placeholder／maxLength（僅 prompt）。

   同一時間只顯示一個對話框，多個呼叫會排隊依序顯示（例如連續畫兩個
   點）。DOM 是要用時才建立、關閉即移除，不需要在 index.html 預留容器，
   也不需要 init 函式。文字一律用 textContent 寫入（不經 innerHTML），
   訊息裡的 \n 由 CSS white-space:pre-line 換行。
--------------------------------------------------------- */

const queue = [];
let active = false;

function el(tag, className){
  const node = document.createElement(tag);
  if(className) node.className = className;
  return node;
}

function enqueue(spec){
  return new Promise(resolve => {
    queue.push({ spec, resolve });
    pump();
  });
}

function pump(){
  if(active || queue.length === 0) return;
  active = true;
  const { spec, resolve } = queue.shift();
  openDialog(spec, (result) => {
    active = false;
    resolve(result);
    pump();
  });
}

function openDialog(spec, done){
  const { kind, message, title, danger } = spec;
  const previousFocus = document.activeElement;

  const overlay = el('div', 'app-dialog-overlay');
  const card = el('div', 'app-dialog-card');
  card.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
  card.setAttribute('aria-modal', 'true');

  let titleEl = null;
  if(title){
    titleEl = el('h2', 'app-dialog-title');
    titleEl.id = 'appDialogTitle';
    titleEl.textContent = title;
    card.appendChild(titleEl);
  }
  const messageEl = el('p', 'app-dialog-message');
  messageEl.id = 'appDialogMessage';
  messageEl.textContent = message;
  card.appendChild(messageEl);
  card.setAttribute('aria-labelledby', titleEl ? 'appDialogTitle' : 'appDialogMessage');
  if(titleEl) card.setAttribute('aria-describedby', 'appDialogMessage');

  let input = null;
  if(kind === 'prompt'){
    input = el('input', 'app-dialog-input');
    input.type = 'text';
    input.value = spec.defaultValue ?? '';
    if(spec.placeholder) input.placeholder = spec.placeholder;
    if(spec.maxLength) input.maxLength = spec.maxLength;
    input.setAttribute('aria-labelledby', 'appDialogMessage');
    card.appendChild(input);
  }

  const actions = el('div', 'app-dialog-actions');
  let cancelBtn = null;
  if(kind !== 'alert'){
    cancelBtn = el('button', 'app-dialog-btn secondary');
    cancelBtn.type = 'button';
    cancelBtn.textContent = spec.cancelText ?? '取消';
    actions.appendChild(cancelBtn);
  }
  const confirmBtn = el('button', `app-dialog-btn ${danger ? 'danger' : 'primary'}`);
  confirmBtn.type = 'button';
  confirmBtn.textContent = spec.confirmText ?? '確定';
  actions.appendChild(confirmBtn);
  card.appendChild(actions);
  overlay.appendChild(card);

  let closed = false;
  const close = (result) => {
    if(closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    // 還原開啟前的焦點，鍵盤／螢幕閱讀器使用者才不會被丟回頁首。
    if(previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    done(result);
  };
  const accept = () => {
    if(kind === 'prompt') close(input.value);
    else close(kind === 'confirm' ? true : undefined);
  };
  const dismiss = () => {
    if(kind === 'prompt') close(null);
    else close(kind === 'confirm' ? false : undefined);
  };

  const focusables = [input, cancelBtn, confirmBtn].filter(Boolean);
  function onKeyDown(e){
    if(e.key === 'Escape'){
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if(e.key === 'Enter' && input && e.target === input){
      // 中文輸入法選字時按 Enter 是「送出候選字」，不是「確認對話框」。
      if(e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      accept();
    } else if(e.key === 'Tab'){
      // 焦點限制在對話框內，避免 Tab 跑到被遮罩蓋住的地圖控制項。
      const idx = focusables.indexOf(document.activeElement);
      const next = e.shiftKey
        ? focusables[(idx <= 0 ? focusables.length : idx) - 1]
        : focusables[(idx + 1) % focusables.length];
      e.preventDefault();
      next.focus();
    }
  }

  confirmBtn.addEventListener('click', accept);
  if(cancelBtn) cancelBtn.addEventListener('click', dismiss);
  // 點遮罩空白處：alert／confirm 視為取消；prompt 不處理，避免手滑點到
  // 空白處就把打到一半的文字丟掉，一定要按按鈕或 Esc。
  overlay.addEventListener('click', (e) => {
    if(e.target === overlay && kind !== 'prompt') dismiss();
  });
  // 按在遮罩空白處預設會讓輸入框失焦（焦點掉回 body），之後 Enter 就送不出去；
  // 擋掉 mousedown 的預設行為讓焦點留在對話框內。
  overlay.addEventListener('mousedown', (e) => {
    if(e.target === overlay) e.preventDefault();
  });
  document.addEventListener('keydown', onKeyDown, true);

  document.body.appendChild(overlay);
  if(input){
    input.focus();
    if(typeof input.select === 'function') input.select();
  } else if(danger && cancelBtn){
    cancelBtn.focus(); // 危險操作預設聚焦「取消」，避免手滑 Enter 直接確認
  } else {
    confirmBtn.focus();
  }
}

export function showAlert(message, opts = {}){
  return enqueue({ kind: 'alert', message, ...opts });
}

export function showConfirm(message, opts = {}){
  return enqueue({ kind: 'confirm', message, ...opts });
}

export function showPrompt(message, opts = {}){
  return enqueue({ kind: 'prompt', message, ...opts });
}
