'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse a single file into plain text. Supports txt/md/json/csv (natively), pdf, docx.
 */
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (['.txt', '.md', '.markdown', '.json', '.csv', '.log'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(filePath));
      return data.text || '';
    } catch (e) {
      throw new Error(`Failed to parse PDF: ${e.message}`);
    }
  }

  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    } catch (e) {
      throw new Error(`Failed to parse DOCX: ${e.message}`);
    }
  }

  // Fallback: read as plain text
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Chunk long text. Aggregates by paragraph up to ~maxLen characters, keeping an overlap between chunks.
 */
function chunkText(text, maxLen = 900, overlap = 150) {
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\n+/);
  const chunks = [];
  let cur = '';

  const push = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    if (p.length > maxLen) {
      // Paragraph too long: hard-split by sentence/character
      push();
      cur = '';
      for (let i = 0; i < p.length; i += maxLen - overlap) {
        chunks.push(p.slice(i, i + maxLen).trim());
      }
      continue;
    }

    if ((cur + '\n\n' + p).length > maxLen) {
      push();
      // Use the tail of the previous chunk as the overlap, preserving context
      const tail = cur.slice(Math.max(0, cur.length - overlap));
      cur = (tail ? tail + '\n\n' : '') + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  push();
  return chunks.filter(Boolean);
}

module.exports = { parseFile, chunkText };
