'use strict'

const { rgb, StandardFonts } = require('pdf-lib')

// ── Design tokens ────────────────────────────────────────────────────────────
// Left accent bar: solid amber strip
const ACCENT_COLOR = rgb(0.96, 0.62, 0.08)
const ACCENT_BAR_W = 4

// Soft fill: pale lemon at low opacity — shows through the page content
const FILL_COLOR = rgb(1.0, 0.95, 0.70)
const FILL_OPACITY = 0.45

// Main sticker pill
const STICKER_BG = rgb(0.20, 0.13, 0.01)   // near-black amber tint
const STICKER_FG = rgb(1, 1, 1)
const STICKER_FONT_SIZE = 7.5
const STICKER_PAD_X = 5
const STICKER_PAD_Y = 2.5
const STICKER_H = STICKER_FONT_SIZE + STICKER_PAD_Y * 2

// Sub-part tag pills (drawn right after the main pill)
const TAG_BG = rgb(0.94, 0.80, 0.40)       // lighter amber
const TAG_FG = rgb(0.12, 0.07, 0.00)       // dark text for contrast
const TAG_FONT_SIZE = 6.5
const TAG_PAD_X = 3.5
const TAG_PAD_Y = 2
const TAG_H = TAG_FONT_SIZE + TAG_PAD_Y * 2
const TAG_GAP = 2   // horizontal gap between pills

// Vertical layout: pale strip sits in the margin above the question number; topic
// pills are vertically centred inside that strip (same band as the soft fill).
// pdf-lib y increases upward; qNRect top = topInPdf.
const GAP_QUESTION_TO_STRIP = 3      // space between qNRect top and bottom of pale strip
const MIN_BAND_PAD_PILLS = 3         // min clear space above/below pill row inside the strip
const TOP_PAGE_SAFE = 10             // min distance from physical top of page to pill tops
const FALLBACK_PILL_FROM_TOP = 22    // used when qNRect is missing

// sspdf uses top-left origin (y increases downward).
// pdf-lib uses bottom-left origin (y increases upward).
function toPdfLibY (sspdfY, pageHeight) {
  return pageHeight - sspdfY
}

async function getFont (sourceMeta) {
  if (!sourceMeta.fontCache.bold) {
    sourceMeta.fontCache.bold = await sourceMeta.out.embedFont(StandardFonts.HelveticaBold)
  }
  if (!sourceMeta.fontCache.regular) {
    sourceMeta.fontCache.regular = await sourceMeta.out.embedFont(StandardFonts.Helvetica)
  }
  return { bold: sourceMeta.fontCache.bold, regular: sourceMeta.fontCache.regular }
}

function buildLabel (match) {
  const qPart = `Q${match.qN}`
  if (!match.matchedTopics || match.matchedTopics.length === 0) return qPart
  const topic = match.matchedTopics[0]
  const truncated = topic.length > 28 ? topic.substring(0, 26) + '\u2026' : topic
  return `${qPart}  ${truncated}`
}

// Draw the main label pill. Returns the x coordinate just after it.
function drawMainPill (pdfPage, font, label, x, yCentre) {
  const labelW = font.widthOfTextAtSize(label, STICKER_FONT_SIZE)
  const pillW = labelW + STICKER_PAD_X * 2
  const pillY = yCentre - STICKER_H / 2

  pdfPage.drawRectangle({ x, y: pillY, width: pillW, height: STICKER_H, color: STICKER_BG })
  pdfPage.drawText(label, { x: x + STICKER_PAD_X, y: pillY + STICKER_PAD_Y, size: STICKER_FONT_SIZE, font, color: STICKER_FG })
  return x + pillW
}

