import '../env-stub.mjs';
import { test, expect, afterEach } from 'vitest';
import { showAlert, showConfirm, showPrompt } from '../../src/ui/dialog.js';

// env-stub 的 document.addEventListener 是空實作、沒有 removeEventListener，
// 這裡補一份能記錄／派送 keydown 的版本，才驗得到鍵盤操作與「關閉後有解除監聽」。
const keydownListeners = new Set();
document.addEventListener = (ev, fn) => { if(ev === 'keydown') keydownListeners.add(fn); };
document.removeEventListener = (ev, fn) => { if(ev === 'keydown') keydownListeners.delete(fn); };

function pressKey(init){
  const e = { preventDefault(){}, stopPropagation(){}, ...init };
  [...keydownListeners].forEach(fn => fn(e));
  return e;
}

const getOverlay = () => document.querySelector('.app-dialog-overlay');
const getButtons = (overlay) => overlay.querySelectorAll('.app-dialog-btn');
const getInput = (overlay) => overlay.querySelector('.app-dialog-input');
const clickBackdrop = (overlay) =>
  (overlay._listeners.click || []).forEach(fn => fn({ target: overlay }));

// 前一個測試若沒關乾淨（例如斷言失敗中途離開），把殘留的對話框用 Esc 關掉，
// 避免影響後面的測試（同一時間只會顯示一個，殘留會卡住佇列）。
afterEach(() => {
  let guard = 5;
  while(getOverlay() && guard-- > 0) pressKey({ key: 'Escape' });
});

test('showAlert：顯示訊息、只有一顆按鈕，按下後 resolve 並移除對話框', async () => {
  const p = showAlert('匯入失敗');
  const overlay = getOverlay();
  expect(overlay, '應該出現對話框').toBeTruthy();
  const card = overlay.querySelector('.app-dialog-card');
  expect(card.getAttribute('role')).toBe('alertdialog');
  expect(overlay.querySelector('.app-dialog-message').textContent).toBe('匯入失敗');
  const buttons = getButtons(overlay);
  expect(buttons.length, 'alert 只有一顆確認鈕').toBe(1);
  buttons[0].click();
  expect(await p).toBeUndefined();
  expect(getOverlay(), '關閉後應該從 DOM 移除').toBeNull();
  expect(keydownListeners.size, '關閉後應解除 keydown 監聽').toBe(0);
});

