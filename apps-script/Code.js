/**
 * ИНТЕРНЕТ-МАГАЗИН на Google Apps Script + Google Таблица + Google Диск
 *
 * Витрина (для покупателей): каталог, категории, поиск, карточка товара, корзина, оформление заказа.
 * Панель продавца (адрес сайта + ?admin=1, вход по паролю): товары с фото, цены, категории, заказы.
 * Пароль задаётся в свойстве скрипта ADMIN_PASSWORD (Настройки проекта → Свойства скрипта).
 *
 * В таблице:
 *   «Товары»     — одна строка на товар (миниатюра фото, цена, старая цена, «На витрине» и т. д.)
 *   «Категории»  — список категорий (порядок = порядок на сайте)
 *   «Заказы»     — заказы покупателей со статусом
 * Фото хранятся в папке на Google Диске рядом с таблицей.
 */

const CONFIG = {
  SHOP_NAME: 'Рахш',                        // название магазина в шапке сайта
  SHOP_TAGLINE: 'Доставка и самовывоз',     // подпись под названием (можно пустую)
  CURRENCY: '₽',
  MAX_PHOTOS: 10,
  NOTIFY_EMAIL: '',                         // куда слать письма о заказах; пусто — на почту владельца
  DELIVERY_OPTIONS: ['Доставка курьером', 'Самовывоз'],
  PRODUCTS_SHEET: 'Товары',
  CATEGORIES_SHEET: 'Категории',
  ORDERS_SHEET: 'Заказы',
  PHOTO_FOLDER_NAME: 'Фото товаров',
  ORDER_STATUSES: ['Новый', 'В работе', 'Отправлен', 'Выполнен', 'Отменён'],
  DEFAULT_CATEGORIES: [
    'Одежда', 'Обувь', 'Аксессуары', 'Для дома', 'Электроника',
    'Красота и здоровье', 'Детские товары', 'Другое',
  ],
};

const HEADERS = ['ID', 'Добавлен', 'Фото', 'Название', 'Категория', 'Цена', 'Старая цена', 'Артикул', 'Описание', 'На витрине', 'Ссылки на фото', 'ID файлов'];
const COL = { ID: 1, DATE: 2, PHOTO: 3, NAME: 4, CATEGORY: 5, PRICE: 6, OLD_PRICE: 7, SKU: 8, DESC: 9, VISIBLE: 10, URLS: 11, FILE_IDS: 12 };
const TEXT_COLS = [COL.NAME, COL.CATEGORY, COL.SKU, COL.DESC];

const ORDER_HEADERS = ['Номер', 'Дата', 'Статус', 'Имя', 'Телефон', 'Получение', 'Адрес', 'Комментарий', 'Состав заказа', 'Товаров, шт', 'Сумма'];
const OCOL = { NUM: 1, DATE: 2, STATUS: 3, NAME: 4, PHONE: 5, DELIVERY: 6, ADDRESS: 7, COMMENT: 8, ITEMS: 9, QTY: 10, TOTAL: 11 };

