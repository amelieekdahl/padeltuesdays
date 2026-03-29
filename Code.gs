// ============================================================
// Google Apps Script — Padel Tuesdays Backend
// Deploy as Web App (Execute as: Me, Access: Anyone)
//
// This extends the existing tournament data API to also handle
// a shared photo gallery stored as base64 in a "Gallery" sheet.
// ============================================================

// ---------- Sheet helpers ----------

const SHEET_ID = "1v5zGJRVzqFCdwrJNaqV3HXQAcFV99qgEzaIu2Of9Gds";

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

// ---------- Gallery helpers ----------

const GALLERY_SHEET = 'Gallery';
// Columns: A=id, B=caption, C=date, D=filename, E=data (base64)

function getGallerySheet() {
  const sheet = getOrCreateSheet(GALLERY_SHEET);
  // Add headers if row 1 is empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['id', 'caption', 'date', 'filename', 'data']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  return sheet;
}

function getAllPhotos() {
  const sheet = getGallerySheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return []; // only headers
  const rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  return rows
    .filter(r => r[0]) // skip blank rows
    .map(r => ({
      id: String(r[0]),
      caption: r[1] || '',
      date: r[2] || '',
      filename: r[3] || '',
      data: r[4] || ''
    }));
}

function addPhoto(photo) {
  const sheet = getGallerySheet();
  sheet.appendRow([
    photo.id || '',
    photo.caption || '',
    photo.date || '',
    photo.filename || '',
    photo.data || ''
  ]);
}

function updatePhotoCaption(photoId, newCaption) {
  const sheet = getGallerySheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(photoId)) {
      sheet.getRange(i + 2, 2).setValue(newCaption);
      return true;
    }
  }
  return false;
}

function deletePhoto(photoId) {
  const sheet = getGallerySheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(photoId)) {
      sheet.deleteRow(i + 2);
      return true;
    }
  }
  return false;
}

// ---------- Main API handlers ----------

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'getData';

  if (action === 'getGallery') {
    // withData=true returns full base64; otherwise just metadata (fast)
    const withData = e.parameter.withData === 'true';
    const photos = getAllPhotos();
    const result = withData
      ? photos
      : photos.map(p => ({ id: p.id, caption: p.caption, date: p.date, filename: p.filename }));
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'getPhoto') {
    // Return a single photo including base64 data
    const photoId = e.parameter.id;
    const photos = getAllPhotos();
    const photo = photos.find(p => p.id === photoId);
    if (photo) {
      return ContentService.createTextOutput(JSON.stringify(photo))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ error: 'not found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Default: return tournament data (existing behaviour)
  const sheet = getOrCreateSheet('Data');
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    return ContentService.createTextOutput('{}')
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  // Check if data is chunked across multiple cells
  let raw = '';
  if (lastRow >= 2) {
    const meta = sheet.getRange(2, 1).getValue();
    if (typeof meta === 'string' && meta.startsWith('chunks:')) {
      const numChunks = parseInt(meta.split(':')[1]);
      const chunks = sheet.getRange(1, 1, 1, numChunks).getValues()[0];
      raw = chunks.join('');
    } else {
      raw = sheet.getRange(1, 1).getValue();
    }
  } else {
    raw = sheet.getRange(1, 1).getValue();
  }
  
  return ContentService.createTextOutput(raw)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = e.postData ? e.postData.contents : '';

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const action = payload.action || 'saveData';

  // --- Gallery actions ---

  if (action === 'addPhoto') {
    addPhoto(payload.photo);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'updateCaption') {
    const success = updatePhotoCaption(payload.id, payload.caption);
    return ContentService.createTextOutput(JSON.stringify({ ok: success }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'deletePhoto') {
    const success = deletePhoto(payload.id);
    return ContentService.createTextOutput(JSON.stringify({ ok: success }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // --- Default: save tournament data (existing behaviour) ---
  // Google Sheets has a 50,000 character cell limit.
  // If data is too large for one cell, split across multiple cells.
  const sheet = getOrCreateSheet('Data');
  sheet.clear();
  
  // Split body into 40KB chunks to stay within cell limits
  const CHUNK_SIZE = 40000;
  if (body.length <= CHUNK_SIZE) {
    sheet.getRange(1, 1).setValue(body);
  } else {
    const chunks = [];
    for (let i = 0; i < body.length; i += CHUNK_SIZE) {
      chunks.push(body.substring(i, i + CHUNK_SIZE));
    }
    for (let i = 0; i < chunks.length; i++) {
      sheet.getRange(1, i + 1).setValue(chunks[i]);
    }
    // Mark how many chunks in a metadata row
    sheet.getRange(2, 1).setValue('chunks:' + chunks.length);
  }
  
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