test('訊息一律當純文字寫入，不會被當成 HTML 解析', async () => {
  const p = showAlert('<img src=x onerror=alert(1)>');
  const overlay = getOverlay();
  const msg = overlay.querySelector('.app-dialog-message');
  expect(msg.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(msg.children.length, '不該產生任何子元素').toBe(0);
  getButtons(overlay)[0].click();
  await p;
});

test('showConfirm：按確認回傳 true、按取消回傳 false', async () => {
  let p = showConfirm('確定嗎？');
  getButtons(getOverlay())[1].click(); // [取消, 確定]
  expect(await p).toBe(true);

  p = showConfirm('確定嗎？');
  getButtons(getOverlay())[0].click();
  expect(await p).toBe(false);
});

test('showConfirm：Esc 與點遮罩空白處都視為取消', async () => {
  let p = showConfirm('確定嗎？');
  pressKey({ key: 'Escape' });
  expect(await p, 'Esc').toBe(false);

  p = showConfirm('確定嗎？');
  clickBackdrop(getOverlay());
  expect(await p, '點遮罩').toBe(false);
});

test('showConfirm：點到對話框卡片本身（非遮罩）不會關閉', async () => {
  const p = showConfirm('確定嗎？');
  const overlay = getOverlay();
  const card = overlay.querySelector('.app-dialog-card');
  (overlay._listeners.click || []).forEach(fn => fn({ target: card }));
  expect(getOverlay(), '對話框應仍在').toBeTruthy();
  pressKey({ key: 'Escape' });
  await p;
});

test('showConfirm({ danger })：確認鈕用 danger 樣式、可自訂按鈕文字；一般確認用 primary', async () => {
  let p = showConfirm('要清除嗎？', { danger: true, confirmText: '清除', cancelText: '先不要' });
  let [cancelBtn, confirmBtn] = getButtons(getOverlay());
  expect(confirmBtn.classList.contains('danger')).toBeTruthy();
  expect(confirmBtn.classList.contains('primary')).toBeFalsy();
  expect(confirmBtn.textContent).toBe('清除');
  expect(cancelBtn.textContent).toBe('先不要');
  cancelBtn.click();
  await p;

  p = showConfirm('普通確認');
  [cancelBtn, confirmBtn] = getButtons(getOverlay());
  expect(confirmBtn.classList.contains('primary')).toBeTruthy();
  expect(confirmBtn.textContent, '預設文字').toBe('確定');
  cancelBtn.click();
  await p;
});

test('showPrompt：預設值帶入輸入框，按確認回傳輸入的文字', async () => {
  const p = showPrompt('名稱：', { defaultValue: '舊值', placeholder: '可留空', maxLength: 10 });
  const overlay = getOverlay();
  const input = getInput(overlay);
  expect(input.value).toBe('舊值');
  expect(input.placeholder).toBe('可留空');
  expect(input.maxLength).toBe(10);
  input.value = '西門溝';
  getButtons(overlay)[1].click();
  expect(await p).toBe('西門溝');
});

test('showPrompt：沒給預設值時輸入框是空字串', async () => {
  const p = showPrompt('名稱：');
  const overlay = getOverlay();
  expect(getInput(overlay).value).toBe('');
  getButtons(overlay)[1].click();
  expect(await p).toBe('');
});

test('showPrompt：取消／Esc 回傳 null', async () => {
  let p = showPrompt('名稱：');
  getInput(getOverlay()).value = '打到一半';
  getButtons(getOverlay())[0].click();
  expect(await p, '取消').toBeNull();

  p = showPrompt('名稱：');
  pressKey({ key: 'Escape' });
  expect(await p, 'Esc').toBeNull();
});

test('showPrompt：在輸入框按 Enter 等於確認', async () => {
  const p = showPrompt('名稱：');
  const input = getInput(getOverlay());
  input.value = '大灣庄';
  pressKey({ key: 'Enter', target: input });
  expect(await p).toBe('大灣庄');
});

test('showPrompt：中文輸入法選字中按 Enter 不會誤送出', async () => {
  const p = showPrompt('名稱：');
  const overlay = getOverlay();
  const input = getInput(overlay);
  input.value = 'ㄉㄚ';
  pressKey({ key: 'Enter', target: input, isComposing: true });
  pressKey({ key: 'Enter', target: input, keyCode: 229 });
  expect(getOverlay(), '選字中不該關閉').toBeTruthy();
  pressKey({ key: 'Enter', target: input });
  expect(await p).toBe('ㄉㄚ');
});

test('showPrompt：點遮罩空白處不會關閉（避免手滑丟掉打到一半的文字）', async () => {
  const p = showPrompt('名稱：');
  const overlay = getOverlay();
  clickBackdrop(overlay);
  expect(getOverlay(), '對話框應仍在').toBeTruthy();
  pressKey({ key: 'Escape' });
  await p;
});

test('按在遮罩空白處會擋掉 mousedown 預設行為（避免輸入框失焦）；按在卡片上則不擋', async () => {
  const p = showPrompt('名稱：');
  const overlay = getOverlay();
  const card = overlay.querySelector('.app-dialog-card');
  const fire = (target) => {
    let prevented = false;
    (overlay._listeners.mousedown || []).forEach(fn => fn({ target, preventDefault(){ prevented = true; } }));
    return prevented;
  };
  expect(fire(overlay), '遮罩').toBe(true);
  expect(fire(card), '卡片').toBe(false);
  pressKey({ key: 'Escape' });
  await p;
});

test('Tab 焦點限制在對話框內：Tab 到第一個、Shift+Tab 到最後一個可聚焦元素', async () => {
  const p = showPrompt('名稱：');
  const overlay = getOverlay();
  const input = getInput(overlay);
  const [cancelBtn, confirmBtn] = getButtons(overlay);
  const focused = [];
  [input, cancelBtn, confirmBtn].forEach(n => { n.focus = () => focused.push(n); });
  pressKey({ key: 'Tab' });
  pressKey({ key: 'Tab', shiftKey: true });
  expect(focused[0]).toBe(input);
  expect(focused[1]).toBe(confirmBtn);
  pressKey({ key: 'Escape' });
  await p;
});

test('多個對話框排隊：同一時間只顯示一個，前一個關閉後才顯示下一個', async () => {
  const p1 = showAlert('第一個');
  const p2 = showAlert('第二個');
  let overlay = getOverlay();
  expect(overlay.querySelector('.app-dialog-message').textContent).toBe('第一個');
  expect(document.querySelectorAll('.app-dialog-overlay').length, '同時只該有一個').toBe(1);
  getButtons(overlay)[0].click();
  await p1;
  overlay = getOverlay();
  expect(overlay.querySelector('.app-dialog-message').textContent, '第一個關掉後換第二個').toBe('第二個');
  getButtons(overlay)[0].click();
  await p2;
  expect(getOverlay()).toBeNull();
});

test('可設定標題：有標題時 aria-labelledby 指向標題、aria-describedby 指向訊息', async () => {
  const p = showAlert('內文', { title: '提示' });
  const overlay = getOverlay();
  const card = overlay.querySelector('.app-dialog-card');
  expect(overlay.querySelector('.app-dialog-title').textContent).toBe('提示');
  expect(card.getAttribute('aria-labelledby')).toBe('appDialogTitle');
  expect(card.getAttribute('aria-describedby')).toBe('appDialogMessage');
  getButtons(overlay)[0].click();
  await p;
});