/* ───────────── Сайт ───────────── */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(CONFIG.SHOP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Пароль панели продавца хранится в свойствах скрипта, а не в коде: Настройки проекта → Свойства скрипта → ADMIN_PASSWORD. */
function adminPassword_() {
  return String(PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || '');
}

/** Единая точка входа для страницы (google.script.run.api). */
function api(action, payload, key) {
  payload = payload || {};
  switch (action) {
    // для покупателей
    case 'shop':  return shop_();
    case 'order': return placeOrder_(payload);
  }
  // дальше — только для продавца
  const password = adminPassword_();
  if (!password) throw new Error('Задайте свойство скрипта ADMIN_PASSWORD (Настройки проекта → Свойства скрипта)');
  if (String(key || '') !== password) throw new Error('AUTH_REQUIRED');
  switch (action) {
    case 'admin':          return admin_();
    case 'uploadPhoto':    return uploadPhoto_(payload);
    case 'trashPhotos':    return trashPhotos_(payload.ids);
    case 'saveProduct':    return withLock_(() => saveProduct_(payload));
    case 'deleteProduct':  return withLock_(() => deleteProduct_(payload.id));
    case 'setOrderStatus': return withLock_(() => setOrderStatus_(payload.number, payload.status));
    default: throw new Error('Неизвестное действие: ' + action);
  }
}

/* ───────────── Меню в таблице ───────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🛍 Магазин')
    .addItem('Открыть магазин и панель продавца', 'showSiteLink')
    .addItem('Первичная настройка', 'setup')
    .addToUi();
}

function showSiteLink() {
  const url = ScriptApp.getService().getUrl();
  const html = url
    ? '<div style="font-family:sans-serif;font-size:14px"><p><a href="' + url + '" target="_blank" style="font-size:16px">Открыть магазин ↗</a></p>' +
      '<p><a href="' + url + '?admin=1" target="_blank" style="font-size:16px">Панель продавца ↗</a></p>' +
      '<p style="word-break:break-all;font-size:12px;color:#666">' + url + '</p></div>'
    : '<div style="font-family:sans-serif"><p>Сайт ещё не опубликован.</p><p style="font-size:13px">Расширения → Apps Script → «Начать развертывание» → «Новое развертывание» → «Веб-приложение».</p></div>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(190), 'Магазин');
}

/** Создаёт листы и папку для фото, запрашивает разрешения. Запустить один раз. */
function setup() {
  const ss = getSs_();
  getProductsSheet_();
  getCategoriesSheet_();
  getOrdersSheet_();
  const folder = getPhotoFolder_();
  ['Лист1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  const msg = 'Готово! Листы «' + CONFIG.PRODUCTS_SHEET + '», «' + CONFIG.CATEGORIES_SHEET + '», «' + CONFIG.ORDERS_SHEET +
    '» созданы, фото — в папке «' + folder.getName() + '». Таблица: ' + ss.getUrl();
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

/* ───────────── Витрина ───────────── */

function shop_() {
  const products = readProducts_().filter(p => p.visible);
  const used = {};
  products.forEach(p => { used[p.category.toLowerCase()] = true; });
  const categories = readCategories_().filter(c => used[c.toLowerCase()]);
  products.forEach(p => { // категории, которых нет на листе «Категории», тоже показываем
    if (!categories.some(c => c.toLowerCase() === p.category.toLowerCase())) categories.push(p.category);
  });
  return { shop: shopInfo_(), categories: categories, products: products };
}

function shopInfo_() {
  return {
    name: CONFIG.SHOP_NAME,
    tagline: CONFIG.SHOP_TAGLINE,
    currency: CONFIG.CURRENCY,
    delivery: CONFIG.DELIVERY_OPTIONS,
  };
}

function placeOrder_(p) {
  if (p.website) return { number: 0, total: 0, items: [] }; // ловушка для ботов
  const name = clean_(p.name).slice(0, 100);
  const phone = clean_(p.phone).slice(0, 40);
  const delivery = CONFIG.DELIVERY_OPTIONS.indexOf(p.delivery) >= 0 ? p.delivery : CONFIG.DELIVERY_OPTIONS[0];
  const address = clean_(p.address, true).slice(0, 500);
  const comment = clean_(p.comment, true).slice(0, 1000);
  if (!name) throw new Error('Укажите имя');
  if (phone.replace(/\D/g, '').length < 7) throw new Error('Укажите телефон');
  if (/курьер|доставк/i.test(delivery) && !address) throw new Error('Укажите адрес доставки');

  const byId = {};
  readProducts_().forEach(x => { byId[x.id] = x; });
  const lines = [];
  let total = 0, qtyTotal = 0;
  (p.items || []).slice(0, 100).forEach(it => {
    const prod = byId[String(it.id)];
    const qty = Math.floor(Number(it.qty));
    if (!prod || !prod.visible || !(qty >= 1)) return;
    const q = Math.min(qty, 99);
    lines.push({ id: prod.id, name: prod.name, sku: prod.sku, price: prod.price, qty: q, sum: prod.price * q });
    total += prod.price * q;
    qtyTotal += q;
  });
  if (!lines.length) throw new Error('Корзина пуста или товары больше не продаются. Обновите страницу.');
  total = Math.round(total * 100) / 100;

  const itemsText = lines.map(l => l.name + (l.sku ? ' [' + l.sku + ']' : '') + ' × ' + l.qty + ' = ' + money_(l.sum)).join('\n');
  const number = withLock_(() => {
    const props = PropertiesService.getScriptProperties();
    const n = Number(props.getProperty('ORDER_SEQ') || 1000) + 1;
    props.setProperty('ORDER_SEQ', String(n));
    const row = [n, new Date(), CONFIG.ORDER_STATUSES[0], name, phone, delivery, address, comment, itemsText, qtyTotal, total];
    getOrdersSheet_().appendRow(row.map((v, i) => typeof v === 'string' && i !== OCOL.STATUS - 1 ? safeText_(v) : v));
    return n;
  });

  notifySeller_(number, { name, phone, delivery, address, comment, itemsText, total });
  return { number: number, total: total, items: lines };
}

function notifySeller_(number, o) {
  try {
    const to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
    if (!to) return;
    const body = [
      'Новый заказ №' + number,
      '',
      o.itemsText,
      '',
      'Итого: ' + money_(o.total),
      '',
      'Имя: ' + o.name,
      'Телефон: ' + o.phone,
      'Получение: ' + o.delivery,
      o.address ? 'Адрес: ' + o.address : '',
      o.comment ? 'Комментарий: ' + o.comment : '',
      '',
      'Все заказы: ' + getSs_().getUrl(),
    ].filter(s => s !== null).join('\n');
    MailApp.sendEmail(to, CONFIG.SHOP_NAME + ': заказ №' + number + ' на ' + money_(o.total), body);
  } catch (e) {
    console.warn('Письмо о заказе не отправлено: ' + e);
  }
}

/* ───────────── Панель продавца ───────────── */

function admin_() {
  return {
    shop: shopInfo_(),
    maxPhotos: CONFIG.MAX_PHOTOS,
    statuses: CONFIG.ORDER_STATUSES,
    categories: readCategories_(),
    products: readProducts_(),
    orders: readOrders_(200),
    sheetUrl: getSs_().getUrl(),
  };
}

function uploadPhoto_(p) {
  const mime = String(p.mimeType || '').toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new Error('Можно загружать только изображения (JPG, PNG, WEBP)');
  if (!p.data) throw new Error('Пустой файл');
  const bytes = Utilities.base64Decode(p.data);
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Фото больше 10 МБ');
  const name = String(p.name || 'photo.jpg').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
  const folder = getPhotoFolder_();
  const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  // Доступ по ссылке (чтобы фото видели покупатели) даём один раз всей папке — файлы его наследуют.
  // Если папке открыть доступ нельзя (ограничение аккаунта), открываем каждый файл отдельно — это медленнее.
  if (!ensureFolderShared_(folder)) {
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      console.warn('Не удалось открыть доступ по ссылке к фото: ' + e);
    }
  }
  return { id: file.getId(), url: photoUrl_(file.getId()) };
}

/** Открывает папке с фото доступ по ссылке (один раз). Возвращает true, если доступ есть. */
function ensureFolderShared_(folder) {
  const props = PropertiesService.getScriptProperties();
  const key = 'PHOTO_FOLDER_SHARED_' + folder.getId();
  const state = props.getProperty(key);
  if (state === 'yes') return true;
  if (state === 'no') return false;
  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    props.setProperty(key, 'yes');
    return true;
  } catch (e) {
    console.warn('Папке с фото нельзя открыть доступ по ссылке: ' + e);
    props.setProperty(key, 'no');
    return false;
  }
}

/** Удаляет в корзину фото, загруженные в форму, но убранные до сохранения. Только из папки с фото. */
function trashPhotos_(ids) {
  const folderId = getPhotoFolder_().getId();
  (ids || []).slice(0, 50).forEach(id => {
    try {
      const f = DriveApp.getFileById(String(id));
      const parents = f.getParents();
      while (parents.hasNext()) {
        if (parents.next().getId() === folderId) { f.setTrashed(true); break; }
      }
    } catch (e) {}
  });
  return { ok: true };
}

function saveProduct_(p) {
  const name = clean_(p.name);
  const price = parsePrice_(p.price);
  const oldPriceRaw = String(p.oldPrice == null ? '' : p.oldPrice).trim();
  const oldPrice = oldPriceRaw === '' ? '' : parsePrice_(oldPriceRaw);
  let category = clean_(p.category);
  if (!name) throw new Error('Укажите название товара');
  if (!category) throw new Error('Выберите категорию');
  if (!isFinite(price) || price < 0) throw new Error('Цена указана неверно');
  if (oldPrice !== '' && (!isFinite(oldPrice) || oldPrice < 0)) throw new Error('Старая цена указана неверно');
  category = ensureCategory_(category);

  const photoIds = (p.photoIds || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, CONFIG.MAX_PHOTOS);
  const urls = photoIds.map(id => photoUrl_(id));
  const sh = getProductsSheet_();

  let row = 0, id, created, oldIds = [];
  if (p.id) {
    row = findRow_(sh, p.id);
    if (!row) throw new Error('Товар не найден — возможно, его удалили из таблицы');
    const cur = sh.getRange(row, 1, 1, HEADERS.length).getValues()[0];
    id = String(cur[COL.ID - 1]);
    created = cur[COL.DATE - 1] || new Date();
    oldIds = splitIds_(cur[COL.FILE_IDS - 1]);
  } else {
    id = newId_();
    created = new Date();
  }

  const record = [
    id,
    created,
    urls.length ? '=IMAGE("' + photoUrl_(photoIds[0], 400) + '")' : '',
    name,
    category,
    price,
    oldPrice === '' || oldPrice <= price ? '' : oldPrice,
    clean_(p.sku),
    clean_(p.description, true),
    p.visible !== false,
    urls.join('\n'),
    photoIds.join(','),
  ];
  const toWrite = record.map((v, i) => TEXT_COLS.indexOf(i + 1) >= 0 ? safeText_(v) : v);

  if (row) {
    sh.getRange(row, 1, 1, toWrite.length).setValues([toWrite]);
  } else {
    sh.appendRow(toWrite);
    row = sh.getLastRow();
  }
  sh.setRowHeight(row, 90);

  oldIds.filter(x => photoIds.indexOf(x) === -1).forEach(trashFile_); // убранные фото — в корзину Диска
  return rowToProduct_(record);
}

function deleteProduct_(id) {
  const sh = getProductsSheet_();
  const row = findRow_(sh, id);
  if (!row) return { ok: true };
  const ids = splitIds_(sh.getRange(row, COL.FILE_IDS).getValue());
  if (sh.getMaxRows() <= sh.getFrozenRows() + 1) {
    sh.getRange(row, 1, 1, HEADERS.length).clearContent();
  } else {
    sh.deleteRow(row);
  }
  ids.forEach(trashFile_);
  return { ok: true };
}

function setOrderStatus_(number, status) {
  if (CONFIG.ORDER_STATUSES.indexOf(status) < 0) throw new Error('Неизвестный статус');
  const sh = getOrdersSheet_();
  const last = sh.getLastRow();
  if (last < 2) throw new Error('Заказ не найден');
  const nums = sh.getRange(2, OCOL.NUM, last - 1, 1).getDisplayValues();
  for (let i = 0; i < nums.length; i++) {
    if (String(nums[i][0]).trim() === String(number)) {
      sh.getRange(i + 2, OCOL.STATUS).setValue(status);
      return { ok: true };
    }
  }
  throw new Error('Заказ не найден');
}

/* ───────────── Чтение ───────────── */

function readProducts_() {
  const sh = getProductsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .filter(r => String(r[COL.ID - 1]).trim() && String(r[COL.NAME - 1]).trim())
    .map(rowToProduct_)
    .reverse(); // новые сверху
}

function rowToProduct_(r) {
  const d = r[COL.DATE - 1];
  const old = parsePrice_(r[COL.OLD_PRICE - 1]);
  const vis = r[COL.VISIBLE - 1];
  return {
    id: String(r[COL.ID - 1]),
    date: d instanceof Date ? d.toISOString() : String(d || ''),
    name: String(r[COL.NAME - 1] || ''),
    category: String(r[COL.CATEGORY - 1] || '').trim() || 'Другое',
    price: parsePrice_(r[COL.PRICE - 1]) || 0,
    oldPrice: isFinite(old) && old > 0 ? old : 0,
    sku: String(r[COL.SKU - 1] || ''),
    description: String(r[COL.DESC - 1] || ''),
    visible: !(vis === false || /^(false|нет|no|0)$/i.test(String(vis).trim())),
    photos: splitIds_(r[COL.FILE_IDS - 1]).map(id => ({ id: id, url: photoUrl_(id) })),
  };
}

function readOrders_(limit) {
  const sh = getOrdersSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const from = Math.max(2, last - limit + 1);
  return sh.getRange(from, 1, last - from + 1, ORDER_HEADERS.length).getValues()
    .filter(r => String(r[OCOL.NUM - 1]).trim())
    .map(r => {
      const d = r[OCOL.DATE - 1];
      return {
        number: String(r[OCOL.NUM - 1]),
        date: d instanceof Date ? d.toISOString() : String(d || ''),
        status: String(r[OCOL.STATUS - 1] || ''),
        name: String(r[OCOL.NAME - 1] || ''),
        phone: String(r[OCOL.PHONE - 1] || ''),
        delivery: String(r[OCOL.DELIVERY - 1] || ''),
        address: String(r[OCOL.ADDRESS - 1] || ''),
        comment: String(r[OCOL.COMMENT - 1] || ''),
        items: String(r[OCOL.ITEMS - 1] || ''),
        qty: Number(r[OCOL.QTY - 1]) || 0,
        total: parsePrice_(r[OCOL.TOTAL - 1]) || 0,
      };
    })
    .reverse();
}

function readCategories_() {
  const sh = getCategoriesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const seen = {};
  const out = [];
  sh.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(r => {
    const c = String(r[0]).trim();
    if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = true; out.push(c); }
  });
  return out;
}