// Draw one or more "(a)", "(b)" tag pills starting at x. Returns the x after the last pill.
function drawSubpartTags (pdfPage, font, subparts, x, yCentre) {
  if (!subparts || subparts.length === 0) return x
  let curX = x + TAG_GAP
  for (const part of subparts) {
    // Normalise: if part already has parens keep as-is, otherwise wrap
    const label = /^\(/.test(part) ? part : `(${part})`
    const labelW = font.widthOfTextAtSize(label, TAG_FONT_SIZE)
    const tagW = labelW + TAG_PAD_X * 2
    const tagY = yCentre - TAG_H / 2

    pdfPage.drawRectangle({ x: curX, y: tagY, width: tagW, height: TAG_H, color: TAG_BG })
    pdfPage.drawText(label, { x: curX + TAG_PAD_X, y: tagY + TAG_PAD_Y, size: TAG_FONT_SIZE, font, color: TAG_FG })
    curX += tagW + TAG_GAP
  }
  return curX
}

function pillRowHeight (hasSubparts) {
  return hasSubparts ? Math.max(STICKER_H, TAG_H) : STICKER_H
}

// Renderer interface: render({ pdfPage, matches, pageHeight, sourceMeta })
// sourceMeta = { fontCache, out }
async function render ({ pdfPage, matches, pageHeight, sourceMeta }) {
  const pageWidth = pdfPage.getWidth()
  const { bold, regular } = await getFont(sourceMeta)

  for (const match of matches) {
    if (!match.qNRect) {
      if (!match.isQNStartPage) {
        // Continuation page — thin accent bar running the full left edge.
        pdfPage.drawRectangle({ x: 0, y: 0, width: ACCENT_BAR_W, height: pageHeight, color: ACCENT_COLOR })
      } else {
        // Start page but no qNRect in dir — fallback pill near the top.
        const label = buildLabel(match)
        const ph = pillRowHeight((match.matchedSubparts && match.matchedSubparts.length > 0))
        const yCentre = pageHeight - FALLBACK_PILL_FROM_TOP - ph / 2
        const afterMain = drawMainPill(pdfPage, bold, label, ACCENT_BAR_W + 2, yCentre)
        drawSubpartTags(pdfPage, regular, match.matchedSubparts, afterMain, yCentre)
      }
      continue
    }

    const r = match.qNRect
    const topInPdf = toPdfLibY(r.y1, pageHeight)
    const bottomInPdf = toPdfLibY(r.y2, pageHeight)
    const bandH0 = topInPdf - bottomInPdf  // positive when y1 < y2 in sspdf
    if (!Number.isFinite(bandH0) || bandH0 === 0) continue

    const BAND_PAD = 4
    const hasSubs = match.matchedSubparts && match.matchedSubparts.length > 0
    const rowH = pillRowHeight(hasSubs)
    const minBandForPills = rowH + MIN_BAND_PAD_PILLS * 2
    let effBandH = Math.max(bandH0 + BAND_PAD * 2, minBandForPills)
    if (!Number.isFinite(effBandH) || effBandH <= 0) continue

    const minBandBottom = topInPdf + GAP_QUESTION_TO_STRIP
    const bandY = minBandBottom
    const maxTop = pageHeight - TOP_PAGE_SAFE

    let pillCentre = bandY + effBandH / 2

    if (pillCentre + rowH / 2 > maxTop) {
      const pillTopLimit = maxTop
      pillCentre = pillTopLimit - rowH / 2
      const bandTopNeeded = pillCentre + rowH / 2
      effBandH = Math.max(6, Math.max(minBandForPills, bandTopNeeded - bandY))
      pillCentre = bandY + effBandH / 2
      if (pillCentre + rowH / 2 > maxTop) {
        pillCentre = maxTop - rowH / 2
      }
    }

    drawStripAndLabels(pdfPage, pageWidth, bold, regular, match, bandY, effBandH, pillCentre)
  }
}

function drawStripAndLabels (pdfPage, pageWidth, bold, regular, match, bandY, bandH, pillCentreY) {
  pdfPage.drawRectangle({ x: 0, y: bandY, width: ACCENT_BAR_W, height: bandH, color: ACCENT_COLOR })
  pdfPage.drawRectangle({
    x: ACCENT_BAR_W, y: bandY,
    width: pageWidth - ACCENT_BAR_W, height: bandH,
    color: FILL_COLOR, opacity: FILL_OPACITY
  })
  const label = buildLabel(match)
  const afterMain = drawMainPill(pdfPage, bold, label, ACCENT_BAR_W + 3, pillCentreY)
  drawSubpartTags(pdfPage, regular, match.matchedSubparts, afterMain, pillCentreY)
}

module.exports = { render }