/** Возвращает категорию как в таблице; новую — добавляет на лист «Категории». */
function ensureCategory_(name) {
  const found = readCategories_().filter(c => c.toLowerCase() === name.toLowerCase())[0];
  if (found) return found;
  name = name.charAt(0).toUpperCase() + name.slice(1);
  getCategoriesSheet_().appendRow([safeText_(name)]);
  return name;
}

/* ───────────── Листы и папка ───────────── */

function getSs_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (ss) {
    if (props.getProperty('SPREADSHEET_ID') !== ss.getId()) props.setProperty('SPREADSHEET_ID', ss.getId());
    return ss;
  }
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const created = SpreadsheetApp.create(CONFIG.SHOP_NAME + ' — товары и заказы'); // проект не привязан к таблице
  props.setProperty('SPREADSHEET_ID', created.getId());
  return created;
}

function styleHeader_(range) {
  range.setFontWeight('bold').setBackground('#e7efe9');
}

function getProductsSheet_() {
  const ss = getSs_();
  let sh = ss.getSheetByName(CONFIG.PRODUCTS_SHEET);
  if (!sh) sh = ss.insertSheet(CONFIG.PRODUCTS_SHEET, 0);
  if (sh.getLastRow() === 0) {
    styleHeader_(sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]));
    sh.setFrozenRows(1);
    sh.getRange('B2:B').setNumberFormat('dd.mm.yyyy hh:mm');
    sh.getRange('F2:G').setNumberFormat('#,##0.00');
    sh.getRange('I2:I').setWrap(true);
    sh.getRange('K2:K').setWrap(true);
    sh.getRange('J2:J').insertCheckboxes();
    sh.getRange('A:L').setVerticalAlignment('middle');
    [90, 125, 100, 220, 150, 100, 100, 110, 280, 90, 220, 80].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(getCategoriesSheet_().getRange('A2:A'), true)
      .setAllowInvalid(true)
      .build();
    sh.getRange('E2:E').setDataValidation(rule);
    sh.hideColumns(COL.FILE_IDS);
  }
  return sh;
}

function getCategoriesSheet_() {
  const ss = getSs_();
  let sh = ss.getSheetByName(CONFIG.CATEGORIES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.CATEGORIES_SHEET);
    styleHeader_(sh.getRange(1, 1).setValue('Категория'));
    sh.getRange(2, 1, CONFIG.DEFAULT_CATEGORIES.length, 1).setValues(CONFIG.DEFAULT_CATEGORIES.map(c => [c]));
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 240);
  }
  return sh;
}

function getOrdersSheet_() {
  const ss = getSs_();
  let sh = ss.getSheetByName(CONFIG.ORDERS_SHEET);
  if (!sh) sh = ss.insertSheet(CONFIG.ORDERS_SHEET, 1);
  if (sh.getLastRow() === 0) {
    styleHeader_(sh.getRange(1, 1, 1, ORDER_HEADERS.length).setValues([ORDER_HEADERS]));
    sh.setFrozenRows(1);
    sh.getRange('B2:B').setNumberFormat('dd.mm.yyyy hh:mm');
    sh.getRange('K2:K').setNumberFormat('#,##0.00');
    sh.getRange('G2:I').setWrap(true);
    sh.getRange('A:K').setVerticalAlignment('top');
    [70, 125, 100, 150, 130, 140, 220, 200, 320, 90, 100].forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.getRange('C2:C').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.ORDER_STATUSES, true).setAllowInvalid(true).build());
  }
  return sh;
}

function getPhotoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const fid = props.getProperty('PHOTO_FOLDER_ID');
  if (fid) {
    try {
      const f = DriveApp.getFolderById(fid);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }
  const ss = getSs_();
  const folder = DriveApp.createFolder(CONFIG.PHOTO_FOLDER_NAME + ' — ' + ss.getName());
  try {
    const parents = DriveApp.getFileById(ss.getId()).getParents();
    if (parents.hasNext()) folder.moveTo(parents.next()); // рядом с таблицей
  } catch (e) {}
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

/* ───────────── Помощники ───────────── */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Сервер занят, попробуйте ещё раз');
  try { return fn(); } finally { lock.releaseLock(); }
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2 || !id) return 0;
  const ids = sh.getRange(2, COL.ID, last - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(id).trim()) return i + 2;
  }
  return 0;
}

function photoUrl_(id, size) {
  return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w' + (size || 1000);
}

function trashFile_(id) {
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
}

function splitIds_(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parsePrice_(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[\s ]/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
}

function money_(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const parts = v.toFixed(Number.isInteger(v) ? 0 : 2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return parts.join(',') + ' ' + CONFIG.CURRENCY;
}

function clean_(v, multiline) {
  let s = String(v == null ? '' : v);
  s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, multiline ? 5000 : 300);
}

/** Не даём тексту стать формулой в таблице. */
function safeText_(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function newId_() {
  return 'T-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 36 * 36).toString(36).toUpperCase();
}
